/** Decodes an IEEE 754 half-precision value (as read back from rgba16float textures). */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return sign * 2 ** -14 * (f / 1024);
  if (e === 31) return f ? NaN : sign * Infinity;
  return sign * 2 ** (e - 15) * (1 + f / 1024);
}

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** Encodes a number as half precision (round to nearest; for writing rgba16float textures). */
export function floatToHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 127 + 15;
  let m = x & 0x7fffff;
  if (e >= 31) return sign | 0x7c00; // too big: infinity
  if (e <= 0) {
    if (e < -10) return sign; // too small: zero
    m = (m | 0x800000) >> (1 - e);
    return sign | ((m + 0x1000) >> 13);
  }
  return sign | (e << 10) | ((m + 0x1000) >> 13);
}
