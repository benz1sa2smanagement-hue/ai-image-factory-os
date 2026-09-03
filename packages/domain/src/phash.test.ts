import { describe, it, expect } from 'vitest';
import { hammingDistanceHex } from './duplicate.js';
import {
  averageHashFromRgba,
  solidRgba,
  gradientRgba,
  downsampleToLuma8x8,
} from './phash-pixels.js';
import { computePhashFromRgba, computePhashFromImageBytes, comparePhash } from './phash.js';
import {
  DEFAULT_PHASH_THRESHOLD,
  isNearDuplicate,
  STRICT_PHASH_THRESHOLD,
} from './phash-threshold.js';
import { decodeImageBytes, detectFormat, encodeSimpleRgbPng } from './phash-decode.js';

describe('pixel aHash generation', () => {
  it('is deterministic for same pixels', () => {
    const img = solidRgba(32, 32, 200, 100, 50);
    const a = averageHashFromRgba(img);
    const b = averageHashFromRgba(img);
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it('same image → Hamming distance 0', () => {
    const img = gradientRgba(64, 48);
    const h1 = averageHashFromRgba(img);
    const h2 = averageHashFromRgba({ ...img, rgba: new Uint8Array(img.rgba) });
    expect(hammingDistanceHex(h1, h2)).toBe(0);
  });

  it('identical pixels different buffer → same hash', () => {
    const a = solidRgba(16, 16, 10, 20, 30);
    const b = solidRgba(16, 16, 10, 20, 30);
    expect(averageHashFromRgba(a)).toBe(averageHashFromRgba(b));
  });

  it('similar solids closer than unrelated', () => {
    const light = solidRgba(40, 40, 250, 250, 250);
    const light2 = solidRgba(40, 40, 240, 240, 240);
    const dark = solidRgba(40, 40, 5, 5, 5);
    const sim = hammingDistanceHex(averageHashFromRgba(light), averageHashFromRgba(light2));
    const unrel = hammingDistanceHex(averageHashFromRgba(light), averageHashFromRgba(dark));
    expect(sim).toBeLessThanOrEqual(unrel);
    expect(sim).toBeLessThanOrEqual(STRICT_PHASH_THRESHOLD);
  });

  it('downsample uses real pixel samples', () => {
    const block = downsampleToLuma8x8(gradientRgba(16, 16));
    expect(block).toHaveLength(64);
    expect(new Set(block.map((v) => Math.round(v))).size).toBeGreaterThan(1);
  });
});

describe('threshold policy', () => {
  it('isNearDuplicate respects threshold', () => {
    expect(isNearDuplicate(0)).toBe(true);
    expect(isNearDuplicate(DEFAULT_PHASH_THRESHOLD)).toBe(true);
    expect(isNearDuplicate(DEFAULT_PHASH_THRESHOLD + 1)).toBe(false);
  });

  it('comparePhash', () => {
    const h = averageHashFromRgba(solidRgba(8, 8, 1, 2, 3));
    expect(comparePhash(h, h, 0).isDuplicate).toBe(true);
  });
});

describe('decode pipeline', () => {
  it('detects magic', () => {
    expect(detectFormat(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('png');
    expect(detectFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
  });

  it('JPEG predictable failure', async () => {
    const r = await computePhashFromImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('JPEG_DECODE_NOT_AVAILABLE');
  });

  it('empty/corrupt predictable failure', async () => {
    expect((await computePhashFromImageBytes(new Uint8Array(0))).ok).toBe(false);
    expect((await computePhashFromImageBytes(new Uint8Array([1, 2, 3]))).ok).toBe(false);
  });

  it('PNG round-trip when streams available', async () => {
    if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') {
      expect(true).toBe(true);
      return;
    }
    const w = 16;
    const h = 16;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = (i * 3) % 256;
      rgb[i * 3 + 1] = (i * 7) % 256;
      rgb[i * 3 + 2] = (i * 11) % 256;
    }
    const png = await encodeSimpleRgbPng(w, h, rgb);
    const r1 = await computePhashFromImageBytes(png);
    const r2 = await computePhashFromImageBytes(png);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.phash).toBe(r2.phash);
  });

  it('computePhashFromRgba success', () => {
    expect(computePhashFromRgba(solidRgba(24, 24, 128, 64, 32)).ok).toBe(true);
  });
});
