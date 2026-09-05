import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  parseTaskDocument,
  updateTaskStatus,
  parseApprovalSignal,
  discoverNextTask,
  checkExternalQAApproval,
} from '../src/task-parser.ts';
import {
  signApprovalPayload,
  createTestVerifier,
  verifyTrustAnchorProtection,
  type ApprovalPayload,
  type ExternalApprovalArtifact,
} from '../src/crypto.ts';

describe('task-parser', () => {
  const validDoc = `
# AI TASK — ChatGPT → Claude Code

## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** Build Phase B Local Bridge
**SOURCE:** GitHub Issue #6

### Objective
Implement Phase B of the loop.

### Required work
1. Inspect code.
2. Implement bridge in tools/ai-bridge/.
3. Run tests.

### Hard constraints
- MAX_ALLOWED_COST = 0
- ALLOW_PAID_API = false

## QA Gate
Wait for QA.
`;

  it('parses a valid task document successfully', () => {
    const res = parseTaskDocument(validDoc);
    expect(res.ok).toBe(true);
    expect(res.task).toBeDefined();
    expect(res.task?.id).toBe('TASK-002');
    expect(res.task?.status).toBe('READY');
    expect(res.task?.title).toBe('Build Phase B Local Bridge');
    expect(res.task?.source).toBe('GitHub Issue #6');
    expect(res.task?.objective).toBe('Implement Phase B of the loop.');
    expect(res.task?.requiredWork).toHaveLength(3);
    expect(res.task?.hardConstraints).toHaveLength(2);
  });

  it('fails if ## Current Task section is missing', () => {
    const invalidDoc = '# Title\n## Other Section\nNo task here.';
    const res = parseTaskDocument(invalidDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TASK_NOT_FOUND');
  });

  it('fails if no TASK ID is present in ## Current Task', () => {
    const invalidDoc = '## Current Task\n**STATUS:** READY\nNo task id.';
    const res = parseTaskDocument(invalidDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('TASK_NOT_FOUND');
  });

  it('enforces exactly one active task: fails on multiple tasks', () => {
    const multiTaskDoc = `
## Current Task

**TASK ID:** TASK-002
**STATUS:** READY
**TITLE:** First task

**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Second task
`;
    const res = parseTaskDocument(multiTaskDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('MULTIPLE_TASKS_DETECTED');
  });

  it('fails on invalid status string', () => {
    const invalidStatusDoc = `
## Current Task
**TASK ID:** TASK-002
**STATUS:** INVALID_STATUS_STRING
`;
    const res = parseTaskDocument(invalidStatusDoc);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('INVALID_TASK_STATE');
  });

  it('updates task status correctly', () => {
    const updated = updateTaskStatus(validDoc, 'QA_REVIEW');
    expect(updated).toContain('**STATUS:** QA_REVIEW');
    const parsed = parseTaskDocument(updated);
    expect(parsed.ok).toBe(true);
    expect(parsed.task?.status).toBe('QA_REVIEW');
  });

  describe('parseApprovalSignal', () => {
    const fullCommitSha = '526368ebac3f7a94141d3c36e12a7a41ee8fc5f8';
    const otherCommitSha = '0f4e10df5401fe0a641740d935fcbffce3a18455';

    it('parses informational approval metadata but returns approved: false (cryptographic external artifact required)', () => {
      const doc = `
# AI TASK
## Approval Gate
**QA_APPROVAL:** APPROVED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** ${fullCommitSha}
`;
      const signal = parseApprovalSignal(doc, fullCommitSha);
      // Informational metadata is parsed:
      expect(signal.approved).toBe(false);
      expect(signal.approvalStatus).toBe('APPROVED');
      expect(signal.approvedBy).toBe('ChatGPT');
      expect(signal.approvedCommit).toBe(fullCommitSha);
      expect(signal.signatureVerification).toBe('MISSING');
      expect(signal.reason).toContain('informational only');
    });

    it('rejects when QA_APPROVAL marker is missing', () => {
      const doc = '# AI TASK\nNo approval markers here.';
      const signal = parseApprovalSignal(doc, fullCommitSha);
      expect(signal.approved).toBe(false);
      expect(signal.reason).toContain('No **QA_APPROVAL:** marker found');
    });

    it('rejects when QA_APPROVAL is not APPROVED (e.g. REJECTED or PENDING)', () => {
      const doc = `
**QA_APPROVAL:** REJECTED
**QA_APPROVED_BY:** ChatGPT
**QA_APPROVED_COMMIT:** ${fullCommitSha}
`;
      const signal = parseApprovalSignal(doc, fullCommitSha);
      expect(signal.approved).toBe(false);
      expect(signal.approvalStatus).toBe('REJECTED');
    });
  });

  describe('checkExternalQAApproval (Ed25519 Cryptographic Trust Boundary)', () => {
    const fullSha = '526368ebac3f7a94141d3c36e12a7a41ee8fc5f8';
    const testOutsideDir = path.resolve(os.tmpdir(), `ai-bridge-test-ext-${Date.now()}`);
    const testWorkspaceDir = path.resolve(os.tmpdir(), `ai-bridge-test-ws-${Date.now()}`);
    const extApprovalPath = path.resolve(testOutsideDir, 'qa-approval.json');
    const wsApprovalPath = path.resolve(testWorkspaceDir, 'qa-approval.json');

    // Generate real Ed25519 test keypair for cryptographic testing
    const testKeyPair = crypto.generateKeyPairSync('ed25519');
    const otherKeyPair = crypto.generateKeyPairSync('ed25519');
    const testVerifier = createTestVerifier(
      testKeyPair.publicKey.export({ type: 'spki', format: 'pem' }) as string
    );

    function createTestArtifact(
      payloadOverrides: Partial<ApprovalPayload> = {},
      key: crypto.KeyObject = testKeyPair.privateKey
    ): ExternalApprovalArtifact {
      const payload: ApprovalPayload = {
        version: 1,
        status: 'APPROVED',
        approver: 'ChatGPT',
        approvedTaskId: 'TASK-003',
        approvedCommitSha: fullSha,
        approvedAt: new Date().toISOString(),
        ...payloadOverrides,
      };
      const signature = signApprovalPayload(payload, key);
      return { payload, signature };
    }

    it('rejects when external approval record is missing', () => {
      const res = checkExternalQAApproval({
        filePath: path.resolve(testOutsideDir, 'nonexistent.json'),
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('not found');
      expect(res.signatureVerification).toBe('MISSING');
    });

    it('blocks self-authorization if approval file resides inside workspace', async () => {
      await fs.mkdir(testWorkspaceDir, { recursive: true });
      const artifact = createTestArtifact();
      await fs.writeFile(wsApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: wsApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.code).toBe('SELF_AUTHORIZATION_BLOCKED');
      expect(res.reason).toContain('cannot reside inside repository workspace');
      await fs.rm(testWorkspaceDir, { recursive: true, force: true });
    });

    it('rejects malformed or empty external approval file', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      await fs.writeFile(extApprovalPath, '   ', 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('empty');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects un-signed legacy flat approval JSON (signature missing)', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      await fs.writeFile(
        extApprovalPath,
        JSON.stringify({
          taskId: 'TASK-003',
          approvalStatus: 'APPROVED',
          approvedBy: 'ChatGPT',
          approvedCommit: fullSha,
        }),
        'utf-8'
      );

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('missing valid "payload" object');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects when payload has extra ambiguous keys', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      const artifact = createTestArtifact();
      (artifact.payload as any).extraField = 'malicious';
      // Re-sign with extra field to test verifier structure rejection
      artifact.signature = 'fake-sig';
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('extra ambiguous keys');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects when approver is not ChatGPT', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      const artifact = createTestArtifact({ approver: 'DeveloperAgent' as any });
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('Must be authorized by "ChatGPT"');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects when task ID does not match expected completed task', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      const artifact = createTestArtifact({ approvedTaskId: 'TASK-002' });
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('does not match completed task (TASK-003)');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects when commit SHA is short / prefix', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      const artifact = createTestArtifact({ approvedCommitSha: '526368e' });
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.reason).toContain('must be a full 40-character hexadecimal SHA');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects when signature is signed by wrong key (untrusted signer)', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      // Sign with otherKeyPair (not testKeyPair)
      const artifact = createTestArtifact({}, otherKeyPair.privateKey);
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.signatureVerification).toBe('FAILED');
      expect(res.reason).toContain('Cryptographic approval signature verification failed');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('rejects when payload has been tampered with after signing', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      const artifact = createTestArtifact();
      // Tamper with commit SHA without updating signature
      artifact.payload.approvedCommitSha = '0f4e10df5401fe0a641740d935fcbffce3a18455';
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: '0f4e10df5401fe0a641740d935fcbffce3a18455',
        testVerifier,
      });
      expect(res.approved).toBe(false);
      expect(res.signatureVerification).toBe('FAILED');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });

    it('approves when external record has valid Ed25519 signature matching trusted public key', async () => {
      await fs.mkdir(testOutsideDir, { recursive: true });
      const artifact = createTestArtifact();
      await fs.writeFile(extApprovalPath, JSON.stringify(artifact), 'utf-8');

      const res = checkExternalQAApproval({
        filePath: extApprovalPath,
        workspaceDir: testWorkspaceDir,
        expectedTaskId: 'TASK-003',
        expectedCommitSha: fullSha,
        testVerifier,
      });
      expect(res.approved).toBe(true);
      expect(res.approvalStatus).toBe('APPROVED');
      expect(res.approvedTaskId).toBe('TASK-003');
      expect(res.approvedBy).toBe('ChatGPT');
      expect(res.approvedCommit).toBe(fullSha);
      expect(res.signatureVerification).toBe('VALID');
      expect(res.approvalPublicKeyId).toBeDefined();
      expect(res.trustAnchorProtection).toBe('PROTECTED');
      await fs.rm(testOutsideDir, { recursive: true, force: true });
    });
  });

  describe('verifyTrustAnchorProtection', () => {
    const tmpDir = path.resolve(os.tmpdir(), `trust-test-${Date.now()}`);
    const wsDir = path.resolve(os.tmpdir(), `trust-ws-${Date.now()}`);
    const testKey = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }) as string;

    it('blocks trust anchor inside repository workspace', async () => {
      await fs.mkdir(wsDir, { recursive: true });
      const insideFile = path.resolve(wsDir, 'key.pem');
      await fs.writeFile(insideFile, testKey, 'utf-8');
      const res = verifyTrustAnchorProtection(insideFile, { workspaceRoot: wsDir });
      expect(res.protected).toBe(false);
      expect(res.code).toBe('SELF_AUTHORIZATION_BLOCKED');
      await fs.rm(wsDir, { recursive: true, force: true });
    });

    it('rejects missing trust anchor file', () => {
      const res = verifyTrustAnchorProtection(path.resolve(tmpDir, 'missing.pem'), { workspaceRoot: wsDir });
      expect(res.protected).toBe(false);
      expect(res.code).toBe('TRUST_ANCHOR_MISSING');
      expect(res.protectionState).toBe('MISSING');
    });

    it('rejects trust anchor if file is writable by process (mode 0o600 or 0o644)', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      const writableFile = path.resolve(tmpDir, 'writable.pem');
      await fs.writeFile(writableFile, testKey, 'utf-8');
      await fs.chmod(writableFile, 0o600);
      const res = verifyTrustAnchorProtection(writableFile, { workspaceRoot: wsDir });
      expect(res.protected).toBe(false);
      expect(res.code).toBe('TRUST_ANCHOR_NOT_PROTECTED');
      expect(res.protectionState).toBe('UNPROTECTED');
      expect(res.reason).toContain('writable by current process');
      await fs.chmod(writableFile, 0o600);
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('rejects malformed trust anchor (not Ed25519)', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      const badFile = path.resolve(tmpDir, 'bad.pem');
      await fs.writeFile(badFile, '--- NOT A KEY ---', 'utf-8');
      await fs.chmod(badFile, 0o400);
      const res = verifyTrustAnchorProtection(badFile, { workspaceRoot: wsDir });
      expect(res.protected).toBe(false);
      expect(res.code).toBe('TRUST_ANCHOR_INVALID');
      expect(res.protectionState).toBe('INVALID');
      await fs.chmod(badFile, 0o600);
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('accepts protected read-only Ed25519 trust anchor outside workspace', async () => {
      await fs.mkdir(tmpDir, { recursive: true });
      const validFile = path.resolve(tmpDir, 'valid.pem');
      await fs.writeFile(validFile, testKey, 'utf-8');
      await fs.chmod(validFile, 0o400);
      const res = verifyTrustAnchorProtection(validFile, { workspaceRoot: wsDir });
      expect(res.protected).toBe(true);
      expect(res.protectionState).toBe('PROTECTED');
      expect(res.publicKeyPem).toBe(testKey.trim());
      expect(res.keyFingerprint).toBeDefined();
      await fs.chmod(validFile, 0o600);
      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe('discoverNextTask', () => {
    it('discovers next explicit task when ID is new and status is READY', () => {
      const nextDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** READY
**TITLE:** Open Phase C Autonomous Task Loop
`;
      const discovery = discoverNextTask(nextDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(true);
      expect(discovery.task?.id).toBe('TASK-003');
    });

    it('refuses to discover next task if document still has completed task ID not re-issued', () => {
      const sameTaskDoc = `
## Current Task
**TASK ID:** TASK-002
**STATUS:** QA_REVIEW
**TITLE:** Build Phase B Local Bridge
`;
      const discovery = discoverNextTask(sameTaskDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(false);
    });

    it('refuses to discover next task if task status is not READY', () => {
      const notReadyDoc = `
## Current Task
**TASK ID:** TASK-003
**STATUS:** HOLD
**TITLE:** Next task on hold
`;
      const discovery = discoverNextTask(notReadyDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(false);
      expect(discovery.reason).toContain('not READY');
    });

    it('does not invent task IDs or objectives', () => {
      const emptyDoc = '## Current Task\nNothing here';
      const discovery = discoverNextTask(emptyDoc, 'TASK-002');
      expect(discovery.hasNext).toBe(false);
      expect(discovery.task).toBeUndefined();
    });
  });
});
