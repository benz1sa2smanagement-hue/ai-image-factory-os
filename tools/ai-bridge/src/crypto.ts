/**
 * Cryptographic Verification for External ChatGPT QA Approval Artifacts.
 *
 * Enforces an OS-level protected external trust anchor and Ed25519 signature trust boundary
 * for unattended Phase C execution.
 *
 * Architecture:
 *   ChatGPT / Human Operator
 *           ↓
 *   sign canonical approval payload with private key (outside repo)
 *           ↓
 *   external approval artifact (~/.config/antigravity/qa-approval.json)
 *           ↓
 *   Bridge preflight verifies protected trust anchor
 *   (~/Library/Application Support/AIImageFactory/trust/chatgpt-qa-public-key.pem)
 *   MUST NOT be writable by Developer process (chmod 400 / read-only)
 *           ↓
 *   Bridge verifies signature against protected public key
 *           ↓
 *   if valid → TASK_APPROVED
 *   if invalid → WAITING_FOR_APPROVAL / LOOP_BLOCKED
 *
 * The private signing key MUST NEVER:
 * - exist in the repository
 * - exist in the task workspace
 * - be exposed to Antigravity
 * - be passed to Antigravity
 * - be written to audit logs
 * - be written to environment variables
 * - be bundled into the bridge runtime
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_OPERATOR_TRUST_ANCHOR_FILE } from './constants.ts';
import { isPathInsideWorkspace } from './safety.ts';
import type { SafetyErrorCode } from './types.ts';

export interface ApprovalPayload {
  version: 1;
  status: 'APPROVED';
  approver: 'ChatGPT';
  approvedTaskId: string;
  approvedCommitSha: string;
  approvedAt: string;
}

export interface ExternalApprovalArtifact {
  payload: ApprovalPayload;
  signature: string; // Base64-encoded Ed25519 signature
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: string;
  keyFingerprint?: string;
}

export interface TrustAnchorProtectionResult {
  protected: boolean;
  publicKeyPem?: string;
  keyFingerprint?: string;
  trustAnchorPath: string;
  protectionState: 'PROTECTED' | 'UNPROTECTED' | 'MISSING' | 'INVALID';
  code?: SafetyErrorCode;
  reason?: string;
}

/**
 * Computes a short fingerprint (first 16 hex characters of SHA-256) of a public key PEM.
 */
export function computePublicKeyFingerprint(publicKeyPem: string): string {
  try {
    return crypto.createHash('sha256').update(publicKeyPem.trim()).digest('hex').substring(0, 16);
  } catch {
    return 'unknown';
  }
}

/**
 * Deterministically serializes an approval payload into canonical JSON.
 * Keys are ordered strictly: version, status, approver, approvedTaskId, approvedCommitSha, approvedAt.
 */
export function canonicalizeApprovalPayload(payload: {
  version: number;
  status: string;
  approver: string;
  approvedTaskId: string;
  approvedCommitSha: string;
  approvedAt: string;
}): string {
  return JSON.stringify({
    version: payload.version,
    status: payload.status,
    approver: payload.approver,
    approvedTaskId: payload.approvedTaskId,
    approvedCommitSha: payload.approvedCommitSha,
    approvedAt: payload.approvedAt,
  });
}

/**
 * Validates that an operator trust-anchor public-key file exists, is located outside
 * the repository workspace, is a regular file (not symlink), has valid Ed25519 format,
 * and has restrictive OS permissions preventing the running process/developer from modifying it.
 *
 * If protection cannot be verified: returns protected: false with code TRUST_ANCHOR_NOT_PROTECTED.
 */
