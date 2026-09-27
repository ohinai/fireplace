import type { Vec3 } from './math';
import type { Place } from './sky/astro';

// Where the fire is. The two fireplaces share the firebox (its splayed walls, depth and throat);
// what differs is the opening in front of it, what the logs rest on, the wood that is to hand,
// and everything around it. The campfire burns in the open, in a ring of stones.

export type RoomKey = 'brick' | 'hacienda' | 'campfire' | 'desert';
/** What lives round an outdoor fire (for its creatures and its sounds). */
export type Wild = 'woods' | 'desert';
export type Support = 'grate' | 'andirons' | 'ground';
/** A fireplace (a firebox behind an opening, a chimney above) or a fire in the open air. */
export type Enclosure = 'firebox' | 'open';

/** The opening into the firebox: straight sides up to `spring`, then an arch up to `apex`. */
export interface Opening {
  halfWidth: number;
  spring: number;
  apex: number; // equal to spring for a flat lintel
}

/**
 * A way of looking at the fire. 'orbit' circles `target` at `distance`, `yaw` round from the
 * front (+z) and `pitch` up: the usual way, looking at the fire. 'look' stands at `target` and
 * looks `yaw` round from -z (north, outdoors), turning left, and `pitch` up: for the sky.
 */
export interface CameraView {
  key: string;
  label: string;
  kind: 'orbit' | 'look';
  target: Vec3;
  yaw: number;
  pitch: number;
  distance: number; // (orbit)
  fov?: number; // degrees (38 unless given)
}

const orbit = (key: string, label: string, target: Vec3, distance: number, yaw: number, pitch: number, fov?: number): CameraView =>
  ({ key, label, kind: 'orbit', target, distance, yaw, pitch, fov });
const look = (key: string, label: string, at: Vec3, yaw: number, pitch: number, fov: number): CameraView =>
  ({ key, label, kind: 'look', target: at, distance: 0, yaw, pitch, fov });

