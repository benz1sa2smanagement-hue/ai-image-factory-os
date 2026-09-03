/**
 * Lightweight image byte validation — no image libraries.
 * Detects PNG / JPEG signatures and enforces size bounds.
 */

export type DetectedImageFormat = 'png' | 'jpeg' | 'unknown';

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MiB hard cap
export const MIN_IMAGE_BYTES = 32;

export function detectImageFormat(bytes: Uint8Array): DetectedImageFormat {
  if (bytes.length >= 8) {
    if (
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
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return 'unknown';
}

export type ImageBytesValidation =
  | { ok: true; format: 'png' | 'jpeg'; size: number }
  | { ok: false; code: string; message: string };

export function validateImageBytes(
  bytes: Uint8Array,
  expected?: 'png' | 'jpeg'
): ImageBytesValidation {
  if (!bytes || bytes.length < MIN_IMAGE_BYTES) {
    return { ok: false, code: 'EMPTY_IMAGE', message: 'image bytes empty or too small' };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return { ok: false, code: 'IMAGE_TOO_LARGE', message: `image exceeds ${MAX_IMAGE_BYTES} bytes` };
  }
  const format = detectImageFormat(bytes);
  if (format === 'unknown') {
    return { ok: false, code: 'MALFORMED_IMAGE', message: 'unrecognized image signature' };
  }
  if (expected && format !== expected) {
    return {
      ok: false,
      code: 'FORMAT_MISMATCH',
      message: `expected ${expected}, got ${format}`,
    };
  }
  return { ok: true, format, size: bytes.length };
}

/** base64 → Uint8Array (Workers-safe, no Buffer) */
export function base64ToBytes(b64: string): Uint8Array {
  const cleaned = b64.replace(/^data:image\/[^;]+;base64,/, '').replace(/\s/g, '');
  const bin = atob(cleaned);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
