/**
 * Image decode for pHash — Cloudflare Workers compatible.
 * PNG: pure TS + DecompressionStream. JPEG: predictable failure (no WASM/Node Buffer).
 * Raw RGBA handled via computePhashFromRgba in phash.ts.
 */

import type { RgbaImage } from './phash-pixels.js';

export type ImageFormat = 'png' | 'jpeg' | 'rgba' | 'unknown';

export type DecodeSuccess = { ok: true; format: ImageFormat; image: RgbaImage };
export type DecodeFailure = {
  ok: false;
  code:
    | 'EMPTY_INPUT'
    | 'UNSUPPORTED_FORMAT'
    | 'JPEG_DECODE_NOT_AVAILABLE'
    | 'PNG_INVALID'
    | 'PNG_INFLATE_FAILED'
    | 'PNG_UNSUPPORTED_COLOR_TYPE'
    | 'DECODE_ERROR';
  message: string;
};
export type DecodeResult = DecodeSuccess | DecodeFailure;

export function detectFormat(bytes: Uint8Array): ImageFormat {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return 'unknown';
}

function readU32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  try {
    const ds = new DecompressionStream('deflate');
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    let raw = data;
    if (data.length > 6 && (data[0] === 0x78 || data[0] === 0x68 || data[0] === 0x58)) {
      raw = data.subarray(2, data.length - 4);
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([raw as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilterScanlines(
  inflated: Uint8Array,
  width: number,
  height: number,
  bpp: number
): Uint8Array {
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]!;
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let i = 0; i < stride; i++) {
      const x = inflated[src++]!;
      const left = i >= bpp ? out[rowStart + i - bpp]! : 0;
      const up = y > 0 ? out[prevStart + i]! : 0;
      const upLeft = y > 0 && i >= bpp ? out[prevStart + i - bpp]! : 0;
      let val = 0;
      switch (filter) {
        case 0:
          val = x;
          break;
        case 1:
          val = (x + left) & 255;
          break;
        case 2:
          val = (x + up) & 255;
          break;
        case 3:
          val = (x + Math.floor((left + up) / 2)) & 255;
          break;
        case 4:
          val = (x + paeth(left, up, upLeft)) & 255;
          break;
        default:
          throw new Error('PNG_INVALID_FILTER');
      }
      out[rowStart + i] = val;
    }
  }
  return out;
}

function toRgba(
  raw: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  bitDepth: number
): Uint8Array {
  if (bitDepth !== 8) throw new Error('PNG_UNSUPPORTED_BIT_DEPTH');
  const rgba = new Uint8Array(width * height * 4);
  if (colorType === 2) {
    for (let i = 0, p = 0; i < width * height; i++, p += 3) {
      const o = i * 4;
      rgba[o] = raw[p]!;
      rgba[o + 1] = raw[p + 1]!;
      rgba[o + 2] = raw[p + 2]!;
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 6) {
    rgba.set(raw.subarray(0, width * height * 4));
    return rgba;
  }
  if (colorType === 0) {
    for (let i = 0; i < width * height; i++) {
      const g = raw[i]!;
      const o = i * 4;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = 255;
    }
    return rgba;
  }
  if (colorType === 4) {
    for (let i = 0, p = 0; i < width * height; i++, p += 2) {
      const g = raw[p]!;
      const o = i * 4;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
      rgba[o + 3] = raw[p + 1]!;
    }
    return rgba;
  }
  throw new Error('PNG_UNSUPPORTED_COLOR_TYPE');
}

export async function decodePng(bytes: Uint8Array): Promise<DecodeResult> {
  try {
    if (detectFormat(bytes) !== 'png') {
      return { ok: false, code: 'PNG_INVALID', message: 'not a PNG signature' };
    }
    let offset = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idatParts: Uint8Array[] = [];
    while (offset + 8 <= bytes.length) {
      const len = readU32be(bytes, offset);
      offset += 4;
      const type = String.fromCharCode(
        bytes[offset]!,
        bytes[offset + 1]!,
        bytes[offset + 2]!,
        bytes[offset + 3]!
      );
      offset += 4;
      const data = bytes.subarray(offset, offset + len);
      offset += len + 4;
      if (type === 'IHDR') {
        width = readU32be(data, 0);
        height = readU32be(data, 4);
        bitDepth = data[8]!;
        colorType = data[9]!;
      } else if (type === 'IDAT') {
        idatParts.push(data);
      } else if (type === 'IEND') {
        break;
      }
    }
    if (!width || !height || idatParts.length === 0) {
      return { ok: false, code: 'PNG_INVALID', message: 'missing IHDR/IDAT' };
    }
    const total = idatParts.reduce((s, p) => s + p.length, 0);
    const zlibData = new Uint8Array(total);
    let pos = 0;
    for (const p of idatParts) {
      zlibData.set(p, pos);
      pos += p.length;
    }
    let inflated: Uint8Array;
    try {
      inflated = await inflateZlib(zlibData);
    } catch {
      return { ok: false, code: 'PNG_INFLATE_FAILED', message: 'zlib inflate failed' };
    }
    const bpp =
      colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
    if (!bpp) {
      return {
        ok: false,
        code: 'PNG_UNSUPPORTED_COLOR_TYPE',
        message: `colorType=${colorType}`,
      };
    }
    const raw = unfilterScanlines(inflated, width, height, bpp);
    const rgba = toRgba(raw, width, height, colorType, bitDepth);
    return { ok: true, format: 'png', image: { width, height, rgba } };
  } catch (e) {
    return {
      ok: false,
      code: 'DECODE_ERROR',
      message: e instanceof Error ? e.message : 'png decode error',
    };
  }
}

export async function decodeImageBytes(bytes: Uint8Array): Promise<DecodeResult> {
  if (!bytes || bytes.byteLength === 0) {
    return { ok: false, code: 'EMPTY_INPUT', message: 'empty image bytes' };
  }
  const format = detectFormat(bytes);
  if (format === 'png') return decodePng(bytes);
  if (format === 'jpeg') {
    return {
      ok: false,
      code: 'JPEG_DECODE_NOT_AVAILABLE',
      message:
        'JPEG pixel decode is not bundled in the pure Workers path (no Node Buffer / no WASM). Provide RGBA or PNG, or add a Workers-safe JPEG codec later.',
    };
  }
  return {
    ok: false,
    code: 'UNSUPPORTED_FORMAT',
    message: `unsupported or unknown image format (magic detected: ${format})`,
  };
}

export async function encodeSimpleRgbPng(
  width: number,
  height: number,
  rgb: Uint8Array
): Promise<Uint8Array> {
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  if (typeof CompressionStream === 'undefined') {
    throw new Error('CompressionStream required to encode test PNG');
  }
  const cs = new CompressionStream('deflate');
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(cs);
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());

  function crc32(buf: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c ^= buf[i]!;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    return (c ^ 0xffffffff) >>> 0;
  }
  function chunk(type: string, data: Uint8Array): Uint8Array {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out[4] = type.charCodeAt(0);
    out[5] = type.charCodeAt(1);
    out[6] = type.charCodeAt(2);
    out[7] = type.charCodeAt(3);
    out.set(data, 8);
    const crcBuf = new Uint8Array(4 + data.length);
    crcBuf.set(out.subarray(4, 8), 0);
    crcBuf.set(data, 4);
    view.setUint32(8 + data.length, crc32(crcBuf));
    return out;
  }
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
