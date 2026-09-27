import { AMBIENT_TEMP, BED_HEIGHT } from '../config';
import { floatToHalf } from '../half';
import type { Vec3 } from '../math';
import type { Rect } from '../rooms';

/** Cells across and along the bed (and texels of the bed map). */
export const BED_N = 32;

const SIGMA = 5.67e-8;
const EPS = 0.9;
const FULL = 6.9; // kg/m2: a full bed of coals, a couple of centimetres deep
const BURN = 0.0003; // 1/s: share of hot coals that burn away each second (in still air)
const SELF = 730; // K a deep bed holds itself above the room: it is its own insulation
const CO_RATE = 0.06; // CO a deep, hot bed gives off (cell volumes per second, see forces.wgsl)
const LIGHT = 0.3; // share of the coals' glow that gets out into the room
const BLOW_RADIUS = 0.07; // m
const SLUMP = 240; // s for a heap of coals to settle halfway flat
const SPREAD = 40; // s for heat to even out between neighbouring coals
const ASH_TIME = 150; // s for glowing coals left alone to skin over with ash
// Under a skin of ash coals burn slower and radiate at the ash's cooler surface.
export const ASH_SLOWS = 0.55;
export const ASH_COOLS = 0.18;

/** Where a blackbody table (see blackbody.ts) is sampled, as in the shaders. */
function blackbody(table: Float32Array, T: number, out: number[]) {
  const x = Math.min(Math.max((T - 400) / 2000, 0), 1) * 511;
  const i = Math.floor(x);
  const j = Math.min(i + 1, 511);
  const f = x - i;
  for (let c = 0; c < 3; c++) out[c] = table[i * 4 + c] * (1 - f) + table[j * 4 + c] * f;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/**
 * The bed of coals under the fire, cell by cell. Glowing char flakes off the logs and lands
 * right below where it was; a stub that burns down collapses in place. So coals build up
 * under the part of the fire that is burning, not everywhere at once. Each cell of coals:
 *  - burns away with the air that reaches it (faster when blown on),
 *  - holds itself hot if there is a deep enough heap of it,
 *  - is heated from above by burning logs and flames, and cools when they move away,
 *  - trades heat with its neighbours, and slowly slumps flat,
 *  - skins over with ash if left alone, which slows its burning and dims its glow (blowing on it
 *    or raking it clears the ash and it flares up again).
 * The bare hearth (or ground) warms slowly under a fire too. All in the logs' (time-lapsed) time.
 */
export class CoalBed {
  readonly mass = new Float32Array(BED_N * BED_N); // kg per cell
  readonly temp = new Float32Array(BED_N * BED_N); // K
  readonly flare = new Float32Array(BED_N * BED_N); // K brighter while blown on or stirred
  readonly deposit = new Float32Array(BED_N * BED_N); // kg/s landing from glowing logs above
  readonly heat = new Float32Array(BED_N * BED_N); // W/m2 arriving from logs and flames above
  readonly ash = new Float32Array(BED_N * BED_N); // 0..1 how much of the coals ash covers
  private readonly blowing = new Float32Array(BED_N * BED_N); // 0..1
  private readonly scratch = new Float32Array(BED_N * BED_N);
  private readonly halves = new Uint16Array(BED_N * BED_N * 4);
  private readonly bb: Float32Array;
  private cellArea = 1;
  private dx = 1;
  private dz = 1;

  constructor(
    public rect: Rect,
    blackbodyTable: Float32Array,
  ) {
    this.bb = blackbodyTable;
    this.setRect(rect);
  }

  setRect(rect: Rect) {
    this.rect = rect;
    this.dx = (rect.maxX - rect.minX) / BED_N;
    this.dz = (rect.maxZ - rect.minZ) / BED_N;
    this.cellArea = this.dx * this.dz;
  }

  /**
   * Coals over the whole bed (kg/m2), thinning out toward its edges (or a round heap), with a
   * skin of ash over the given share of them.
   */
  fill(kgPerM2: number, T: number, floorT: number, round: boolean, ash = 0) {
    const r = this.rect;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    const rOut = Math.min(r.maxX - r.minX, r.maxZ - r.minZ) * 0.42;
    for (let j = 0; j < BED_N; j++) {
      for (let i = 0; i < BED_N; i++) {
        const [x, z] = this.centre(i, j);
        const w = round
          ? smoothstep(rOut, rOut - 0.09, Math.hypot(x - cx, z - cz))
          : smoothstep(-0.01, 0.05, Math.min(x - r.minX, r.maxX - x, z - r.minZ, r.maxZ - z));
        const k = j * BED_N + i;
        this.mass[k] = kgPerM2 * w * this.cellArea;
        this.temp[k] = floorT + (T - floorT) * Math.min(w * 1.5, 1);
        this.ash[k] = ash * w;
      }
    }
    this.flare.fill(0);
    this.deposit.fill(0);
    this.heat.fill(0);
    this.blowing.fill(0);
  }

  centre(i: number, j: number): [number, number] {
    return [this.rect.minX + (i + 0.5) * this.dx, this.rect.minZ + (j + 0.5) * this.dz];
  }

  /** Cell under (x, z), or -1 if that is off the bed. */
  cellAt(x: number, z: number): number {
    const i = Math.floor((x - this.rect.minX) / this.dx);
    const j = Math.floor((z - this.rect.minZ) / this.dz);
    return i < 0 || j < 0 || i >= BED_N || j >= BED_N ? -1 : j * BED_N + i;
  }

  /** Spreads `amount` over the cells around (x, z) within `radius` (into `into`: mass or deposit). */
  splat(into: Float32Array, x: number, z: number, amount: number, radius: number) {
    const ri = Math.ceil(radius / this.dx);
    const rj = Math.ceil(radius / this.dz);
    const ci = Math.floor((x - this.rect.minX) / this.dx);
    const cj = Math.floor((z - this.rect.minZ) / this.dz);
    let total = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let j = cj - rj; j <= cj + rj; j++) {
        for (let i = ci - ri; i <= ci + ri; i++) {
          if (i < 0 || j < 0 || i >= BED_N || j >= BED_N) continue;
          const [px, pz] = this.centre(i, j);
          const d2 = ((px - x) ** 2 + (pz - z) ** 2) / (radius * radius);
          if (d2 > 1) continue;
          const w = 1 - d2;
          if (pass === 0) total += w;
          else into[j * BED_N + i] += (amount * w) / total;
        }
      }
      if (total <= 0) {
        // Too small to cover a cell centre: all of it into the cell underneath.
        const k = this.cellAt(x, z);
        if (k >= 0) into[k] += amount;
        return;
      }
    }
  }

  /** What is left of a log (kg of char) collapsing along its length, from a to b. */
  collapse(a: Vec3, b: Vec3, kg: number) {
    const steps = 8;
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      this.splat(this.mass, a[0] + (b[0] - a[0]) * t, a[2] + (b[2] - a[2]) * t, kg / steps, 0.05);
    }
  }

  /** Someone is blowing on the coals at (x, z), or stirring them there (0..1). */
  blowAt(x: number, z: number, strength: number) {
    for (let j = 0; j < BED_N; j++) {
      for (let i = 0; i < BED_N; i++) {
        const [px, pz] = this.centre(i, j);
        const w = strength * Math.exp(-((px - x) ** 2 + (pz - z) ** 2) / (BLOW_RADIUS * BLOW_RADIUS));
        const k = j * BED_N + i;
        if (w > this.blowing[k]) this.blowing[k] = w;
      }
    }
  }

  /** Raking coals at (x, z) spreads them about a little. */
  stirAt(x: number, z: number, amount: number) {
    const k = this.cellAt(x, z);
    if (k < 0) return;
    const i = k % BED_N;
    const j = Math.floor(k / BED_N);
    const share = this.mass[k] * 0.3 * Math.min(amount, 1);
    // Raking knocks the ash off the coals round about.
    for (let dj = -2; dj <= 2; dj++) {
      for (let di = -2; di <= 2; di++) {
        if (i + di >= 0 && i + di < BED_N && j + dj >= 0 && j + dj < BED_N) this.ash[(j + dj) * BED_N + i + di] *= 1 - Math.min(amount * 2, 0.9);
      }
    }
    let n = 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      if (i + di >= 0 && i + di < BED_N && j + dj >= 0 && j + dj < BED_N) n++;
    }
    if (!n) return;
    this.mass[k] -= share;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      if (i + di >= 0 && i + di < BED_N && j + dj >= 0 && j + dj < BED_N) this.mass[(j + dj) * BED_N + i + di] += share / n;
    }
  }

  /**
   * Advances the bed. dtLog: time-lapsed seconds (for burning and heating); dtReal: real seconds
   * (for flaring up when blown on). envTemp: what the bed sees above it besides the fire (the
   * firebox walls, or the night sky).
   */
  update(dtLog: number, dtReal: number, envTemp: number) {
    const Ta = AMBIENT_TEMP;
    const Ta4 = Ta ** 4;
    const env = Math.max(envTemp ** 4 - Ta4, 0) * 0.5;
    const n = BED_N * BED_N;
    for (let k = 0; k < n; k++) {
      const m = this.mass[k];
      const sigma = m / this.cellArea;
      const cover = smoothstep(0.02, 1.5, sigma);
      const T = this.temp[k];
      const blow = this.blowing[k];
      const hot = smoothstep(650, 950, T + this.flare[k]);
      const ash = this.ash[k];
      const burn = m * BURN * hot * (1 + 2 * blow) * (1 - ASH_SLOWS * ash);
      const fresh = this.deposit[k] * dtLog;
      this.mass[k] = Math.max(0, m + fresh - burn * dtLog);
      // Burning coals skin over with ash; fresh glowing char landing on them, or a draught
      // (someone blowing), leaves them bare again.
      let a = ash + (1 - ash) * hot * (1 - Math.exp(-dtLog / ASH_TIME));
      a *= m / Math.max(m + fresh, 1e-9);
      a *= Math.exp(-dtReal * 3 * blow);
      this.ash[k] = sigma > 0.02 ? a : 0;
      const self = Ta + SELF * smoothstep(0.3, 4, sigma);
      const rad4 = Ta4 + this.heat[k] / (EPS * SIGMA) + env;
      const target = Math.max(self ** 4 + rad4 - Ta4, Ta4) ** 0.25;
      const tau = 25 + 275 * (1 - cover);
      this.temp[k] = T + (target - T) * (1 - Math.exp(-dtLog / tau));
      // Blown-on coals flare up within a moment and fade over a couple of seconds.
      const wanted = 230 * blow * smoothstep(500, 800, T) * cover * (1 - 0.5 * ash);
      const f = this.flare[k];
      this.flare[k] = f + (wanted - f) * (1 - Math.exp(-dtReal / (wanted > f ? 0.4 : 2)));
      this.blowing[k] = blow * Math.exp(-dtReal / 0.2);
    }
    // Neighbouring coals even out their heat; heaps slump flat.
    this.diffuse(this.temp, dtLog / SPREAD, true);
    this.diffuse(this.mass, dtLog / SLUMP, false);
  }

  /**
   * One explicit smoothing step toward the four neighbours. Heat flows only between coals;
   * coals only slide off a heap (thin layers stay put).
   */
  private diffuse(field: Float32Array, rate: number, heat: boolean) {
    const k0 = Math.min(rate, 0.2);
    if (k0 <= 0) return;
    const out = this.scratch;
    const density = (k: number) => this.mass[k] / this.cellArea;
    for (let j = 0; j < BED_N; j++) {
      for (let i = 0; i < BED_N; i++) {
        const k = j * BED_N + i;
        let d = 0;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ii = i + di;
          const jj = j + dj;
          if (ii < 0 || jj < 0 || ii >= BED_N || jj >= BED_N) continue;
          const q = jj * BED_N + ii;
          const w = heat
            ? smoothstep(0.02, 1.5, density(k)) * smoothstep(0.02, 1.5, density(q))
            : smoothstep(0.5 * FULL, 1.5 * FULL, Math.max(density(k), density(q)));
          d += w * (field[q] - field[k]);
        }
        out[k] = field[k] + k0 * d;
      }
    }
    field.set(out);
  }

  /** kg of coals in the bed. */
  get totalMass(): number {
    let s = 0;
    for (const m of this.mass) s += m;
    return s;
  }

  /** How brightly the bed glows overall (0..1; 1 = a fireplace's full bed glowing orange). */
  get glow(): number {
    let s = 0;
    for (let k = 0; k < this.mass.length; k++) {
      s += smoothstep(0.02, 1.5, this.mass[k] / this.cellArea) * Math.min(Math.max((this.temp[k] + this.flare[k] - 700) / 400, 0), 1) * (1 - 0.6 * this.ash[k]);
    }
    return Math.min((s * this.cellArea) / 0.12, 1);
  }

  /** Temperature of the glowing part of the bed (for the stats line), or null if nothing glows. */
  get glowTemp(): number | null {
    let s = 0;
    let w = 0;
    for (let k = 0; k < this.mass.length; k++) {
      const c = smoothstep(0.02, 1.5, this.mass[k] / this.cellArea);
      s += c * (this.temp[k] + this.flare[k]);
      w += c;
    }
    return w > 1 ? s / w : null;
  }

  /**
   * The bed map for the GPU (rgba16float, BED_N x BED_N): r = temperature of the coals (or the
   * bare hearth), g = CO they give off (cell volumes per second), b = depth (1 = a full bed),
   * a = ash over them (0..1). Coal cover follows from depth: see coalCover in the shaders.
   */
  mapData(): Uint16Array {
    const out = this.halves;
    for (let k = 0; k < this.mass.length; k++) {
      const sigma = this.mass[k] / this.cellArea;
      const T = this.temp[k] + this.flare[k];
      const co = CO_RATE * smoothstep(750, 1050, T) * Math.min(sigma / 4, 1) * (1 + this.blowing[k]) * (1 - ASH_SLOWS * this.ash[k]);
      out[k * 4] = floatToHalf(T);
      out[k * 4 + 1] = floatToHalf(co);
      out[k * 4 + 2] = floatToHalf(Math.min(sigma / FULL, 1.6));
      out[k * 4 + 3] = floatToHalf(this.ash[k]);
    }
    return out;
  }

  /**
   * Three lights standing in for the glowing bed (left, middle, right thirds): position and
   * colour each, in the units of the fire's lights. glowBoost: K added for display.
   */
  lights(glowBoost: number, lightGain: number): Float32Array {
    const out = new Float32Array(24);
    const c = [0, 0, 0];
    for (let band = 0; band < 3; band++) {
      let r = 0, g = 0, b = 0, px = 0, pz = 0, wsum = 0;
      for (let j = 0; j < BED_N; j++) {
        for (let i = Math.floor((band * BED_N) / 3); i < Math.floor(((band + 1) * BED_N) / 3); i++) {
          const k = j * BED_N + i;
          const cover = smoothstep(0.02, 1.5, this.mass[k] / this.cellArea);
          const T = this.temp[k] + this.flare[k];
          if (cover <= 0 || T < 650) continue;
          blackbody(this.bb, T + glowBoost, c);
          const s = this.cellArea * cover * LIGHT * lightGain * (1 - 0.7 * this.ash[k]);
          const lum = (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) * s;
          r += c[0] * s;
          g += c[1] * s;
          b += c[2] * s;
          const [x, z] = this.centre(i, j);
          px += x * lum;
          pz += z * lum;
          wsum += lum;
        }
      }
      const [cx, cz] = wsum > 0 ? [px / wsum, pz / wsum] : this.centre(Math.floor(((band + 0.5) * BED_N) / 3), BED_N / 2);
      out.set([cx, BED_HEIGHT + 0.005, cz, 1, r, g, b, 0], band * 8);
    }
    return out;
  }
}
