/**
 * pHash threshold policy — separated from hash generation & distance.
 * Tune without touching algorithm code.
 */

/** Max Hamming distance (64-bit aHash) to treat as near-duplicate */
export const DEFAULT_PHASH_THRESHOLD = 10;

/** Stricter match (near-identical structure) */
export const STRICT_PHASH_THRESHOLD = 5;

/** Loose match (similar composition; higher false-positive risk) */
export const LOOSE_PHASH_THRESHOLD = 16;

export type PhashThresholdPolicy = {
  defaultThreshold: number;
  strict: number;
  loose: number;
  bitLength: number;
};

export const DEFAULT_PHASH_POLICY: PhashThresholdPolicy = {
  defaultThreshold: DEFAULT_PHASH_THRESHOLD,
  strict: STRICT_PHASH_THRESHOLD,
  loose: LOOSE_PHASH_THRESHOLD,
  bitLength: 64,
};

export function isNearDuplicate(
  hammingDistance: number,
  threshold: number = DEFAULT_PHASH_THRESHOLD
): boolean {
  return hammingDistance >= 0 && hammingDistance <= threshold;
}
