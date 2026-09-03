/**
 * Real pixel-based perceptual hash pipeline.
 * 1. decode → RGBA  2. hash → aHash  3. distance → Hamming  4. policy → threshold
 */

import { hammingDistanceHex } from './duplicate.js';
import { decodeImageBytes, type DecodeFailure } from './phash-decode.js';
import { averageHashFromRgba, type RgbaImage } from './phash-pixels.js';
import {
  DEFAULT_PHASH_THRESHOLD,
  isNearDuplicate,
  type PhashThresholdPolicy,
  DEFAULT_PHASH_POLICY,
} from './phash-threshold.js';

export type PhashSuccess = {
  ok: true;
  phash: string;
  width: number;
  height: number;
  format: string;
};

export type PhashFailure = {
  ok: false;
  code: DecodeFailure['code'] | 'PHASH_COMPUTE_ERROR';
  message: string;
};

export type PhashResult = PhashSuccess | PhashFailure;

export function computePhashFromRgba(image: RgbaImage): PhashResult {
  try {
    const phash = averageHashFromRgba(image);
    return { ok: true, phash, width: image.width, height: image.height, format: 'rgba' };
  } catch (e) {
    return {
      ok: false,
      code: 'PHASH_COMPUTE_ERROR',
      message: e instanceof Error ? e.message : 'phash compute error',
    };
  }
}

export async function computePhashFromImageBytes(bytes: Uint8Array): Promise<PhashResult> {
  const decoded = await decodeImageBytes(bytes);
  if (!decoded.ok) {
    return { ok: false, code: decoded.code, message: decoded.message };
  }
  const hashed = computePhashFromRgba(decoded.image);
  if (!hashed.ok) return hashed;
  return { ...hashed, format: decoded.format };
}

export function comparePhash(
  a: string,
  b: string,
  threshold: number = DEFAULT_PHASH_THRESHOLD
): { distance: number; isDuplicate: boolean } {
  const distance = hammingDistanceHex(a, b);
  return { distance, isDuplicate: isNearDuplicate(distance, threshold) };
}

export {
  DEFAULT_PHASH_THRESHOLD,
  DEFAULT_PHASH_POLICY,
  isNearDuplicate,
  type PhashThresholdPolicy,
};
