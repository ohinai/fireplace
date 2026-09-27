import type { Vec3 } from './math';
import type { Room } from './rooms';

/**
 * How the fire starts: already burning (logs well alight on a bed of coals, in a warm
 * fireplace), or laid cold: fresh logs over kindling and firelighters, nothing burning, the
 * fireplace at room temperature. A cold fire has to be lit, catches slowly, and spreads from
 * wherever it was lit.
 */
export type FireMode = 'lit' | 'cold';

/** A log (or stick of kindling) to put in place. */
export interface LaidLog {
  wood: string;
  a: Vec3; // one end
  b: Vec3; // the other
  radius: number;
  preburn: number; // 0 = fresh, 1 = about a quarter hour in the fire
  /** Lowered onto whatever is below it (only its ends' x and z count); else placed as given. */
  stacked: boolean;
}

/**
 * Where the tops of a teepee's logs meet: an invisible prop that stands in for the way real
 * logs lock together there (which rigid bodies touching end to end cannot do). It goes as soon
 * as any of its logs is moved, breaks or burns thin, and the teepee then falls in on itself.
 */
export interface Support {
  hull: Vec3[]; // a convex shape
  members: number[]; // which of the layout's logs lean on it
}

export interface Layout {
  logs: LaidLog[];
  supports: Support[];
  lighters: Vec3[]; // firelighters (the middle of their base)
  coals: number; // kg/m2 of glowing coals under the fire to start with
  coalTemp: number; // K
  coalAsh: number; // how much of them has skinned over with ash (0..1)
  walls: number; // K: the firebox walls (or the stones and ground round a campfire)
}

const KINDLING = 'kindling';

export function layFire(room: Room, mode: FireMode): Layout {
  if (room.enclosure !== 'open') return fireplace(room, mode);
  return room.ring ? campfire(room, mode) : starFire(room, mode);
}

/** Two logs side by side on the grate or andirons, a third across the top. */
function fireplace(room: Room, mode: FireMode): Layout {
  // On andirons the logs sit a little further back, clear of the uprights.
  const shift = room.support === 'andirons' ? 0.02 : 0;
  const at = (x: number, z: number): Vec3 => [x, 0, z - shift];
  const [w0, w1, w2] = room.startWoods;
  const log = (wood: string, a: Vec3, b: Vec3, radius: number, preburn: number): LaidLog => ({ wood, a, b, radius, preburn, stacked: true });
  if (mode === 'lit') {
    return {
      logs: [
        log(w0, at(-0.23, -0.272), at(0.21, -0.268), 0.055, 0.5),
        log(w1, at(-0.21, -0.148), at(0.23, -0.142), 0.05, 0.5),
        log(w2, at(-0.17, -0.226), at(0.19, -0.188), 0.045, 0.35),
      ],
      supports: [],
      lighters: [],
      coals: 6,
      coalTemp: 1050,
      coalAsh: 0.45,
      walls: 500,
    };
  }
  // Laid cold, with room for air to get in and flames to get up: two fresh logs a hand's width
  // apart, kindling and a firelighter at each end, the third log on top. It can be lit at either
  // end, or both.
  const gap = -0.2125; // between the two bottom logs
  const back = log(w0, at(-0.22, -0.285), at(0.21, -0.285), 0.052, 0);
  const front = log(w1, at(-0.21, -0.14), at(0.22, -0.14), 0.052, 0);
  const top = log(w2, at(-0.18, gap), at(0.19, gap), 0.045, 0);
  const stick = (x: number, z0: number, z1: number, radius: number) => log(KINDLING, at(x, z0), at(x + 0.004, z1), radius, 0);
  if (room.support === 'grate') {
    // On a grate: three sticks of kindling across the two logs at each end, over the gap, a
    // firelighter under them on the grate; the top log rests on the kindling.
    return {
      logs: [
        back,
        front,
        stick(-0.176, -0.315, -0.105, 0.012),
        stick(-0.146, -0.31, -0.11, 0.012),
        stick(-0.116, -0.312, -0.108, 0.012),
        stick(0.112, -0.31, -0.11, 0.012),
        stick(0.142, -0.312, -0.108, 0.012),
        stick(0.172, -0.315, -0.105, 0.012),
        top,
      ],
      supports: [],
      lighters: [
        [-0.146, 0.039, gap - shift],
        [0.142, 0.039, gap - shift],
      ],
      coals: 0,
      coalTemp: 300,
      coalAsh: 0,
      walls: 300,
    };
  }
  // On andirons the logs sit well up off the hearth: kindling and firelighters go underneath, a
  // firelighter between two sticks at each side and a third stick across them over it. A stick
  // more goes up across the two logs at each end, and the top log rests on those, so that
  // something is burning between the logs, not only under them, when the kindling below is done.
  // (Eleven pieces in all, leaving room to add a log straight away.)
  const across = (x0: number, x1: number, z: number, radius: number) => log(KINDLING, at(x0, z), at(x1, z + 0.004), radius, 0);
  return {
    logs: [
      stick(-0.125, -0.325, -0.14, 0.013),
      stick(-0.058, -0.32, -0.145, 0.012),
      across(-0.16, -0.025, -0.2, 0.012),
      stick(0.054, -0.32, -0.145, 0.012),
      stick(0.121, -0.325, -0.14, 0.013),
      across(0.022, 0.158, -0.2, 0.012),
      back,
      front,
      stick(-0.11, -0.31, -0.11, 0.013),
      stick(0.108, -0.312, -0.108, 0.013),
      top,
    ],
    supports: [],
    lighters: [
      [-0.092, 0, -0.2 - shift],
      [0.088, 0, -0.2 - shift],
    ],
    coals: 0,
    coalTemp: 300,
    coalAsh: 0,
    walls: 300,
  };
}

