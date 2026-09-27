import type { Detail } from '../config';
import { normalize, type Vec3 } from '../math';
import { ringStones, type Room } from '../rooms';
import { MAT, noise2, type MeshBuilder, type UV } from './geometry';
import { random, woodStack } from './props';
import { conifer, snag } from './trees';

// A campfire in a subalpine meadow in the Cascades: a ring of field stones on trampled earth, a
// fallen log to sit on behind the fire with candles in glass on it, a hurricane lantern on a
// stump, a stack of split wood. The meadow is open to the sky; islands of firs and hemlocks
// stand round its edge, forested hills beyond; and to the north-northwest, where the meadow
// falls away into the valley, Mount Rainier stands on the horizon, snow to its foot.

const SKY_RADIUS = 170;
/**
 * Mount Rainier from about 28 km to the south of it: the bearing of its summit (from north,
 * toward east), and, scaled into the scene, how far off it stands, how high it rises above the
 * camp (so its summit is about seven degrees up, as it would be) and how broad its cone is.
 */
const RAINIER = { bearing: -0.14, distance: 145, height: 17, radius: 40 };

export function buildCampsite(m: MeshBuilder, room: Room, detail: Detail) {
  buildSky(m);
  buildGround(m);
  buildMountain(m);
  if (room.ring) buildStones(m, room.ring);
  // (What stands round the fire fades to a ghost if it comes between the eye and the fire.)
  buildBenches(m, room);
  m.seeThrough(() => buildStump(m));
  m.seeThrough(() => buildWoodpile(m));
  buildTrees(m, detail);
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

/** How far (radians) the bearing of (x, z) is from the mountain's. */
function offView(x: number, z: number): number {
  const b = Math.atan2(x, -z);
  return Math.abs(Math.atan2(Math.sin(b - RAINIER.bearing), Math.cos(b - RAINIER.bearing)));
}

/** A dome over everything; its shader draws the sky seen through it. */
function buildSky(m: MeshBuilder) {
  const profile: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const phi = -0.12 + (i / 14) * (Math.PI / 2 + 0.12);
    profile.push([SKY_RADIUS * Math.cos(phi), SKY_RADIUS * Math.sin(phi)]);
  }
  profile[profile.length - 1][0] = 0;
  m.lathe([0, 0, 0], profile, MAT.sky, 64);
}

/**
 * Height of the ground: flat round the fire, the meadow rolling gently further out, forested
 * hills round it; toward the mountain the land falls away into the valley, with a low wooded
 * ridge across it in front of the mountain's foot.
 */
export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const view = smooth(0.75, 0.3, offView(x, z));
  const roll = 0.45 * (noise2(x * 0.22 + 5, z * 0.22) - 0.5) + 0.2 * (noise2(x * 0.7 + 3, z * 0.7 + 7) - 0.5);
  const hills = smooth(30, 90, r) * (3 + 7 * noise2(x * 0.018 + 3, z * 0.018 + 1)) * (1 - view);
  const valley = view * (-5 * smooth(16, 60, r) + 6.5 * smooth(70, 105, r) * (0.7 + 0.6 * noise2(x * 0.05, z * 0.05 + 9)));
  return smooth(2.6, 7, r) * roll + hills + valley;
}

function buildGround(m: MeshBuilder) {
  const rings = [0, 0.3, 0.6, 0.9, 1.25, 1.65, 2.1, 2.6, 3.2, 4, 5, 6.2, 7.6, 9.2, 11, 13.5, 16.5, 20, 24, 30, 38, 48, 60, 75, 92, 112, 135, 160];
  const around = 128;
  const e = 0.01;
  const vert = (r: number, a: number) => {
    const x = r * Math.cos(a);
    const z = r * Math.sin(a);
    const y = groundHeight(x, z);
    const n = normalize([groundHeight(x - e, z) - groundHeight(x + e, z), 2 * e, groundHeight(x, z - e) - groundHeight(x, z + e)]);
    m.vertex([x, y, z], n, [x, z], MAT.ground);
  };
  for (let k = 0; k + 1 < rings.length; k++) {
    for (let i = 0; i < around; i++) {
      const a0 = (i / around) * Math.PI * 2;
      const a1 = ((i + 1) / around) * Math.PI * 2;
      const [r0, r1] = [rings[k], rings[k + 1]];
      vert(r0, a0); vert(r1, a0); vert(r1, a1);
      vert(r0, a0); vert(r1, a1); vert(r0, a1);
    }
  }
}

