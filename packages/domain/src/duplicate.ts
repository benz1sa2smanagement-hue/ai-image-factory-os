/**
 * Duplicate detection — Exact SHA-256 + perceptual hash (pHash).
 * Semantic layer reserved for later.
 * Pixel pHash generation lives in phash.ts / phash-pixels.ts.
 */

import { DEFAULT_PHASH_THRESHOLD } from './phash-threshold.js';

export type DuplicateLayer = 'exact' | 'phash' | 'semantic';

export interface HashRecord {
  hashType: 'sha256' | 'phash';
  hashValue: string;
  assetId: string;
}

export interface DuplicateMatch {
  layer: DuplicateLayer;
  matchedAssetId: string;
  score: number;
  isDuplicate: boolean;
}

export interface DuplicateCheckResult {
  isDuplicate: boolean;
  matches: DuplicateMatch[];
  sha256?: string;
  phash?: string;
}

export function normalizeHex(hex: string): string {
  return hex.trim().toLowerCase().replace(/^0x/, '');
}

export function findExactDuplicate(
  sha256: string,
  existing: HashRecord[]
): DuplicateMatch | null {
  const target = normalizeHex(sha256);
  if (!target || target.length < 32) return null;
  for (const h of existing) {
    if (h.hashType === 'sha256' && normalizeHex(h.hashValue) === target) {
      return { layer: 'exact', matchedAssetId: h.assetId, score: 0, isDuplicate: true };
    }
  }
  return null;
}

export function hammingDistanceHex(a: string, b: string): number {
  const x = normalizeHex(a);
  const y = normalizeHex(b);
  if (x.length !== y.length || x.length === 0) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < x.length; i++) {
    const nibble = parseInt(x[i], 16) ^ parseInt(y[i], 16);
    let v = nibble;
    while (v) {
      dist += v & 1;
      v >>= 1;
    }
  }
  return dist;
}

export function findPhashDuplicates(
  phash: string,
  existing: HashRecord[],
  threshold = DEFAULT_PHASH_THRESHOLD
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const target = normalizeHex(phash);
  if (!target) return matches;
  for (const h of existing) {
    if (h.hashType !== 'phash') continue;
    const dist = hammingDistanceHex(target, h.hashValue);
    if (dist <= threshold) {
      matches.push({
        layer: 'phash',
        matchedAssetId: h.assetId,
        score: dist,
        isDuplicate: true,
      });
    }
  }
  return matches;
}

export function checkDuplicates(input: {
  sha256?: string;
  phash?: string;
  existing: HashRecord[];
  phashThreshold?: number;
}): DuplicateCheckResult {
  const matches: DuplicateMatch[] = [];
  if (input.sha256) {
    const exact = findExactDuplicate(input.sha256, input.existing);
    if (exact) matches.push(exact);
  }
  if (input.phash && matches.length === 0) {
    matches.push(
      ...findPhashDuplicates(
        input.phash,
        input.existing,
        input.phashThreshold ?? DEFAULT_PHASH_THRESHOLD
      )
    );
  }
  return {
    isDuplicate: matches.some((m) => m.isDuplicate),
    matches,
    sha256: input.sha256,
    phash: input.phash,
  };
}

export function averageHashFromBlock(luma64: number[]): string {
  if (luma64.length !== 64) {
    throw new Error('averageHashFromBlock requires exactly 64 values');
  }
  const avg = luma64.reduce((s, v) => s + v, 0) / 64;
  let bits = '';
  for (const v of luma64) {
    bits += v >= avg ? '1' : '0';
  }
  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}
