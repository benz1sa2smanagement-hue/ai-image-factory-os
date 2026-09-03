/**
 * MockGenerationProvider — deterministic, no network, no credentials.
 * Produces a real valid PNG (uncompressed deflate) for MOCK_MODE and tests.
 */

import type {
  GenerationProvider,
  GenerationRequest,
  GenerationOutcome,
  GenerationMetadata,
} from './generation.js';

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** CRC32 (ISO 3309 / PNG) */
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = u32be(data.length);
  const crcInput = concat([typeBytes, data]);
  const crc = u32be(crc32(crcInput));
  return concat([len, typeBytes, data, crc]);
}

/** Adler-32 for zlib trailer */
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Build a valid RGB PNG with deterministic pixels from seed/prompt.
 * Mock clamps pixel grid to max 16×16 to keep fixtures small while IHDR
 * records the logical requested size via metadata (actual bitmap = min dims).
 */
export function encodeDeterministicPng(opts: {
  width: number;
  height: number;
  seed: number;
  prompt: string;
}): Uint8Array {
  const w = Math.max(1, Math.min(16, opts.width));
  const h = Math.max(1, Math.min(16, opts.height));

  // Filter byte 0 + RGB per pixel
  const raw = new Uint8Array((1 + w * 3) * h);
  let hash = (opts.seed >>> 0) ^ 0x9e3779b9;
  for (let i = 0; i < opts.prompt.length; i++) {
    hash = (Math.imul(hash ^ opts.prompt.charCodeAt(i), 0x01000193) >>> 0);
  }

  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // none filter
    for (let x = 0; x < w; x++) {
      const px = row + 1 + x * 3;
      const v = (hash + Math.imul(x + 1, 374761393) + Math.imul(y + 1, 668265263)) >>> 0;
      raw[px] = (v >>> 16) & 0xff;
      raw[px + 1] = (v >>> 8) & 0xff;
      raw[px + 2] = v & 0xff;
    }
  }

  // zlib: CMF/FLG + uncompressed deflate blocks + Adler32
  const blocks: Uint8Array[] = [];
  const maxChunk = 65535;
  let offset = 0;
  while (offset < raw.length) {
    const slice = raw.subarray(offset, Math.min(offset + maxChunk, raw.length));
    const last = offset + slice.length >= raw.length;
    const header = new Uint8Array([
      last ? 0x01 : 0x00,
      slice.length & 0xff,
      (slice.length >>> 8) & 0xff,
      ~slice.length & 0xff,
      (~slice.length >>> 8) & 0xff,
    ]);
    blocks.push(header, slice);
    offset += slice.length;
  }
  const deflated = concat(blocks);
  const zlibBody = concat([
    new Uint8Array([0x78, 0x01]), // zlib header, no compression
    deflated,
    u32be(adler32(raw)),
  ]);

  const ihdr = concat([
    u32be(w),
    u32be(h),
    new Uint8Array([8, 2, 0, 0, 0]), // 8-bit RGB
  ]);

  return concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlibBody),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

function defaultSeed(req: GenerationRequest): number {
  if (req.seed != null) return req.seed;
  let h = 2166136261;
  for (let i = 0; i < req.prompt.length; i++) {
    h ^= req.prompt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= req.width;
  h = Math.imul(h, 16777619);
  h ^= req.height;
  return h >>> 0;
}

export class MockGenerationProvider implements GenerationProvider {
  readonly id = 'mock';
  readonly modelId = 'mock-image-v1';

  async generate(request: GenerationRequest): Promise<GenerationOutcome> {
    const outcome = request.mockOutcome ?? 'MOCK_SUCCESS';

    if (outcome === 'MOCK_RETRYABLE_ERROR') {
      return {
        success: false,
        code: 'MOCK_RETRYABLE_ERROR',
        message: 'simulated transient generation failure',
        retryable: true,
      };
    }
    if (outcome === 'MOCK_PERMANENT_ERROR') {
      return {
        success: false,
        code: 'QC_REJECTED',
        message: 'simulated permanent generation failure',
        retryable: false,
      };
    }

    // jpeg requested → still emit PNG bytes but label format png for validity;
    // mock supports png as the only real encoder (valid image file).
    const format = 'png' as const;
    const seed = defaultSeed(request);
    const imageBytes = encodeDeterministicPng({
      width: request.width,
      height: request.height,
      seed,
      prompt: request.prompt,
    });

    const generatedAt = new Date().toISOString();
    const metadata: GenerationMetadata = {
      jobId: request.jobId,
      requestId: request.requestId,
      provider: this.id,
      model: this.modelId,
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      width: request.width,
      height: request.height,
      format,
      seed,
      generatedAt,
      mock: true,
    };

    return {
      success: true,
      provider: this.id,
      model: this.modelId,
      imageBytes,
      width: request.width,
      height: request.height,
      format,
      mimeType: 'image/png',
      seed,
      metadata,
    };
  }
}