/**
 * Mount Rainier: a great, broad volcano, its summit a rounded dome, its flanks cut into ridges of
 * rock (the cleavers) with glaciers filling the troughs between them, Little Tahoma a sharp second
 * peak on its eastern shoulder. (uv: height up it, 0..1, and how much it is on a ridge, 0..1.)
 */
function buildMountain(m: MeshBuilder) {
  const { bearing, distance, height: H, radius: R } = RAINIER;
  const sx = Math.sin(bearing) * distance;
  const sz = -Math.cos(bearing) * distance;
  /**
   * How far (u, v) is along a ridge (1) or down in a trough between two (0): ridges of a few
   * sizes, wandering as they run down, standing out more in some places than others.
   */
  const ridgeAt = (u: number, v: number): number => {
    const rho = Math.hypot(u, v) / R;
    const a = Math.atan2(v, u);
    const [ca, sa] = [Math.cos(a), Math.sin(a)];
    const th = a + 0.5 * (noise2(ca * 2.2 + rho * 2.5 + 3, sa * 2.2 + rho * 1.7) - 0.5);
    let r = 0;
    for (const [f, w, k] of [[4.5, 1, 7], [10, 0.5, 19], [21, 0.25, 31]]) {
      const n = noise2(Math.cos(th) * f + k + rho * 1.5, Math.sin(th) * f - k + rho * 0.8);
      r += w * (1 - Math.abs(2 * n - 1));
    }
    return (r / 1.75) * (0.78 + 0.32 * noise2(ca * 3 + rho * 4 + 9, sa * 3 - rho * 3));
  };
  const heightAt = (u: number, v: number): number => {
    const rho = Math.hypot(u, v) / R;
    const ridge = ridgeAt(u, v);
    // Its long western side falls away a little more gently than its eastern.
    const x = rho * (1 + 0.1 * (ridge - 0.5) * Math.min(rho * 1.5, 1)) * (u < 0 ? 0.92 : 1);
    // Steepest (about 24 degrees) a little below the top, gentler and gentler further out, and
    // rounding over at the top into a broad summit dome: as its real slopes fall away (at Camp
    // Muir, 3 km out, two thirds as high above the meadow as the summit; at Paradise, 8 km out,
    // a quarter).
    const c = 0.12;
    let h = H * Math.exp(-(Math.sqrt(x * x + c * c) - c) / 0.7);
    // The glaciers have carved troughs into its flanks between the ridges.
    h -= 0.045 * H * (1 - ridge) * smooth(0.06, 0.25, rho) * smooth(1.25, 0.55, rho);
    // Little Tahoma: a sharp second peak on its eastern shoulder, 3.7 km from the summit.
    const tahoma = Math.hypot(u - 0.47 * R, (v - 0.045 * R) * 1.4) / (0.3 * R);
    h = Math.max(h, 0.735 * H * (1 - tahoma));
    // Rock and rubble: bumps of a couple of sizes.
    const rough = (0.45 * (noise2(u * 0.3 + 11, v * 0.3) - 0.5) + 0.2 * (noise2(u * 0.9 + 3, v * 0.9 + 5) - 0.5)) * Math.min(rho * 2, 1);
    // (Its edge sinks out of sight into the valley in front.)
    return h + rough - 2 - 3 * smooth(1.05, 1.35, rho);
  };
  const rings = 48;
  const around = 256;
  const e = 0.05;
  // Every point of the grid, worked out once.
  const grid: { p: Vec3; n: Vec3; uv: UV }[][] = [];
  for (let i = 0; i <= rings; i++) {
    const rho = 1.35 * Math.pow(i / rings, 1.3);
    const row = [];
    for (let j = 0; j <= around; j++) {
      const a = (j / around) * Math.PI * 2;
      const u = Math.cos(a) * rho * R;
      const v = Math.sin(a) * rho * R;
      const y = heightAt(u, v);
      const n = normalize([heightAt(u - e, v) - heightAt(u + e, v), 2 * e, heightAt(u, v - e) - heightAt(u, v + e)]);
      row.push({ p: [sx + u, y, sz + v] as Vec3, n, uv: [(y + 2) / H, ridgeAt(u, v)] as UV });
    }
    grid.push(row);
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < around; j++) {
      for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) {
        const g = grid[a][b];
        m.vertex(g.p, g.n, g.uv, MAT.mountain);
      }
    }
  }
}