export function verifyTrustAnchorProtection(
  trustAnchorPath: string = DEFAULT_OPERATOR_TRUST_ANCHOR_FILE,
  options?: {
    workspaceRoot?: string;
    expectedOperatorUid?: number;
  }
): TrustAnchorProtectionResult {
  const workspace = path.resolve(options?.workspaceRoot || process.cwd());
  const resolvedPath = path.resolve(trustAnchorPath);

  // 1. Workspace boundary check: Trust anchor MUST NOT reside inside repository workspace
  if (isPathInsideWorkspace(resolvedPath, workspace)) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'SELF_AUTHORIZATION_BLOCKED',
      reason: `Trust anchor path (${resolvedPath}) is located inside repository workspace (${workspace}). Trust anchor must reside outside workspace to prevent self-authorization.`,
    };
  }

  // 2. Existence check
  if (!fs.existsSync(resolvedPath)) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'MISSING',
      code: 'TRUST_ANCHOR_MISSING',
      reason: `Protected trust anchor file does not exist at "${resolvedPath}". Operator must provision external trust anchor.`,
    };
  }

  // 3. File type check (must be regular file, not a symlink)
  let lstat: fs.Stats;
  try {
    lstat = fs.lstatSync(resolvedPath);
  } catch (err) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'INVALID',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Failed to inspect trust anchor file attributes: ${(err as Error).message}`,
    };
  }

  if (lstat.isSymbolicLink()) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor path (${resolvedPath}) is a symbolic link. Symbolic links are prohibited to prevent target replacement.`,
    };
  }

  if (!lstat.isFile()) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'INVALID',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor path (${resolvedPath}) is not a regular file.`,
    };
  }

  // 4. Expected operator UID check (if configured)
  if (options?.expectedOperatorUid !== undefined && lstat.uid !== options.expectedOperatorUid) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor file owner UID (${lstat.uid}) does not match expected operator UID (${options.expectedOperatorUid}).`,
    };
  }

  // 5. OS Permissions check:
  // - Must NOT be group writable (mode & 0o020 === 0)
  // - Must NOT be world writable (mode & 0o002 === 0)
  // - Must NOT be writable by the running process/user (mode & 0o222 === 0 or W_OK access denied)
  const mode = lstat.mode & 0o777;

  if ((mode & 0o020) !== 0) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor file is group-writable (mode 0o${mode.toString(8)}). Operator must remove group write permissions.`,
    };
  }

  if ((mode & 0o002) !== 0) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor file is world-writable (mode 0o${mode.toString(8)}). Operator must remove world write permissions.`,
    };
  }

  // Check if current process has write access to the file
  let writableByProcess = false;
  try {
    fs.accessSync(resolvedPath, fs.constants.W_OK);
    writableByProcess = true;
  } catch {
    writableByProcess = false;
  }

  const hasWriteBits = (mode & 0o222) !== 0;

  if (writableByProcess || hasWriteBits) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor file is writable by current process/user (mode 0o${mode.toString(8)}, W_OK=${writableByProcess}). Operator must remove write permissions (e.g. chmod 400 or chmod 444) or assign ownership to an independent operator.`,
    };
  }

  // Check that current process can read the file
  try {
    fs.accessSync(resolvedPath, fs.constants.R_OK);
  } catch (err) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'UNPROTECTED',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Trust anchor file is not readable by current process: ${(err as Error).message}`,
    };
  }

  // Parent directory check: parent directory must not be world-writable
  const parentDir = path.dirname(resolvedPath);
  try {
    const parentStat = fs.statSync(parentDir);
    const parentMode = parentStat.mode & 0o777;
    if ((parentMode & 0o002) !== 0) {
      return {
        protected: false,
        trustAnchorPath: resolvedPath,
        protectionState: 'UNPROTECTED',
        code: 'TRUST_ANCHOR_NOT_PROTECTED',
        reason: `Trust anchor parent directory (${parentDir}) is world-writable (mode 0o${parentMode.toString(8)}).`,
      };
    }
  } catch {
    // Parent directory check best-effort
  }

  // 6. Content validity check: must be a valid Ed25519 public key in PEM format
  let content: string;
  try {
    content = fs.readFileSync(resolvedPath, 'utf8').trim();
  } catch (err) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'INVALID',
      code: 'TRUST_ANCHOR_NOT_PROTECTED',
      reason: `Failed to read trust anchor file: ${(err as Error).message}`,
    };
  }

  if (!content.includes('-----BEGIN PUBLIC KEY-----') || !content.includes('-----END PUBLIC KEY-----')) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'INVALID',
      code: 'TRUST_ANCHOR_INVALID',
      reason: `Trust anchor file does not contain valid PEM public key boundaries.`,
    };
  }

  try {
    const keyObj = crypto.createPublicKey(content);
    if (keyObj.asymmetricKeyType !== 'ed25519') {
      return {
        protected: false,
        trustAnchorPath: resolvedPath,
        protectionState: 'INVALID',
        code: 'TRUST_ANCHOR_INVALID',
        reason: `Trust anchor key algorithm is "${keyObj.asymmetricKeyType}". Only "ed25519" is permitted.`,
      };
    }
  } catch (err) {
    return {
      protected: false,
      trustAnchorPath: resolvedPath,
      protectionState: 'INVALID',
      code: 'TRUST_ANCHOR_INVALID',
      reason: `Trust anchor file is not a valid Ed25519 public key: ${(err as Error).message}`,
    };
  }

  const fingerprint = computePublicKeyFingerprint(content);

  return {
    protected: true,
    publicKeyPem: content,
    keyFingerprint: fingerprint,
    trustAnchorPath: resolvedPath,
    protectionState: 'PROTECTED',
  };
}

