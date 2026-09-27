import { length, sub, type Vec3 } from '../math';
import type { LogSystem } from './LogSystem';

// A kettle of water set down by the fire, heating: from the embers under it or beside it (their
// glow) and the flames (their radiation), losing heat to the air from its sides. It boils at the
// boiling point for the height above the sea, and then the heat going in drives off steam instead
// of warming it further, until it boils dry.

const WATER = 0.55; // kg: a small kettle
const WATER_HEAT = 4186; // J/kg/K
const STEEL = 0.45 * 470; // J/K: the kettle itself
const LATENT = 2.26e6; // J/kg to boil water off
const SIGMA = 5.67e-8;
const BASE = Math.PI * 0.062 * 0.062; // m2 standing on the embers
const SIDE = 0.12 * 0.13; // m2 facing the fire
const SKIN = 0.065; // m2 losing heat to the air
const SOOT = 0.9; // how much of the fire's radiation its blackened side soaks up

export class Kettle {
  water = WATER;
  temp = 293; // K
  /** Steam leaving its spout (kg/s): a trickle as it gets hot, a plume once it boils. */
  steam = 0;
  /** How hard it is boiling (0: not, 1: a rolling boil). */
  boil = 0;
  readonly boilingPoint: number; // K

  constructor(
    readonly at: Vec3,
    altitude: number,
    private readonly fire: Vec3, // (the middle of the fire, on the floor)
  ) {
    // About a degree lower for every 300 m up.
    this.boilingPoint = 373.15 - altitude / 300;
  }

  reset(airTemp: number) {
    this.water = WATER;
    this.temp = airTemp + 5;
    this.steam = 0;
    this.boil = 0;
  }

  /** Heat reaching it from the fire now (W). */
  heatIn(logs: LogSystem): number {
    let q = 0;
    // The embers: under it, or raked up against the side that faces the fire.
    const bed = logs.bed;
    const [dx, dz] = [this.at[0] - this.fire[0], this.at[2] - this.fire[2]];
    const toFire = Math.hypot(dx, dz) || 1;
    for (const [reach, share] of [[0, 1], [0.1, 0.5]]) {
      const cell = bed.cellAt(this.at[0] - (dx / toFire) * reach, this.at[2] - (dz / toFire) * reach);
      if (cell < 0 || bed.mass[cell] < 0.0002) continue;
      const T = bed.temp[cell];
      q += share * 0.9 * SIGMA * Math.max(T ** 4 - this.temp ** 4, 0) * BASE;
      break;
    }
    // The flames' radiation (each block of flame radiates its power in all directions).
    const flames = logs.flames;
    if (flames) {
      for (let i = 0; i + 3 < flames.length; i += 4) {
        const d = length(sub([flames[i], flames[i + 1], flames[i + 2]], [this.at[0], this.at[1] + 0.07, this.at[2]]));
        q += (SOOT * flames[i + 3] * SIDE) / (4 * Math.PI * Math.max(d * d, 0.01));
      }
    }
    return q;
  }

  /** Advances it by dt seconds with heat q (W) coming in and the air at airTemp (K). */
  step(dt: number, q: number, airTemp: number) {
    const T = this.temp;
    const loss = (10 * (T - airTemp) + 0.85 * SIGMA * (T ** 4 - airTemp ** 4)) * SKIN;
    const net = q - loss;
    const capacity = this.water * WATER_HEAT + STEEL;
    if (this.water > 0.01 && T >= this.boilingPoint - 0.05 && net > 0) {
      // Boiling: the heat goes into steam.
      this.steam = net / LATENT;
      this.water = Math.max(0, this.water - this.steam * dt);
      this.temp = this.boilingPoint;
      this.boil = Math.min(1, net / 350);
      return;
    }
    this.temp = Math.min(T + (net * dt) / capacity, this.water > 0.01 ? this.boilingPoint : 600);
    // Below the boil a little water still steams off the hot surface inside.
    this.steam = this.water > 0.01 ? 3e-6 * Math.exp((this.temp - 373) / 11) : 0;
    this.boil = 0;
  }

  /** How close to boiling it is (0 cold .. 1 at the boil), for its sound. */
  get warmth(): number {
    return Math.min(1, Math.max(0, (this.temp - 330) / (this.boilingPoint - 330)));
  }
}