/**
 * Field stones round the fire: lumpy, squashed, a little longer along the ring than across it,
 * bedded into the ground.
 */
function buildStones(m: MeshBuilder, ring: NonNullable<Room['ring']>) {
  const rows = 10;
  const cols = 18;
  const rnd = random(23);
  ringStones(ring).forEach((s, n) => {
    const R = s.radius;
    const H = s.height + 0.03;
    const around = Math.atan2(s.centre[2], s.centre[0]);
    const radial: Vec3 = [Math.cos(around), 0, Math.sin(around)];
    const tangent: Vec3 = [-Math.sin(around), 0, Math.cos(around)];
    const long = 1.1 + 0.25 * rnd(); // along the ring
    const wide = 0.85 + 0.1 * rnd(); // across it
    const flat = 0.75 + 0.25 * rnd(); // how rounded its top is
    const point = (i: number, j: number): { p: Vec3; nrm: Vec3 } => {
      const lat = (i / rows) * Math.PI - Math.PI / 2;
      const lon = (j / cols) * Math.PI * 2;
      const lump =
        1 +
        0.3 * (noise2(Math.cos(lon) * 1.4 + n * 7.3, Math.sin(lon) * 1.4 + lat * 1.2) - 0.5) +
        0.12 * (noise2(Math.cos(lon) * 3.1 + n * 3.1, Math.sin(lon) * 3.1 + lat * 2.7) - 0.5);
      const c = Math.cos(lat) * lump;
      const u = c * Math.cos(lon) * R * long;
      const v = c * Math.sin(lon) * R * wide;
      const up = Math.sign(Math.sin(lat)) * Math.abs(Math.sin(lat)) ** flat;
      const y = (up * 0.5 + 0.5) * H - 0.03;
      const p: Vec3 = [s.centre[0] + tangent[0] * u + radial[0] * v, y, s.centre[2] + tangent[2] * u + radial[2] * v];
      const gu = (Math.cos(lat) * Math.cos(lon)) / (R * long);
      const gv = (Math.cos(lat) * Math.sin(lon)) / (R * wide);
      const nrm = normalize([tangent[0] * gu + radial[0] * gv, Math.sin(lat) / (H / 2), tangent[2] * gu + radial[2] * gv]);
      return { p, nrm };
    };
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const c = [point(i, j), point(i + 1, j), point(i + 1, j + 1), point(i, j + 1)];
        for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(c[k].p, c[k].nrm, [c[k].p[0], c[k].p[2]], MAT.stone);
      }
    }
  });
}

/** A fallen log to sit on behind the fire (with tea lights in glass on it) and another to one side. */
function buildBenches(m: MeshBuilder, room: Room) {
  const log = { segments: 28, capMat: MAT.endGrain, seam: [0, -1, 0] as Vec3 };
  m.seeThrough(() => {
    m.cylinder([-0.95, 0.18, -1.15], [0.8, 0.18, -1.17], 0.18, MAT.bark, log);
    room.candles.forEach(([x, flameY, z], i) => {
      const base = flameY - 0.023;
      m.cylinder([x, base, z], [x, base + 0.034, z], 0.033, MAT.jar, { segments: 20, capMat: MAT.jar });
      m.cylinder([x, base + 0.004, z], [x, flameY - 0.006, z], 0.02, MAT.wax, { segments: 16, capMat: MAT.wax });
      m.cylinder([x, flameY - 0.007, z], [x, flameY + 0.004, z], 0.0011, MAT.soot, { segments: 6 });
      m.flame([x, flameY, z], i);
    });
  });
  m.seeThrough(() => m.cylinder([-1.42, 0.16, -0.55], [-1.38, 0.16, 0.75], 0.16, MAT.bark, log));
}