/**
 * Production loader for protected external trust anchor.
 * Reads strictly from operator-controlled external location.
 * Rejects repository-local, CLI, or environment overrides.
 */
export function loadProtectedTrustAnchor(options?: {
  trustAnchorPath?: string;
  workspaceRoot?: string;
  expectedOperatorUid?: number;
}): TrustAnchorProtectionResult {
  const targetPath = options?.trustAnchorPath || DEFAULT_OPERATOR_TRUST_ANCHOR_FILE;
  return verifyTrustAnchorProtection(targetPath, options);
}

/**
 * Verifies an Ed25519 digital signature over a canonical approval payload.
 * Requires the public key to be passed explicitly from a protected trust anchor or test verifier.
 */
export function verifyEd25519Signature(
  canonicalPayload: string,
  signatureBase64: string,
  publicKeyPem: string | crypto.KeyObject
): SignatureVerificationResult {
  try {
    if (!signatureBase64 || typeof signatureBase64 !== 'string') {
      return { valid: false, reason: 'Missing or non-string signature' };
    }

    if (!publicKeyPem) {
      return { valid: false, reason: 'Missing public key for verification' };
    }

    let keyObject: crypto.KeyObject;
    let pemStringForFingerprint = '';

    if (typeof publicKeyPem === 'string') {
      pemStringForFingerprint = publicKeyPem;
      keyObject = crypto.createPublicKey({
        key: publicKeyPem,
        format: 'pem',
      });
    } else {
      keyObject = publicKeyPem;
      try {
        pemStringForFingerprint = keyObject.export({ type: 'spki', format: 'pem' }) as string;
      } catch {
        pemStringForFingerprint = 'keyobject';
      }
    }

    if (keyObject.asymmetricKeyType !== 'ed25519') {
      return {
        valid: false,
        reason: `Public key is not an Ed25519 key (got ${keyObject.asymmetricKeyType})`,
      };
    }

    const data = Buffer.from(canonicalPayload, 'utf-8');
    const signature = Buffer.from(signatureBase64, 'base64');

    if (signature.length !== 64) {
      return {
        valid: false,
        reason: `Invalid Ed25519 signature byte length: expected 64, got ${signature.length}`,
      };
    }

    const valid = crypto.verify(null, data, keyObject, signature);
    const keyFingerprint = computePublicKeyFingerprint(pemStringForFingerprint);

    return {
      valid,
      reason: valid ? undefined : 'Ed25519 signature verification failed (cryptographic mismatch)',
      keyFingerprint,
    };
  } catch (err) {
    return {
      valid: false,
      reason: `Cryptographic verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Test & Operator helper: signs a canonical approval payload using an Ed25519 private key.
 * Private keys MUST NOT be checked into git or held by the autonomous bridge runtime.
 */
export function signApprovalPayload(
  payload: ApprovalPayload,
  privateKeyPem: string | crypto.KeyObject
): string {
  const canonical = canonicalizeApprovalPayload(payload);
  const data = Buffer.from(canonical, 'utf-8');
  const signature = crypto.sign(null, data, privateKeyPem);
  return signature.toString('base64');
}

export interface QAApprovalVerifier {
  getTrustAnchor(): {
    publicKeyPem: string;
    keyFingerprint: string;
    protectionState: 'PROTECTED' | 'UNPROTECTED' | 'MISSING' | 'INVALID';
    reason?: string;
    code?: SafetyErrorCode;
  };
}

/**
 * Test-only factory to create a test verifier with an explicit test public key.
 * This is explicitly separated from production execution paths and cannot be
 * reached from production CLI execution, environment variables, or repository files.
 */
export function createTestVerifier(
  testPublicKeyPem: string,
  options?: {
    keyFingerprint?: string;
    protectionState?: 'PROTECTED' | 'UNPROTECTED' | 'MISSING' | 'INVALID';
    reason?: string;
    code?: SafetyErrorCode;
  }
): QAApprovalVerifier {
  const fingerprint = options?.keyFingerprint || computePublicKeyFingerprint(testPublicKeyPem);
  return {
    getTrustAnchor() {
      return {
        publicKeyPem: testPublicKeyPem,
        keyFingerprint: fingerprint,
        protectionState: options?.protectionState || 'PROTECTED',
        reason: options?.reason,
        code: options?.code,
      };
    },
  };
}
