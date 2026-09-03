/**
 * Baseline sequential JPEG decoder → RGBA
 * Pure TypeScript, Uint8Array only — Cloudflare Workers safe.
 * SOF0 baseline, 8-bit, YCbCr/grayscale. No progressive/arithmetic/12-bit.
 * No Node Buffer, Canvas, WASM, network, or paid APIs.
 */

export type JpegDecodeOk = {
  ok: true;
  width: number;
  height: number;
  rgba: Uint8Array;
};

export type JpegDecodeErr = {
  ok: false;
  code: 'JPEG_INVALID' | 'JPEG_UNSUPPORTED' | 'JPEG_TOO_LARGE' | 'JPEG_DECODE_ERROR';
  message: string;
};

export type JpegDecodeResult = JpegDecodeOk | JpegDecodeErr;

const MAX_DIM = 4096;
const MAX_PIXELS = 4096 * 4096;

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55,
  62, 63,
];

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v | 0;
}

type HuffmanTable = {
  minCode: number[];
  maxCode: number[];
  valPtr: number[];
  values: number[];
};

type Component = {
  id: number;
  h: number;
  v: number;
  tq: number;
  pred: number;
  htDC: number;
  htAC: number;
};

class BitReader {
  data: Uint8Array;
  pos: number;
  bits = 0;
  nbits = 0;
  constructor(data: Uint8Array, pos: number) {
    this.data = data;
    this.pos = pos;
  }
  private fill() {
    while (this.nbits <= 24) {
      if (this.pos >= this.data.length) {
        this.bits = (this.bits << 8) | 0xff;
        this.nbits += 8;
        continue;
      }
      let b = this.data[this.pos++]!;
      if (b === 0xff) {
        while (this.pos < this.data.length && this.data[this.pos] === 0xff) this.pos++;
        if (this.pos < this.data.length && this.data[this.pos] === 0x00) {
          this.pos++;
        } else {
          this.pos--;
          b = 0xff;
        }
      }
      this.bits = (this.bits << 8) | b;
      this.nbits += 8;
    }
  }
  readBit(): number {
    this.fill();
    this.nbits--;
    return (this.bits >>> this.nbits) & 1;
  }
  readBits(n: number): number {
    if (n === 0) return 0;
    this.fill();
    this.nbits -= n;
    return (this.bits >>> this.nbits) & ((1 << n) - 1);
  }
}

function buildHuffman(bits: number[], values: number[]): HuffmanTable {
  const minCode: number[] = new Array(17).fill(0);
  const maxCode: number[] = new Array(17).fill(0);
  const valPtr: number[] = new Array(17).fill(0);
  let code = 0;
  let k = 0;
  for (let i = 1; i <= 16; i++) {
    if (bits[i]! !== 0) {
      valPtr[i] = k;
      minCode[i] = code;
      code += bits[i]!;
      maxCode[i] = code - 1;
      k += bits[i]!;
      code <<= 1;
    } else {
      maxCode[i] = -1;
    }
  }
  return { minCode, maxCode, valPtr, values };
}

function decodeHuffman(br: BitReader, table: HuffmanTable): number {
  let code = 0;
  for (let i = 1; i <= 16; i++) {
    code = (code << 1) | br.readBit();
    if (code <= table.maxCode[i]! && table.maxCode[i]! >= 0) {
      const idx = table.valPtr[i]! + (code - table.minCode[i]!);
      return table.values[idx]!;
    }
  }
  throw new Error('invalid huffman code');
}

function receiveExtend(br: BitReader, t: number): number {
  if (t === 0) return 0;
  let v = br.readBits(t);
  const vt = 1 << (t - 1);
  if (v < vt) v += (-1 << t) + 1;
  return v;
}