/** An area of floor (in x and z). */
export interface Rect {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** A lamp: where its bulb (or flame) is and what light it gives. */
export interface Lamp {
  pos: Vec3;
  kind: 'shade' | 'lantern'; // a fabric shade, open top and bottom; or glass under a metal cap
  temp: number; // colour temperature (K)
  power: number; // brightness when fully on (in the units of the fire's lights)
}

export interface Room {
  key: RoomKey;
  label: string;
  /** Ways of looking at it (the camera starts in the first). */
  views: CameraView[];
  frameWidth: number; // m either side of the fire that should stay in view on narrow screens
  /** How far one can look around: yaw either side (radians; Infinity = all the way), pitch range, distance range. */
  orbit: { yaw: number; pitch: [number, number]; zoom: [number, number] };
  bounce: number; // how much light the room's walls, floor and ceiling bounce back (pale rooms more)
  enclosure: Enclosure;
  opening: Opening; // (fireplaces only)
  support: Support;
  domain: { min: Vec3; size: Vec3 }; // where the air and flames are simulated
  bed: Rect & { round: boolean }; // where coals collect (round: a heap in a fire pit)
  /** Stones round a campfire (centre at x = z = 0): inner and outer radius and height of the ring (m). */
  ring: { inner: number; outer: number; height: number } | null;
  pit?: number; // a fire in the open with no stones round it: how far out its sticks can go (m)
  /**
   * Where a kettle can be set down by the fire (its foot at `at`, its spout turned by `yaw`), if
   * one can; on a trivet (in a fireplace, beside the logs), or on the embers.
   */
  kettle: { at: Vec3; yaw: number; trivet?: boolean } | null;
  woods: string[]; // what you can put on (the first is the default)
  startWoods: string[]; // the fire you start with
  candles: Vec3[]; // candle flames (their base); at most three
  lamps: Lamp[]; // at most two
  wild: Wild | null; // out in the open: what lives round it
  /** Out in the open: where on Earth (for the stars), how high (m, for boiling water), how big the dome of the sky is. */
  sky: { place: Place; altitude: number; radius: number } | null;
}

/** A mountain meadow in the Cascades, about 28 km south of Mount Rainier, 1100 m up. */
const CASCADES: Place = { lat: 46.6, lon: -121.71 };

// The part of the firebox where flames live: its back face is the back wall, its bottom the
// hearth, its front face just short of the opening, its top the throat to the flue.
const FIREBOX_DOMAIN = { min: [-0.36, 0, -0.42] as Vec3, size: [0.72, 0.81, 0.36] as Vec3 };
// Bed of coals on the hearth under the grate.
const FIREBOX_BED = { minX: -0.26, maxX: 0.26, minZ: -0.36, maxZ: -0.08, round: false };
const CAMPFIRE_RING = { inner: 0.31, outer: 0.47, height: 0.11 };
const FIREPLACE_ORBIT = { yaw: 0.75, pitch: [-0.05, 0.5] as [number, number], zoom: [0.8, 3.2] as [number, number] };

export const ROOMS: Record<RoomKey, Room> = {
  brick: {
    key: 'brick',
    label: 'Brick hearth',
    views: [
      orbit('front', 'In front', [0, 0.3, -0.18], 1.75, 0, 0.14),
      orbit('close', 'Close up', [0, 0.2, -0.2], 0.95, 0, 0.12),
      orbit('low', 'Hearth level', [0, 0.24, -0.2], 1.3, 0.1, 0.0),
      orbit('chair', 'From the armchair', [0.05, 0.42, -0.12], 2.75, -0.62, 0.2),
      orbit('room', 'The room', [0, 0.75, 0], 3.6, 0.28, 0.08, 46),
    ],
    frameWidth: 0.5,
    orbit: FIREPLACE_ORBIT,
    bounce: 1.15,
    enclosure: 'firebox',
    opening: { halfWidth: 0.42, spring: 0.66, apex: 0.66 },
    support: 'grate',
    domain: FIREBOX_DOMAIN,
    bed: FIREBOX_BED,
    ring: null,
    woods: ['oak', 'birch', 'pine', 'damp', 'kindling'],
    startWoods: ['oak', 'oak', 'birch'],
    // Pillar candles on the hearth; brass wall lights either side of the fireplace.
    candles: [
      [0.575, 0.124, 0.15],
      [0.655, 0.092, 0.225],
      [0.555, 0.068, 0.28],
    ],
    lamps: [
      { pos: [-0.64, 0.735, 0.085], kind: 'shade', temp: 2700, power: 2.2e-4 },
      { pos: [0.64, 0.735, 0.085], kind: 'shade', temp: 2700, power: 2.2e-4 },
    ],
    sky: null,
    // On a trivet inside the firebox, beside the grate, its spout toward the room.
    kettle: { at: [0.305, 0.045, -0.12], yaw: 0.5, trivet: true },
    wild: null,
  },
  // A Spanish hacienda: a whitewashed chimney breast with an arched opening framed in
  // Talavera tiles, a raised tiled hearth, iron andirons, and holm oak and olive to burn.
  hacienda: {
    key: 'hacienda',
    label: 'Hacienda',
    views: [
      orbit('front', 'In front', [0, 0.36, -0.08], 2.25, 0, 0.14),
      orbit('close', 'Close up', [0, 0.2, -0.2], 1.0, 0, 0.12),
      orbit('low', 'Hearth level', [0, 0.26, -0.2], 1.4, -0.1, 0.0),
      orbit('chair', 'From the chair', [0, 0.4, -0.05], 2.8, 0.62, 0.17),
      orbit('room', 'The room', [0, 0.85, 0.2], 4.0, -0.3, 0.05, 48),
    ],
    frameWidth: 0.62,
    orbit: FIREPLACE_ORBIT,
    bounce: 2.6,
    enclosure: 'firebox',
    opening: { halfWidth: 0.42, spring: 0.46, apex: 0.72 },
    support: 'andirons',
    domain: FIREBOX_DOMAIN,
    bed: FIREBOX_BED,
    ring: null,
    woods: ['encina', 'olivo', 'mesquite', 'pinon', 'damp', 'kindling'],
    startWoods: ['encina', 'encina', 'olivo'],
    // On the hearth, and in a niche in the wall (see hacienda.ts).
    candles: [
      [-0.47, 0.121, 0.36],
      [0.52, 0.091, 0.4],
      [-1.94, 1.03, -0.39],
    ],
    // Wrought-iron lanterns (faroles) on the chimney breast.
    lamps: [
      { pos: [-0.665, 0.5, 0.1], kind: 'lantern', temp: 2300, power: 1.8e-4 },
      { pos: [0.665, 0.5, 0.1], kind: 'lantern', temp: 2300, power: 1.8e-4 },
    ],
    sky: null,
    // On a trivet inside the firebox, beside the andirons.
    kettle: { at: [-0.305, 0.045, -0.12], yaw: -0.5, trivet: true },
    wild: null,
  },
  // A campfire in a mountain meadow in the Cascades, Mount Rainier on the horizon: logs stood up
  // in a teepee in a ring of stones, a log to sit on, a lantern on a stump.
  campfire: {
    key: 'campfire',
    label: 'Campfire',
    views: [
      orbit('fire', 'By the fire', [0, 0.25, 0], 2.2, 0, 0.19),
      orbit('close', 'Close up', [0, 0.2, 0], 1.1, 0.3, 0.3),
      orbit('bench', 'On the log', [0, 0.2, 0], 1.45, Math.PI, 0.55),
      orbit('meadow', 'The meadow', [0, 0.8, 0], 6.5, 0.45, 0.14, 55),
      look('stars', 'Stargazing', [0.3, 0.6, 1.2], Math.PI, 1.0, 70),
    ],
    frameWidth: 0.8,
    orbit: { yaw: Infinity, pitch: [0.02, 1.1], zoom: [0.8, 6] },
    bounce: 0.8,
    enclosure: 'open',
    opening: { halfWidth: 0, spring: 0, apex: 0 },
    support: 'ground',
    domain: { min: [-0.32, 0, -0.32], size: [0.64, 0.86, 0.64] },
    bed: { minX: -0.26, maxX: 0.26, minZ: -0.26, maxZ: 0.26, round: true },
    ring: CAMPFIRE_RING,
    woods: ['birch', 'oak', 'pine', 'damp', 'kindling'],
    startWoods: ['birch', 'oak', 'birch', 'oak', 'pine'],
    // Tea lights in jars on the log bench; a hurricane lantern on the stump.
    candles: [
      [0.1, 0.383, -1.152],
      [0.32, 0.383, -1.162],
    ],
    lamps: [{ pos: [-0.86, 0.515, -0.32], kind: 'lantern', temp: 2100, power: 3e-4 }],
    sky: { place: CASCADES, altitude: 1100, radius: 170 },
    // On the edge of the embers, between two of the teepee's legs.
    kettle: { at: [0.16, 0.006, 0.172], yaw: -0.25 },
    wild: 'woods',
  },
  // A Bedouin camp in the dunes of the Sahara: a small fire of twisted desert wood on the sand,
  // sticks pushed in from all round like the points of a star, a rug and cushions beside it, a
  // tent of black goat hair behind, a kettle to set on the embers, and the whole sky overhead.
  desert: {
    key: 'desert',
    label: 'Desert camp',
    views: [
      orbit('fire', 'By the fire', [0, 0.2, 0], 2.1, 0.25, 0.2),
      orbit('close', 'Close up', [0, 0.12, 0], 1.0, 0.45, 0.32),
      orbit('rug', 'On the rug', [0, 0.15, 0], 1.25, 1.35, 0.42),
      orbit('tent', 'From the tent', [0, 0.35, 0], 4.0, Math.PI, 0.08, 55),
      orbit('dunes', 'The dunes', [0, 0.9, 0], 8.0, 0.5, 0.1, 50),
      look('stars', 'Stargazing', [0.7, 0.45, 0.8], Math.PI, 0.95, 80),
    ],
    frameWidth: 0.7,
    orbit: { yaw: Infinity, pitch: [0.02, 1.1], zoom: [0.8, 10] },
    bounce: 0.9,
    enclosure: 'open',
    opening: { halfWidth: 0, spring: 0, apex: 0 },
    support: 'ground',
    domain: { min: [-0.38, 0, -0.38], size: [0.76, 0.8, 0.76] },
    bed: { minX: -0.22, maxX: 0.22, minZ: -0.22, maxZ: 0.22, round: true },
    ring: null,
    pit: 0.5,
    woods: ['acacia', 'tamarisk', 'ghada', 'kindling'],
    startWoods: ['acacia', 'tamarisk', 'ghada', 'acacia', 'tamarisk', 'acacia'],
    candles: [],
    // A lantern hanging from the front pole of the tent.
    lamps: [{ pos: [-0.733, 1.23, -2.25], kind: 'lantern', temp: 2000, power: 2.5e-4 }],
    sky: { place: { lat: 31.1, lon: -4.0 }, altitude: 750, radius: 120 },
    kettle: { at: [0.19, 0.008, 0.05], yaw: -0.25 },
    wild: 'desert',
  },
};

/** Height of the top of the opening above x (0 beside it). */
export function openingTop(o: Opening, x: number): number {
  const u = x / o.halfWidth;
  if (!(Math.abs(u) < 1)) return 0;
  return o.spring + (o.apex - o.spring) * Math.sqrt(1 - u * u);
}

/** Centre of the fire (on the floor). */
export function fireCentre(room: Room): Vec3 {
  const b = room.bed;
  return [(b.minX + b.maxX) / 2, 0, (b.minZ + b.maxZ) / 2];
}

/**
 * A pair of Spanish andirons (morillos): each a bar the logs lie across, running from the back
 * wall to a tall upright at the front.
 */
export const ANDIRONS = {
  x: [-0.15, 0.15],
  barY: 0.068, // height of the bars' axis
  barRadius: 0.009,
  back: -0.4,
  front: -0.1,
  postZ: -0.088,
  postTop: 0.29,
  postRadius: 0.013,
};

/** The grate's bars run front to back. */
export const GRATE_BARS = { count: 8, first: -0.21, spacing: 0.06, y: 0.032, radius: 0.007 };

/** The iron the logs rest on, as (start, end, radius) segments: for the poker to clink against. */
export function supportIron(support: Support, fingers: [Vec3, Vec3][]): [Vec3, Vec3, number][] {
  const out: [Vec3, Vec3, number][] = [];
  if (support === 'andirons') {
    const a = ANDIRONS;
    for (const x of a.x) {
      out.push([[x, a.barY, a.back], [x, a.barY, a.front], a.barRadius]);
      out.push([[x, 0, a.postZ], [x, a.postTop, a.postZ], a.postRadius]);
    }
  } else if (support === 'grate') {
    const g = GRATE_BARS;
    for (let i = 0; i < g.count; i++) {
      const x = g.first + i * g.spacing;
      out.push([[x, g.y, -0.33], [x, g.y, -0.09], g.radius]);
    }
    for (const [p, q] of fingers) out.push([p, q, 0.007]);
  }
  return out;
}

/**
 * The stones round a campfire: centre, radius and (squashed) height of each. Deterministic, so
 * the physics, the air and the picture agree.
 */
export function ringStones(ring: NonNullable<Room['ring']>): { centre: Vec3; radius: number; height: number; turn: number }[] {
  const out = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const mid = (ring.inner + ring.outer) / 2;
  const count = 12;
  for (let i = 0; i < count; i++) {
    const a = ((i + 0.3 * (rnd() - 0.5)) / count) * Math.PI * 2;
    const radius = (ring.outer - ring.inner) * (0.5 + 0.12 * rnd());
    const r = mid + (rnd() - 0.5) * 0.02;
    const height = ring.height * (0.8 + 0.35 * rnd());
    out.push({ centre: [Math.cos(a) * r, height * 0.35, Math.sin(a) * r] as Vec3, radius, height, turn: rnd() * Math.PI });
  }
  return out;
}
