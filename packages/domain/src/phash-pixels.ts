/**
 * Pixel-based average hash (aHash) — 64-bit perceptual fingerprint.
 * Deterministic: same pixels → same hash.
 */

import { averageHashFromBlock } from './duplicate.js';

export type RgbaImage = {
  width: number;
  height: number;
  rgba: Uint8Array;
};

export function lumaAt(rgba: Uint8Array, pixelIndex: number): number {
  const o = pixelIndex * 4;
  const r = rgba[o] ?? 0;
  const g = rgba[o + 1] ?? 0;
  const b = rgba[o + 2] ?? 0;
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function downsampleToLuma8x8(img: RgbaImage): number[] {
  const { width, height, rgba } = img;
  if (width < 1 || height < 1) throw new Error('PHASH_INVALID_DIMENSIONS');
  if (rgba.byteLength < width * height * 4) throw new Error('PHASH_RGBA_LENGTH_MISMATCH');
  const out: number[] = new Array(64);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const sx = Math.min(width - 1, Math.floor(((x + 0.5) * width) / 8));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) * height) / 8));
      out[y * 8 + x] = lumaAt(rgba, sy * width + sx);
    }
  }
  return out;
}

export function averageHashFromRgba(img: RgbaImage): string {
  return averageHashFromBlock(downsampleToLuma8x8(img));
}

export function solidRgba(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a = 255
): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    rgba[o] = r;
    rgba[o + 1] = g;
    rgba[o + 2] = b;
    rgba[o + 3] = a;
  }
  return { width, height, rgba };
}

export function gradientRgba(width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      rgba[o] = Math.floor((x / Math.max(1, width - 1)) * 255);
      rgba[o + 1] = Math.floor((y / Math.max(1, height - 1)) * 255);
      rgba[o + 2] = 128;
      rgba[o + 3] = 255;
    }
  }
  return { width, height, rgba };
}