function idct(block: Int32Array) {
  const t = new Int32Array(64);
  for (let i = 0; i < 8; i++) {
    const o = i * 8;
    if (
      !block[o + 1] && !block[o + 2] && !block[o + 3] && !block[o + 4] && !block[o + 5] && !block[o + 6] && !block[o + 7]
    ) {
      const dc = block[o]! << 3;
      for (let j = 0; j < 8; j++) t[o + j] = dc;
      continue;
    }
    let x0 = (block[o]! << 11) + 128;
    let x1 = block[o + 4]! << 11;
    let x2 = block[o + 6]!;
    let x3 = block[o + 2]!;
    let x4 = block[o + 1]!;
    let x5 = block[o + 7]!;
    let x6 = block[o + 5]!;
    let x7 = block[o + 3]!;
    let x8 = (x4 + x5) * 4433;
    x4 = x8 + x4 * 6270;
    x5 = x8 - x5 * 15137;
    x8 = x0 + x1;
    x0 -= x1;
    x1 = (x2 + x3) * 6270;
    x2 = x1 - x2 * 15137;
    x3 = x1 + x3 * 4433;
    x1 = x4 + x6;
    x4 -= x6;
    x6 = x5 + x7;
    x5 -= x7;
    x7 = x8 + x3;
    x8 -= x3;
    x3 = x0 + x2;
    x0 -= x2;
    x2 = ((x4 + x5) * 11086) >> 16;
    x4 = ((x4 * 17746 - x2) >> 16) + x2;
    x5 = ((x5 * -17746 - x2) >> 16) + x2;
    t[o] = (x7 + x1) >> 8;
    t[o + 7] = (x7 - x1) >> 8;
    t[o + 1] = (x3 + x6) >> 8;
    t[o + 6] = (x3 - x6) >> 8;
    t[o + 2] = (x0 + x5) >> 8;
    t[o + 5] = (x0 - x5) >> 8;
    t[o + 3] = (x8 + x4) >> 8;
    t[o + 4] = (x8 - x4) >> 8;
  }
  for (let i = 0; i < 8; i++) {
    const o = i;
    if (
      !t[8 + o] && !t[16 + o] && !t[24 + o] && !t[32 + o] && !t[40 + o] && !t[48 + o] && !t[56 + o]
    ) {
      const dc = clamp(((t[o]! + 32) >> 6) + 128);
      for (let j = 0; j < 8; j++) block[j * 8 + o] = dc;
      continue;
    }
    let x0 = (t[o]! << 8) + 8192;
    let x1 = t[32 + o]! << 8;
    let x2 = t[48 + o]!;
    let x3 = t[16 + o]!;
    let x4 = t[8 + o]!;
    let x5 = t[56 + o]!;
    let x6 = t[40 + o]!;
    let x7 = t[24 + o]!;
    let x8 = (x4 + x5) * 4433;
    x4 = x8 + x4 * 6270;
    x5 = x8 - x5 * 15137;
    x8 = x0 + x1;
    x0 -= x1;
    x1 = (x2 + x3) * 6270;
    x2 = x1 - x2 * 15137;
    x3 = x1 + x3 * 4433;
    x1 = x4 + x6;
    x4 -= x6;
    x6 = x5 + x7;
    x5 -= x7;
    x7 = x8 + x3;
    x8 -= x3;
    x3 = x0 + x2;
    x0 -= x2;
    x2 = ((x4 + x5) * 11086) >> 16;
    x4 = ((x4 * 17746 - x2) >> 16) + x2;
    x5 = ((x5 * -17746 - x2) >> 16) + x2;
    block[o] = clamp(((x7 + x1) >> 14) + 128);
    block[56 + o] = clamp(((x7 - x1) >> 14) + 128);
    block[8 + o] = clamp(((x3 + x6) >> 14) + 128);
    block[48 + o] = clamp(((x3 - x6) >> 14) + 128);
    block[16 + o] = clamp(((x0 + x5) >> 14) + 128);
    block[40 + o] = clamp(((x0 - x5) >> 14) + 128);
    block[24 + o] = clamp(((x8 + x4) >> 14) + 128);
    block[32 + o] = clamp(((x8 - x4) >> 14) + 128);
  }
}

