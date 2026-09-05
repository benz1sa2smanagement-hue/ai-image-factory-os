/**
 * Cryptographic Verification for External ChatGPT QA Approval Artifacts.
 *
 * Enforces an Ed25519 signature trust boundary for unattended Phase C execution.
 *
 * Architecture:
 *   ChatGPT / Human Operator
 *           ↓
 *   sign canonical approval payload with private key
 *           ↓
 *   external approval artifact (~/.config/antigravity/qa-approval.json)
 *           ↓
 *   Bridge reads artifact
 *           ↓
 *   Bridge verifies signature using immutable embedded public key
 *           ↓
 *   if valid → TASK_APPROVED
 *   if invalid → WAITING_FOR_APPROVAL
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

/**
 * Official embedded Ed25519 public key for ChatGPT / Human Operator.
 * Anchored as immutable repository policy code.
 * Cannot be overridden by CLI flags, env vars, or repository markdown files.
 */
export const CHATGPT_QA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA8WD/dBPhR7tvMmwpfCaVD7tQqtPylMVp1jx2eqJ+a40=
-----END PUBLIC KEY-----`;

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
 * Verifies an Ed25519 digital signature over a canonical approval payload.
 * Uses native Node.js crypto.verify.
 */
export function verifyEd25519Signature(
  canonicalPayload: string,
  signatureBase64: string,
  publicKeyPem: string | crypto.KeyObject = CHATGPT_QA_PUBLIC_KEY_PEM
): SignatureVerificationResult {
  try {
    if (!signatureBase64 || typeof signatureBase64 !== 'string') {
      return { valid: false, reason: 'Missing or non-string signature' };
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
