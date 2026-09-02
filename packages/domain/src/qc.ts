/** Multi-layer QC — deterministic → CV heuristics → AI (policy-gated) */

export type QcLevel = 1 | 2 | 3;

export interface QcCheckResult {
  level: QcLevel;
  name: string;
  passed: boolean;
  detail?: string;
  score?: number;
}

export interface QcSummary {
  passed: boolean;
  checks: QcCheckResult[];
  overallScore: number | null;
}

/** Level 1: deterministic file/integrity checks (no AI) */
export function level1Checks(meta: {
  exists: boolean;
  byteSize: number;
  width?: number;
  height?: number;
  mimeType?: string;
  sha256?: string;
}): QcCheckResult[] {
  const checks: QcCheckResult[] = [];
  checks.push({
    level: 1,
    name: 'file_exists',
    passed: meta.exists,
    detail: meta.exists ? 'ok' : 'missing',
  });
  checks.push({
    level: 1,
    name: 'min_size',
    passed: meta.byteSize >= 1024,
    detail: `bytes=${meta.byteSize}`,
  });
  const w = meta.width ?? 0;
  const h = meta.height ?? 0;
  checks.push({
    level: 1,
    name: 'min_dimensions',
    passed: w >= 512 && h >= 512,
    detail: `${w}x${h}`,
  });
  const mimeOk = !meta.mimeType || meta.mimeType.startsWith('image/');
  checks.push({
    level: 1,
    name: 'mime_type',
    passed: mimeOk,
    detail: meta.mimeType ?? 'unknown',
  });
  checks.push({
    level: 1,
    name: 'hash_present',
    passed: Boolean(meta.sha256 && meta.sha256.length >= 32),
  });
  return checks;
}

export function summarizeQc(checks: QcCheckResult[]): QcSummary {
  const passed = checks.every((c) => c.passed);
  const scored = checks.filter((c) => typeof c.score === 'number');
  const overallScore =
    scored.length > 0
      ? scored.reduce((s, c) => s + (c.score ?? 0), 0) / scored.length
      : null;
  return { passed, checks, overallScore };
}

/** Never upload if QC failed — constitution rule */
export function mayUpload(qcPassed: boolean, factoryAllowsUpload: boolean): boolean {
  if (!qcPassed) return false;
  return factoryAllowsUpload;
}
