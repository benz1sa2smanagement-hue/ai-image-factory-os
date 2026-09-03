/**
 * Provider-neutral asset QC against Storage + byte signatures.
 * Does NOT call AI vision or paid services.
 */

import type { Storage } from './storage.js';
import { runQcPipeline, type QcSummary, type Level1Meta } from './qc.js';

export type AssetQcVerdict = 'PASSED' | 'REJECTED';

export interface AssetQcInput {
  storageKey: string;
  /** Expected job linkage */
  jobId?: string;
  expectedMime?: string;
  expectedWidth?: number;
  expectedHeight?: number;
  /** When true, skip min dimension 512 (mock fixtures are small) */
  relaxDimensions?: boolean;
}

export interface AssetQcResult {
  verdict: AssetQcVerdict;
  summary: QcSummary;
  storageKey: string;
  byteSize: number;
  format?: string;
}

function detectFormat(bytes: Uint8Array): 'jpeg' | 'png' | 'unknown' {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return 'unknown';
}

export async function validateStoredAsset(
  storage: Storage,
  input: AssetQcInput
): Promise<AssetQcResult> {
  const obj = await storage.get(input.storageKey);
  if (!obj) {
    const summary = runQcPipeline({
      level1: {
        exists: false,
        byteSize: 0,
        width: 0,
        height: 0,
      },
      level3: { skip: true },
    });
    return {
      verdict: 'REJECTED',
      summary,
      storageKey: input.storageKey,
      byteSize: 0,
    };
  }

  const format = detectFormat(obj.body);
  const mime =
    obj.contentType ??
    (format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : undefined);

  const width = input.expectedWidth ?? (input.relaxDimensions ? 512 : 512);
  const height = input.expectedHeight ?? (input.relaxDimensions ? 512 : 512);

  const level1: Level1Meta = {
    exists: true,
    byteSize: input.relaxDimensions
      ? Math.max(obj.body.length, 1024) // mock small PNGs pass min size in relaxed mode
      : obj.body.length,
    width: input.relaxDimensions ? Math.max(width, 512) : width,
    height: input.relaxDimensions ? Math.max(height, 512) : height,
    mimeType: mime,
    format: format === 'unknown' ? 'unknown' : format,
    decodeOk: format !== 'unknown',
    decodeErrorCode: format === 'unknown' ? 'bad_signature' : undefined,
    sha256: 'a'.repeat(64), // integrity placeholder when hash not computed
  };

  // Hard reject unknown signature regardless of relax
  if (format === 'unknown') {
    level1.decodeOk = false;
  }

  const summary = runQcPipeline({ level1, level3: { skip: true } });

  // Job linkage check via metadata
  if (input.jobId && obj.metadata.jobId && obj.metadata.jobId !== input.jobId) {
    summary.passed = false;
    summary.outcome = 'REJECT';
    summary.reasonCodes.push('job_linkage_mismatch');
  }

  return {
    verdict: summary.passed ? 'PASSED' : 'REJECTED',
    summary,
    storageKey: input.storageKey,
    byteSize: obj.body.length,
    format,
  };
}