export function decodeJpegBaseline(bytes: Uint8Array): JpegDecodeResult {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
      return { ok: false, code: 'JPEG_INVALID', message: 'missing SOI' };
    }
    let pos = 2;
    const quantTables: (number[] | null)[] = [null, null, null, null];
    const huffmanDC: (HuffmanTable | null)[] = [null, null, null, null];
    const huffmanAC: (HuffmanTable | null)[] = [null, null, null, null];
    let width = 0;
    let height = 0;
    let components: Component[] = [];
    let sosPos = -1;
    let restartInterval = 0;

    while (pos < bytes.length) {
      if (bytes[pos] !== 0xff) {
        pos++;
        continue;
      }
      while (pos < bytes.length && bytes[pos] === 0xff) pos++;
      if (pos >= bytes.length) break;
      const marker = bytes[pos++]!;
      if (marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (pos + 2 > bytes.length) break;
      const len = (bytes[pos]! << 8) | bytes[pos + 1]!;
      const dataStart = pos + 2;
      const dataEnd = pos + len;
      if (dataEnd > bytes.length) return { ok: false, code: 'JPEG_INVALID', message: 'truncated segment' };
      const seg = bytes.subarray(dataStart, dataEnd);
      pos = dataEnd;

      if (marker === 0xc0) {
        if (seg[0] !== 8) return { ok: false, code: 'JPEG_UNSUPPORTED', message: 'only 8-bit supported' };
        height = (seg[1]! << 8) | seg[2]!;
        width = (seg[3]! << 8) | seg[4]!;
        const n = seg[5]!;
        if (width < 1 || height < 1 || width > MAX_DIM || height > MAX_DIM || width * height > MAX_PIXELS) {
          return { ok: false, code: 'JPEG_TOO_LARGE', message: `${width}x${height}` };
        }
        components = [];
        let o = 6;
        for (let i = 0; i < n; i++) {
          const id = seg[o++]!;
          const hv = seg[o++]!;
          const tq = seg[o++]!;
          components.push({ id, h: hv >> 4, v: hv & 0xf, tq, pred: 0, htDC: 0, htAC: 0 });
        }
      } else if (marker === 0xc2) {
        return { ok: false, code: 'JPEG_UNSUPPORTED', message: 'progressive JPEG not supported' };
      } else if (marker === 0xdb) {
        let o = 0;
        while (o < seg.length) {
          const pq_tq = seg[o++]!;
          const tq = pq_tq & 0x0f;
          const pq = pq_tq >> 4;
          const table: number[] = new Array(64);
          for (let i = 0; i < 64; i++) {
            if (pq === 0) table[ZIGZAG[i]!] = seg[o++]!;
            else {
              table[ZIGZAG[i]!] = (seg[o]! << 8) | seg[o + 1]!;
              o += 2;
            }
          }
          quantTables[tq] = table;
        }
      } else if (marker === 0xc4) {
        let o = 0;
        while (o < seg.length) {
          const tc_th = seg[o++]!;
          const tc = tc_th >> 4;
          const th = tc_th & 0x0f;
          const bits = [0];
          let nval = 0;
          for (let i = 1; i <= 16; i++) {
            bits[i] = seg[o++]!;
            nval += bits[i]!;
          }
          const values: number[] = [];
          for (let i = 0; i < nval; i++) values.push(seg[o++]!);
          const table = buildHuffman(bits, values);
          if (tc === 0) huffmanDC[th] = table;
          else huffmanAC[th] = table;
        }
      } else if (marker === 0xdd) {
        restartInterval = (seg[0]! << 8) | seg[1]!;
      } else if (marker === 0xda) {
        const n = seg[0]!;
        let o = 1;
        for (let i = 0; i < n; i++) {
          const id = seg[o++]!;
          const td_ta = seg[o++]!;
          const comp = components.find((c) => c.id === id);
          if (comp) {
            comp.htDC = td_ta >> 4;
            comp.htAC = td_ta & 0x0f;
          }
        }
        sosPos = pos;
        break;
      }
    }

    if (!width || !height || components.length === 0 || sosPos < 0) {
      return { ok: false, code: 'JPEG_INVALID', message: 'incomplete JPEG headers' };
    }

    const maxH = Math.max(...components.map((c) => c.h));
    const maxV = Math.max(...components.map((c) => c.v));
    const mcusPerRow = Math.ceil(width / (8 * maxH));
    const mcuRows = Math.ceil(height / (8 * maxV));
    const planes: Uint8Array[] = components.map((c) => new Uint8Array(mcusPerRow * c.h * 8 * mcuRows * c.v * 8));
    const planeW = components.map((c) => mcusPerRow * c.h * 8);
    const br = new BitReader(bytes, sosPos);
    let mcuCount = 0;

    for (let my = 0; my < mcuRows; my++) {
      for (let mx = 0; mx < mcusPerRow; mx++) {
        if (restartInterval > 0 && mcuCount > 0 && mcuCount % restartInterval === 0) {
          br.nbits = 0;
          for (const c of components) c.pred = 0;
        }
        for (let ci = 0; ci < components.length; ci++) {
          const comp = components[ci]!;
          const qt = quantTables[comp.tq];
          const htDC = huffmanDC[comp.htDC];
          const htAC = huffmanAC[comp.htAC];
          if (!qt || !htDC || !htAC) return { ok: false, code: 'JPEG_INVALID', message: 'missing tables' };
          for (let v = 0; v < comp.v; v++) {
            for (let h = 0; h < comp.h; h++) {
              const block = new Int32Array(64);
              const t = decodeHuffman(br, htDC);
              const diff = receiveExtend(br, t);
              comp.pred += diff;
              block[0] = comp.pred * qt[0]!;
              let k = 1;
              while (k < 64) {
                const rs = decodeHuffman(br, htAC);
                const s = rs & 0xf;
                const r = rs >> 4;
                if (s === 0) {
                  if (r === 15) k += 16;
                  else break;
                } else {
                  k += r;
                  if (k >= 64) break;
                  const zz = ZIGZAG[k]!;
                  block[zz] = receiveExtend(br, s) * qt[zz]!;
                  k++;
                }
              }
              idct(block);
              const duX = (mx * comp.h + h) * 8;
              const duY = (my * comp.v + v) * 8;
              const pw = planeW[ci]!;
              const plane = planes[ci]!;
              for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) {
                  plane[(duY + y) * pw + (duX + x)] = block[y * 8 + x]!;
                }
              }
            }
          }
        }
        mcuCount++;
      }
    }

    const rgba = new Uint8Array(width * height * 4);
    const yPlane = planes[0]!;
    const yW = planeW[0]!;
    const hasChroma = components.length >= 3;
    const cbPlane = hasChroma ? planes[1]! : null;
    const crPlane = hasChroma ? planes[2]! : null;
    const cbW = hasChroma ? planeW[1]! : 0;
    const crW = hasChroma ? planeW[2]! : 0;
    const cbHscale = hasChroma ? components[0]!.h / components[1]!.h : 1;
    const cbVscale = hasChroma ? components[0]!.v / components[1]!.v : 1;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const Y = yPlane[y * yW + x] ?? 128;
        let r: number, g: number, b: number;
        if (hasChroma && cbPlane && crPlane) {
          const cx = Math.min(cbW - 1, Math.floor(x / cbHscale));
          const cy = Math.min(mcuRows * components[1]!.v * 8 - 1, Math.floor(y / cbVscale));
          const Cb = cbPlane[cy * cbW + cx] ?? 128;
          const Cr = crPlane[cy * crW + cx] ?? 128;
          r = clamp(Y + 1.402 * (Cr - 128));
          g = clamp(Y - 0.344136 * (Cb - 128) - 0.714136 * (Cr - 128));
          b = clamp(Y + 1.772 * (Cb - 128));
        } else {
          r = g = b = clamp(Y);
        }
        const o = (y * width + x) * 4;
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        rgba[o + 3] = 255;
      }
    }
    return { ok: true, width, height, rgba };
  } catch (e) {
    return {
      ok: false,
      code: 'JPEG_DECODE_ERROR',
      message: e instanceof Error ? e.message : 'jpeg decode failed',
    };
  }
}
