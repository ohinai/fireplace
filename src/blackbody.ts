// Blackbody colour table: Planck's law integrated against the CIE 1931 colour matching
// functions, converted to linear sRGB. Normalised so a 1500 K emitter has luminance 1.
// The shaders index it as T in [BB_T_MIN, BB_T_MAX] over BB_SIZE entries.

export const BB_SIZE = 512;
export const BB_T_MIN = 400;
export const BB_T_MAX = 2400;

// Wyman, Sloan & Shirley 2013, multi-lobe fit of the CIE 1931 2-degree observer.
function lobe(x: number, mu: number, s1: number, s2: number): number {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cieX(l: number) {
  return 1.056 * lobe(l, 599.8, 37.9, 31.0) + 0.362 * lobe(l, 442.0, 16.0, 26.7) - 0.065 * lobe(l, 501.1, 20.4, 26.2);
}
function cieY(l: number) {
  return 0.821 * lobe(l, 568.8, 46.9, 40.5) + 0.286 * lobe(l, 530.9, 16.3, 31.1);
}
function cieZ(l: number) {
  return 1.217 * lobe(l, 437.0, 11.8, 36.0) + 0.681 * lobe(l, 459.0, 26.0, 13.8);
}

function planck(lambdaNm: number, T: number): number {
  const l = lambdaNm * 1e-9;
  const c1 = 1.191042972e-16; // 2hc^2
  const c2 = 1.438776877e-2; // hc/k
  return c1 / (l ** 5 * (Math.exp(c2 / (l * T)) - 1));
}

function blackbodyXYZ(T: number): [number, number, number] {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 2) {
    const b = planck(l, T);
    X += b * cieX(l);
    Y += b * cieY(l);
    Z += b * cieZ(l);
  }
  return [X, Y, Z];
}

export function buildBlackbodyTable(): Float32Array {
  const out = new Float32Array(BB_SIZE * 4);
  const ref = blackbodyXYZ(1500)[1];
  for (let i = 0; i < BB_SIZE; i++) {
    const T = BB_T_MIN + ((BB_T_MAX - BB_T_MIN) * i) / (BB_SIZE - 1);
    const [X, Y, Z] = blackbodyXYZ(T).map((v) => v / ref);
    const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z;
    const g = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
    const b = 0.0557 * X - 0.204 * Y + 1.057 * Z;
    out.set([Math.max(r, 0), Math.max(g, 0), Math.max(b, 0), Y], i * 4);
  }
  return out;
}
