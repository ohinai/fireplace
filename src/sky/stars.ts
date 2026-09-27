// The naked-eye star catalogue (src/sky/stars.bin, built by tools/build-stars.mjs from the Yale
// Bright Star Catalogue) and the colours of stars.

import type { Vec3 } from '../math';

/** Stars sorted brightest first. Positions are J2000 (radians) at epoch 2026.0. */
export interface StarCatalogue {
  count: number;
  ra: Float32Array;
  dec: Float32Array;
  vmag: Float32Array;
  bv: Float32Array;
  hr: Uint16Array;
}

/** Reads stars.bin: uint32 count, then float32 ra[], float32 dec[], int16 V x 100, int16 (B-V) x 100, uint16 HR (little-endian). */
export function parseStars(buf: ArrayBuffer): StarCatalogue {
  const view = new DataView(buf);
  const count = view.getUint32(0, true);
  if (buf.byteLength !== 4 + 14 * count) throw new Error(`stars.bin: ${buf.byteLength} bytes for ${count} stars`);
  const ra = new Float32Array(count);
  const dec = new Float32Array(count);
  const vmag = new Float32Array(count);
  const bv = new Float32Array(count);
  const hr = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    ra[i] = view.getFloat32(4 + 4 * i, true);
    dec[i] = view.getFloat32(4 + 4 * count + 4 * i, true);
    vmag[i] = view.getInt16(4 + 8 * count + 2 * i, true) / 100;
    bv[i] = view.getInt16(4 + 10 * count + 2 * i, true) / 100;
    hr[i] = view.getUint16(4 + 12 * count + 2 * i, true);
  }
  return { count, ra, dec, vmag, bv, hr };
}

/** Effective temperature (K) from the B-V colour index (Ballesteros 2012), for B-V in -0.4..2. */
export function starTemperature(bv: number): number {
  const b = Math.min(Math.max(bv, -0.4), 2);
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/**
 * Suggested saturation for starColour. Starlight is too dim for the eye's colour vision to work
 * well, so only the brightest stars look faintly tinted (orange Betelgeuse, blue-white Rigel);
 * full blackbody colour looks garish. Fainter stars can be taken further toward white.
 */
export const STAR_SATURATION = 0.5;

/**
 * Linear sRGB colour of luminance 1 for a star of this B-V: the colour of a blackbody at the
 * star's temperature, blended toward white by `saturation` (1 = the physical colour).
 */
export function starColour(bv: number, saturation = 1): Vec3 {
  const T = Math.min(Math.max(starTemperature(bv), 1667), 25000);
  // Chromaticity of the Planckian locus (Kim et al. 2002 cubic fit).
  const k = 1000 / T;
  const x = T <= 4000
    ? ((-0.2661239 * k - 0.2343589) * k + 0.8776956) * k + 0.17991
    : ((-3.0258469 * k + 2.1070379) * k + 0.2226347) * k + 0.24039;
  const y = T <= 2222
    ? ((-1.1063814 * x - 1.3481102) * x + 2.18555832) * x - 0.20219683
    : T <= 4000
      ? ((-0.9549476 * x - 1.37418593) * x + 2.09137015) * x - 0.16748867
      : ((3.081758 * x - 5.8733867) * x + 3.75112997) * x - 0.37001483;
  // CIE XYZ with Y = 1, then linear sRGB (D65 white).
  const X = x / y;
  const Z = (1 - x - y) / y;
  const rgb = [
    3.2404542 * X - 1.5371385 - 0.4985314 * Z,
    -0.969266 * X + 1.8760108 + 0.041556 * Z,
    0.0556434 * X - 0.2040259 + 1.0572252 * Z,
  ];
  return rgb.map((c) => Math.max(0, 1 + saturation * (c - 1))) as Vec3;
}