/** A stump with a hurricane lantern on it. */
function buildStump(m: MeshBuilder) {
  const [x, z] = [-0.86, -0.32];
  const top = 0.42;
  m.cylinder([x, -0.03, z], [x, top, z], 0.17, MAT.bark, { segments: 28, capMat: MAT.endGrain, seam: [1, 0, 0] });
  const at: Vec3 = [x, top, z];
  // Fuel tank, glass globe, cap.
  m.lathe(at, [[0, 0], [0.055, 0], [0.058, 0.01], [0.056, 0.035], [0.036, 0.045], [0.03, 0.05]], MAT.tin, 28);
  m.lathe(at, [[0.03, 0.05], [0.041, 0.068], [0.046, 0.095], [0.041, 0.122], [0.029, 0.14]], MAT.glass, 28);
  m.lathe(at, [[0.031, 0.138], [0.05, 0.145], [0.046, 0.152], [0.03, 0.166], [0.012, 0.18], [0, 0.182]], MAT.tin, 28);
  // Wire guards round the globe and a bail to carry it by.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    m.cylinder([x + 0.052 * Math.cos(a), top + 0.045, z + 0.052 * Math.sin(a)], [x + 0.052 * Math.cos(a), top + 0.145, z + 0.052 * Math.sin(a)], 0.0018, MAT.tin, { segments: 5 });
  }
  let prev: Vec3 | null = null;
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * Math.PI;
    const p: Vec3 = [x + 0.058 * Math.cos(a), top + 0.15 + 0.085 * Math.sin(a), z];
    if (prev) m.cylinder(prev, p, 0.0018, MAT.iron, { segments: 5 });
    prev = p;
  }
}

/** Split firewood stacked by the fire. */
function buildWoodpile(m: MeshBuilder) {
  woodStack(m, 0.88, 1.26, 0, -0.75, -0.3, 4, ['birch', 'oak', 'pine'], 19);
}

/**
 * Islands of firs and hemlocks round the edge of the meadow, the odd dead snag among them, and
 * the forest on the hills beyond; none of it in the way of the view to the mountain, and all of
 * it far enough off to leave the sky open overhead.
 */
function buildTrees(m: MeshBuilder, detail: Detail) {
  const rnd = random(5);
  const layers = { low: 0.45, medium: 0.7, high: 1 }[detail];
  const place = (near: number, far: number, clear: number): [number, number] => {
    for (;;) {
      const b = rnd() * Math.PI * 2;
      const d = near + rnd() * (far - near);
      const x = Math.sin(b) * d;
      const z = -Math.cos(b) * d;
      if (offView(x, z) > clear) return [x, z];
    }
  };
  // How tall a tree there may be: none tops out more than about 17 degrees above the camp.
  const most = (x: number, y: number, z: number) => 0.3 * Math.hypot(x, z) - y;
  const islands = { low: 10, medium: 15, high: 20 }[detail];
  for (let i = 0; i < islands; i++) {
    const [cx, cz] = place(34, 52, 0.62);
    const count = 3 + Math.floor(rnd() * 6);
    for (let t = 0; t < count; t++) {
      const x = cx + (rnd() - 0.5) * 9;
      const z = cz + (rnd() - 0.5) * 9;
      if (offView(x, z) < 0.55) continue;
      const y = groundHeight(x, z);
      const tall = Math.min((8 + rnd() * 9) * (t === 0 ? 1.15 : 1), most(x, y, z));
      if (tall < 4) continue;
      if (rnd() < 0.07) snag(m, rnd, [x, y, z], tall * 0.8);
      else conifer(m, rnd, [x, y, z], tall, tall * (0.2 + 0.08 * rnd()), layers);
    }
  }
  // The forest on the hills: its treetops make the skyline.
  const beyond = { low: 45, medium: 90, high: 130 }[detail];
  for (let i = 0; i < beyond; i++) {
    const [x, z] = place(60, 120, 0.7);
    const y = groundHeight(x, z) - 0.5;
    const tall = Math.min(14 + rnd() * 10, most(x, y, z));
    if (tall >= 5) conifer(m, rnd, [x, y, z], tall, tall * 0.24, layers * 0.5);
  }
  // And a fringe of forest along the ridge in front of the mountain, miles off (so, small).
  const fringe = { low: 40, medium: 70, high: 100 }[detail];
  for (let i = 0; i < fringe; i++) {
    const b = RAINIER.bearing + (rnd() - 0.5) * 1.5;
    const d = 102 + rnd() * 14;
    const x = Math.sin(b) * d;
    const z = -Math.cos(b) * d;
    const tall = 1.2 + rnd() * 1.4;
    conifer(m, rnd, [x, groundHeight(x, z) - 0.1, z], tall, tall * 0.26, 0.2);
  }
}
