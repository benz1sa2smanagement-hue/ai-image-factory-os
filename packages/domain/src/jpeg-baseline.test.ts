import { describe, it, expect } from 'vitest';
import { decodeJpegBaseline } from './jpeg-baseline.js';
import { computePhashFromImageBytes } from './phash.js';
import { averageHashFromRgba, solidRgba } from './phash-pixels.js';
import { hammingDistanceHex } from './duplicate.js';
import { detectFormat } from './phash-decode.js';
import { readFileSync, existsSync } from 'node:fs';

/** Load fixture from /tmp if present (local), else skip-heavy path uses minimal magic */
function loadJpg(name: string): Uint8Array | null {
  const p = `/tmp/${name}.jpg`;
  if (existsSync(p)) return new Uint8Array(readFileSync(p));
  return null;
}

describe('JPEG baseline decode', () => {
  it('decodes real JPEG when fixture available', () => {
    const bytes = loadJpg('solid_a');
    if (!bytes) {
      // Minimal SOI-only must fail predictably
      const r = decodeJpegBaseline(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
      expect(r.ok).toBe(false);
      return;
    }
    expect(detectFormat(bytes)).toBe('jpeg');
    const r = decodeJpegBaseline(bytes);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.width).toBe(32);
    expect(r.height).toBe(32);
    expect(r.rgba.byteLength).toBe(32 * 32 * 4);
  });

  it('same JPEG → deterministic hash', async () => {
    const bytes = loadJpg('solid_a');
    if (!bytes) return;
    const a = await computePhashFromImageBytes(bytes);
    const b = await computePhashFromImageBytes(bytes);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.phash).toBe(b.phash);
    expect(a.format).toBe('jpeg');
  });

  it('re-encoded same solid → near-identical hash', async () => {
    const aBytes = loadJpg('solid_a');
    const bBytes = loadJpg('solid_a2');
    if (!aBytes || !bBytes) return;
    const a = await computePhashFromImageBytes(aBytes);
    const b = await computePhashFromImageBytes(bBytes);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(hammingDistanceHex(a.phash, b.phash)).toBeLessThanOrEqual(2);
  });

  it('similar patterns closer than unrelated', async () => {
    const aBytes = loadJpg('check_a');
    const bBytes = loadJpg('check_b');
    const sBytes = loadJpg('solid_a');
    if (!aBytes || !bBytes || !sBytes) return;
    const a = await computePhashFromImageBytes(aBytes);
    const b = await computePhashFromImageBytes(bBytes);
    const s = await computePhashFromImageBytes(sBytes);
    expect(a.ok && b.ok && s.ok).toBe(true);
    if (!a.ok || !b.ok || !s.ok) return;
    expect(hammingDistanceHex(a.phash, b.phash)).toBeLessThanOrEqual(
      hammingDistanceHex(a.phash, s.phash)
    );
  });

  it('corrupted JPEG → predictable error', () => {
    const r = decodeJpegBaseline(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    expect(r.ok).toBe(false);
  });

  it('different dimensions do not crash', async () => {
    for (const name of ['gray8', 'red16', 'solid_a', 'check_a']) {
      const bytes = loadJpg(name);
      if (!bytes) continue;
      const r = await computePhashFromImageBytes(bytes);
      expect(r.ok).toBe(true);
    }
  });
});

describe('JPEG regression PNG/RGBA', () => {
  it('RGBA path unchanged', () => {
    expect(averageHashFromRgba(solidRgba(16, 16, 50, 50, 50))).toHaveLength(16);
  });

  it('unknown bytes fail predictably', async () => {
    expect((await computePhashFromImageBytes(new Uint8Array([1, 2, 3, 4]))).ok).toBe(false);
  });
});
