/**
 * Multi-layer QC — deterministic → heuristics → AI stub (policy-gated, never paid).
 * Structured outcomes: PASS | REJECT | RETRY | ERROR
 */

export type QcLevel = 1 | 2 | 3;
export type QcOutcome = 'PASS' | 'REJECT' | 'RETRY' | 'ERROR';

export interface QcCheckResult {
  level: QcLevel;
  name: string;
  passed: boolean;
  detail?: string;
  score?: number;
  severity?: 'reject' | 'retry' | 'error';
}

export interface QcSummary {
  passed: boolean;
  outcome: QcOutcome;
  reasonCodes: string[];
  checks: QcCheckResult[];
  overallScore: number | null;
}

export interface Level1Meta {
  exists: boolean;
  byteSize: number;
  width?: number;
  height?: number;
  mimeType?: string;
  sha256?: string;
  decodeOk?: boolean;
  decodeErrorCode?: string;
  format?: 'jpeg' | 'png' | 'rgba' | 'unknown';
}

const MIN_BYTES = 1024;
const MAX_BYTES = 15 * 1024 * 1024;
const MIN_DIM = 512;
const MAX_DIM = 4096;

export function level1Checks(meta: Level1Meta): QcCheckResult[] {
  const checks: QcCheckResult[] = [];
  checks.push({
    level: 1, name: 'file_exists', passed: meta.exists,
    detail: meta.exists ? 'ok' : 'missing',
    severity: meta.exists ? undefined : 'reject',
  });
  checks.push({
    level: 1, name: 'min_size', passed: meta.byteSize >= MIN_BYTES,
    detail: `bytes=${meta.byteSize}`,
    severity: meta.byteSize >= MIN_BYTES ? undefined : 'reject',
  });
  checks.push({
    level: 1, name: 'max_size', passed: meta.byteSize <= MAX_BYTES,
    detail: `bytes=${meta.byteSize}`,
    severity: meta.byteSize <= MAX_BYTES ? undefined : 'reject',
  });
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  checks.push({
    level: 1, name: 'min_dimensions', passed: w >= MIN_DIM && h >= MIN_DIM,
    detail: `${w}x${h}`,
    severity: w >= MIN_DIM && h >= MIN_DIM ? undefined : 'reject',
  });
  checks.push({
    level: 1, name: 'max_dimensions', passed: w <= MAX_DIM && h <= MAX_DIM,
    detail: `${w}x${h}`,
    severity: w <= MAX_DIM && h <= MAX_DIM ? undefined : 'reject',
  });
  const mimeOk =
    !meta.mimeType ||
    meta.mimeType === 'image/jpeg' ||
    meta.mimeType === 'image/png' ||
    meta.mimeType === 'image/webp' ||
    meta.mimeType.startsWith('image/');
  checks.push({
    level: 1, name: 'mime_type', passed: mimeOk,
    detail: meta.mimeType ?? 'unknown',
    severity: mimeOk ? undefined : 'reject',
  });
  const formatOk =
    !meta.format || meta.format === 'jpeg' || meta.format === 'png' || meta.format === 'rgba';
  checks.push({
    level: 1, name: 'supported_format', passed: formatOk,
    detail: meta.format ?? 'unknown',
    severity: formatOk ? undefined : 'reject',
  });
  checks.push({
    level: 1, name: 'hash_present',
    passed: Boolean(meta.sha256 && meta.sha256.length >= 32),
    severity: meta.sha256 && meta.sha256.length >= 32 ? undefined : 'retry',
  });
  if (meta.decodeOk === false) {
    checks.push({
      level: 1, name: 'decode_success', passed: false,
      detail: meta.decodeErrorCode ?? 'decode_failed', severity: 'reject',
    });
  } else if (meta.decodeOk === true) {
    checks.push({ level: 1, name: 'decode_success', passed: true, detail: 'ok' });
  }
  return checks;
}

export interface Level2Meta {
  meanLuma?: number;
  nearBlankRatio?: number;
  width?: number;
  height?: number;
  corrupt?: boolean;
}

export function level2Checks(meta: Level2Meta): QcCheckResult[] {
  const checks: QcCheckResult[] = [];
  if (meta.corrupt === true) {
    checks.push({ level: 2, name: 'not_corrupt', passed: false, detail: 'corruption_flag', severity: 'reject' });
  }
  if (typeof meta.meanLuma === 'number') {
    const blank = meta.meanLuma < 5 || meta.meanLuma > 250;
    checks.push({
      level: 2, name: 'not_blank', passed: !blank,
      detail: `meanLuma=${meta.meanLuma}`, score: blank ? 0 : 1,
      severity: blank ? 'reject' : undefined,
    });
  }
  if (typeof meta.nearBlankRatio === 'number') {
    const nearBlank = meta.nearBlankRatio >= 0.98;
    checks.push({
      level: 2, name: 'not_near_blank', passed: !nearBlank,
      detail: `ratio=${meta.nearBlankRatio}`,
      severity: nearBlank ? 'reject' : undefined,
    });
  }
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  if (w > 0 && h > 0) {
    const aspect = w / h;
    const aspectOk = aspect >= 0.2 && aspect <= 5;
    checks.push({
      level: 2, name: 'aspect_ratio', passed: aspectOk,
      detail: `aspect=${aspect.toFixed(3)}`,
      severity: aspectOk ? undefined : 'reject',
    });
  }
  return checks;
}

export interface Level3ContentInput {
  suppliedChecks?: QcCheckResult[];
  skip?: boolean;
}

export function level3ContentChecks(input: Level3ContentInput = {}): QcCheckResult[] {
  if (input.skip !== false && !input.suppliedChecks?.length) {
    return [{ level: 3, name: 'content_qc_skipped', passed: true, detail: 'zero_cost_no_external_vision' }];
  }
  return (input.suppliedChecks ?? []).map((c) => ({ ...c, level: 3 as QcLevel }));
}

export function summarizeQc(checks: QcCheckResult[]): QcSummary {
  const reasonCodes: string[] = [];
  let outcome: QcOutcome = 'PASS';
  // Priority: ERROR > REJECT > RETRY > PASS
  for (const c of checks) {
    if (c.passed) continue;
    reasonCodes.push(c.name);
    const sev = c.severity ?? 'reject';
    if (sev === 'error') outcome = 'ERROR';
    else if (sev === 'reject' && outcome !== 'ERROR') outcome = 'REJECT';
    else if (sev === 'retry' && outcome === 'PASS') outcome = 'RETRY';
  }
  const passed = outcome === 'PASS';
  const scored = checks.filter((c) => typeof c.score === 'number');
  const overallScore =
    scored.length > 0 ? scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length : null;
  return { passed, outcome, reasonCodes, checks, overallScore };
}

export function runQcPipeline(input: {
  level1: Level1Meta;
  level2?: Level2Meta;
  level3?: Level3ContentInput;
}): QcSummary {
  const checks = [
    ...level1Checks(input.level1),
    ...level2Checks(input.level2 ?? {}),
    ...level3ContentChecks(input.level3 ?? { skip: true }),
  ];
  return summarizeQc(checks);
}

export function mayUpload(qcPassed: boolean, factoryAllowsUpload: boolean): boolean {
  if (!qcPassed) return false;
  return factoryAllowsUpload;
}