/**
 * Logs stood up in a teepee, leaning in on each other. Laid cold, it is a closer teepee of split
 * wood (thinner, so it catches from the kindling, and close enough round the flames inside to
 * keep itself going without a bed of coals) round a crib of kindling over two firelighters.
 */
function campfire(room: Room, mode: FireMode): Layout {
  const lit = mode === 'lit';
  const woods = room.startWoods;
  const logs: LaidLog[] = [];
  const radii = lit ? [0.038, 0.034, 0.04, 0.036, 0.035] : [0.028, 0.025, 0.03, 0.027, 0.026, 0.029];
  const foot = lit ? 0.2 : 0.15;
  const angles = radii.map((_, i) => ((i + 0.15) / radii.length) * Math.PI * 2);
  radii.forEach((radius, i) => {
    logs.push({ ...teepeeLog(angles[i], foot, 0.036, 0.37, radius), wood: woods[i % woods.length], preburn: lit ? 0.5 - 0.04 * i : 0 });
  });
  const supports: Support[] = [{ hull: prism(angles, 0.036, 0.27, 0.375), members: radii.map((_, i) => i) }];
  if (lit) return { logs, supports, lighters: [], coals: 5, coalTemp: 1030, coalAsh: 0.45, walls: 360 };
  // Laid cold: a crib of kindling inside the teepee (two sticks, two across them and one more
  // on top), with a firelighter in it on either side.
  const stick = (a: Vec3, b: Vec3, radius: number): LaidLog => ({ wood: KINDLING, a, b, radius, preburn: 0, stacked: true });
  logs.push(
    stick([-0.042, 0, -0.072], [-0.038, 0, 0.072], 0.013),
    stick([0.04, 0, -0.07], [0.043, 0, 0.072], 0.012),
    stick([-0.072, 0, -0.036], [0.072, 0, -0.039], 0.012),
    stick([-0.07, 0, 0.04], [0.072, 0, 0.037], 0.013),
    stick([0.002, 0, -0.068], [-0.002, 0, 0.07], 0.012),
  );
  return {
    logs,
    supports,
    lighters: [
      [-0.012, 0, 0.018],
      [0.012, 0, -0.018],
    ],
    coals: 0,
    coalTemp: 300,
    coalAsh: 0,
    walls: 300,
  };
}

/**
 * A log leaning in toward the middle: foot on the ground at radius `foot`, its top resting
 * against a prop whose faces are `inner` from the middle, at `height`.
 */
function teepeeLog(phi: number, foot: number, inner: number, height: number, radius: number) {
  const dir: Vec3 = [Math.cos(phi), 0, Math.sin(phi)];
  let top = inner + radius;
  let lean = 1.2;
  for (let i = 0; i < 4; i++) {
    lean = Math.atan2(height - radius, foot - top); // from the horizontal
    top = inner + radius / Math.sin(lean) + 0.0015; // its underside just touching the prop
  }
  const footY = radius * Math.cos(lean) + 0.002; // rim of its bottom end just clear of the ground
  const a: Vec3 = [dir[0] * foot, footY, dir[2] * foot];
  const b: Vec3 = [dir[0] * top, height, dir[2] * top];
  return { a, b, radius, stacked: false };
}

/** An upright prism with a flat face toward each of `angles`, `inner` from the middle. */
function prism(angles: number[], inner: number, y0: number, y1: number): Vec3[] {
  const n = angles.length;
  const outer = inner / Math.cos(Math.PI / n);
  const out: Vec3[] = [];
  for (let i = 0; i < n; i++) {
    const a = angles[i] + Math.PI / n;
    for (const y of [y0, y1]) out.push([outer * Math.cos(a), y, outer * Math.sin(a)]);
  }
  return out;
}

/**
 * A desert fire: sticks pushed in from all round, their ends meeting in the middle like the
 * points of a star (fed by pushing them further in as they burn), leaving a gap by the kettle's
 * place. Laid cold, a little teepee of sticks over kindling instead.
 */
function starFire(room: Room, mode: FireMode): Layout {
  const woods = room.startWoods;
  if (mode === 'cold') {
    const lit = campfire(room, mode);
    return { ...lit, logs: lit.logs.map((l, i) => (l.wood === KINDLING ? l : { ...l, wood: woods[i % woods.length], radius: l.radius * 0.8 })) };
  }
  const kettle = room.kettle ? Math.atan2(room.kettle.at[2], room.kettle.at[0]) : null;
  const logs: LaidLog[] = [];
  const n = 8;
  for (let i = 0; i < n; i++) {
    let a = kettle === null ? (i / n) * Math.PI * 2 : kettle + 0.55 + (i / (n - 1)) * (Math.PI * 2 - 1.1);
    a += ((i * 7) % 5) * 0.03;
    const dir: Vec3 = [Math.cos(a), 0, Math.sin(a)];
    const radius = 0.019 + ((i * 5) % 4) * 0.002;
    const len = 0.34 + ((i * 11) % 5) * 0.012;
    // Every other stick's end lies among the embers; the ones between rest on those, their ends
    // meeting over the middle; the outer ends lie on the sand.
    const upper = i % 2 === 1;
    const inner = upper ? 0.032 : 0.045;
    logs.push({
      wood: woods[i % woods.length],
      a: [dir[0] * inner, upper ? 2 * radius + 0.035 : radius + 0.01, dir[2] * inner],
      b: [dir[0] * (inner + len), radius + 0.003, dir[2] * (inner + len)],
      radius,
      preburn: 0.5 - 0.04 * (i % 3),
      stacked: false,
    });
  }
  return { logs, supports: [], lighters: [], coals: 5.5, coalTemp: 1060, coalAsh: 0.4, walls: 330 };
}
