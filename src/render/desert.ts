import type { Detail } from '../config';
import { add, cross, normalize, scale, sub, type Vec3 } from '../math';
import type { Room } from '../rooms';
import { MAT, noise2, type MeshBuilder, type UV } from './geometry';
import { arcTube, bolster, cushion, rug } from './furniture';
import { branch, frustum, random } from './props';

// A Bedouin camp in the dunes: orange sand, rippled by the wind, rising to great dunes all round;
// a fire of twisted desert wood with a rug and cushions beside it and a brass tray of tea; a heap
// of gathered branches; behind, a tent of black goat hair, its roof sagging between its poles,
// open at the front, rugs and cushions inside, a lantern at its entrance.

const TENT = { z: -3.45, halfWidth: 3.0, front: 1.25, back: -1.3 }; // (front and back from its middle)
const POLES = [-2.2, -0.733, 0.733, 2.2];
const LANTERN_Y = 1.143; // the foot of the lantern hanging at the entrance (its light: see rooms.ts)

export function buildDesert(m: MeshBuilder, room: Room, detail: Detail) {
  buildSky(m, room.sky?.radius ?? 120);
  buildSand(m, detail);
  m.at([0, 0, TENT.z], 0, () => buildTent(m, detail));
  // By the fire: a rug to sit on, cushions, tea.
  rug(m, 0.6, 1.75, -0.55, 0.95, 0.006, 3, 0.04);
  if (detail === 'low') return;
  // A bolster along the back of the rug and two cushions on it, in Bedouin weaving; tea.
  const black: Vec3 = [0.04, 0.03, 0.03];
  m.seeThrough(() => m.at([1.62, 0.105, 0.12], 1.57, () => bolster(m, 0.8, 0.1, 4)));
  m.seeThrough(() => m.at([1.3, 0.066, 0.78], 0.35, () => cushion(m, 0.5, 0.5, 0.12, 0, 3, black, { tassels: true })));
  m.seeThrough(() => m.at([1.12, 0.066, -0.25], -0.2, () => cushion(m, 0.46, 0.46, 0.12, 0, 4, [0.42, 0.05, 0.04], { tassels: true })));
  m.seeThrough(() => m.at([0.98, 0.006, 0.42], 0.3, () => teaTray(m)));
  m.seeThrough(() => buildBranches(m, detail));
}

/** The dome of the sky (its shader draws the sky seen through it). */
function buildSky(m: MeshBuilder, radius: number) {
  const profile: [number, number][] = [];
  for (let i = 0; i <= 14; i++) {
    const phi = -0.12 + (i / 14) * (Math.PI / 2 + 0.12);
    profile.push([radius * Math.cos(phi), radius * Math.sin(phi)]);
  }
  profile[profile.length - 1][0] = 0;
  m.lathe([0, 0, 0], profile, MAT.sky, 64);
}

/**
 * Height of the sand: nearly flat round the camp, then dunes, their crests running across the
 * wind (from the west), taller further out, and a rim of great dunes against the sky.
 */
export function sandHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  const near = 0.035 * (noise2(x * 0.7 + 2, z * 0.7) - 0.5) + 0.02 * (noise2(x * 2.1, z * 2.1 + 5) - 0.5);
  const warp = 18 * (noise2(x * 0.018 + 3, z * 0.018) - 0.5);
  const ridge = 1 - Math.abs(2 * noise2((x + warp) * 0.03 + 11, (z + warp * 0.5) * 0.011 + 7) - 1);
  const dunes = Math.pow(ridge, 1.8) * (5 + 16 * noise2(x * 0.009 + 1, z * 0.009 + 4));
  return near + smooth(6, 28, r) * dunes + smooth(55, 115, r) * 8;
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function buildSand(m: MeshBuilder, detail: Detail) {
  const rings = [0, 0.3, 0.6, 1, 1.5, 2.1, 2.8, 3.6, 4.5, 5.5, 6.7, 8, 9.5, 11.2, 13, 15, 17.5, 20, 23, 26.5, 30, 34, 39, 45, 52, 60, 69, 79, 90, 102, 116];
  const around = detail === 'low' ? 96 : 160;
  const e = 0.02;
  const vert = (r: number, a: number) => {
    const x = r * Math.cos(a);
    const z = r * Math.sin(a);
    const y = sandHeight(x, z);
    const n = normalize([sandHeight(x - e, z) - sandHeight(x + e, z), 2 * e, sandHeight(x, z - e) - sandHeight(x, z + e)]);
    m.vertex([x, y, z], n, [x, z], MAT.sand);
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

const RIDGE = 2.05; // the middle row of poles (m)
const FRONT_EDGE = 1.6; // the front edge, on its shorter poles
const BACK_EDGE = 1.25; // the back edge, where the back wall hangs from it

/**
 * Height of the tent's roof over (x, z) (in the tent's frame): pushed up to a point on each pole,
 * nearly straight from the middle row down to the front and back edges (the guy ropes keep it
 * taut), the cloth hanging in a curve between one pole and the next, and falling away to the ends
 * beyond the last.
 */
function roofHeight(x: number, z: number): number {
  const { front, back } = TENT;
  const t = z > 0 ? z / front : z / back; // (0 along the middle row, 1 at the edge)
  const line = RIDGE + ((z > 0 ? FRONT_EDGE : BACK_EDGE) - RIDGE) * t - 0.05 * Math.sin(Math.PI * t);
  const span = POLES[1] - POLES[0];
  const u = Math.min(Math.max((x - POLES[0]) / span, 0), POLES.length - 1);
  const f = u - Math.floor(u);
  const hang = (0.05 + 0.06 * (1 - t)) * 4 * f * (1 - f);
  let peak = 0;
  for (const px of POLES) {
    peak = Math.max(peak, 0.06 * Math.exp(-((x - px) ** 2 + z ** 2) / 0.05), 0.03 * Math.exp(-((x - px) ** 2 + (z - front) ** 2) / 0.03));
  }
  const beyond = Math.max(0, Math.abs(x) - POLES[POLES.length - 1]);
  return line - hang + peak - 0.45 * beyond * beyond;
}

/**
 * The tent (bayt al-sha'r): a roof of long strips of goat-hair cloth on rows of poles, open at the
 * front with a woven band along its edge, walls of the same cloth hanging in folds down its back
 * and sides, guy ropes out to stakes; inside, rugs, mattresses along the back with cushions propped
 * against the wall and bolsters at their ends, a lantern by the entrance, and (with more detail) a
 * patterned curtain dividing off the family's side. Each part fades if it comes between the eye
 * and the fire.
 */
function buildTent(m: MeshBuilder, detail: Detail) {
  const { halfWidth: W, front, back } = TENT;
  const nx = detail === 'low' ? 48 : 72;
  const nz = detail === 'low' ? 16 : 24;
  const at = (x: number, z: number): Vec3 => [x, roofHeight(x, z), z];
  const e = 0.01;
  const nrm = (x: number, z: number): Vec3 => normalize([roofHeight(x - e, z) - roofHeight(x + e, z), 2 * e, roofHeight(x, z - e) - roofHeight(x, z + e)]);
  // The roof (uv: along the strips, and across them).
  m.seeThrough(() => {
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x0 = -W + (2 * W * i) / nx, x1 = -W + (2 * W * (i + 1)) / nx;
        const z0 = back + ((front - back) * j) / nz, z1 = back + ((front - back) * (j + 1)) / nz;
        for (const [x, z] of [[x0, z0], [x1, z0], [x1, z1], [x0, z0], [x1, z1], [x0, z1]]) m.vertex(at(x, z), nrm(x, z), [x, z - back], MAT.tent);
      }
    }
    // A band of weaving hanging along the front edge (uv: across it, down from the top; along it).
    m.with([3, 0.2, 2 * W], () => {
      for (let i = 0; i < nx; i++) {
        const x0 = -W + (2 * W * i) / nx, x1 = -W + (2 * W * (i + 1)) / nx;
        const y0 = roofHeight(x0, front), y1 = roofHeight(x1, front);
        const q: [Vec3, UV][] = [
          [[x0, y0 - 0.2, front + 0.004], [1, (x0 + W) / (2 * W)]],
          [[x1, y1 - 0.2, front + 0.004], [1, (x1 + W) / (2 * W)]],
          [[x1, y1, front + 0.004], [0, (x1 + W) / (2 * W)]],
          [[x0, y0, front + 0.004], [0, (x0 + W) / (2 * W)]],
        ];
        for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(q[k][0], [0, 0, 1], q[k][1], MAT.rug);
      }
    });
  });
  // The walls: hanging from the roof's edge in folds that deepen toward the sand, where the
  // cloth spreads a little (uv: along, and up: the strips run along them).
  const fold = (a: number, h: number) => (0.025 + 0.05 * (1 - h)) * (Math.sin(a * 9.3) + 0.45 * Math.sin(a * 23.1 + 1.7));
  const wall = (along: number[], place: (a: number, y: number, h: number) => Vec3, top: (a: number) => number) => {
    const rows = 6;
    for (let i = 0; i + 1 < along.length; i++) {
      for (let r = 0; r < rows; r++) {
        const corners: [number, number][] = [[i, r], [i + 1, r], [i + 1, r + 1], [i, r], [i + 1, r + 1], [i, r + 1]];
        const pts = corners.map(([k, rr]) => {
          const a = along[k];
          const h = rr / rows; // 0 at the sand, 1 at the roof
          return { p: place(a, top(a) * h, h), uv: [a, top(a) * h] as UV };
        });
        for (let t = 0; t < 6; t += 3) {
          const n = normalize(cross(sub(pts[t + 1].p, pts[t].p), sub(pts[t + 2].p, pts[t].p)));
          for (const { p, uv } of pts.slice(t, t + 3)) m.vertex(p, n, uv, MAT.tent);
        }
      }
    }
  };
  const xs = Array.from({ length: nx + 1 }, (_, i) => -W + (2 * W * i) / nx);
  m.seeThrough(() => wall(xs, (x, y, h) => [x, y, back - 0.06 - 0.05 * (1 - h) + fold(x, h)], (x) => roofHeight(x, back)));
  for (const side of [-1, 1]) {
    const zs = Array.from({ length: 13 }, (_, j) => back + ((0.4 - back) * j) / 12);
    m.seeThrough(() => wall(zs, (z, y, h) => [side * (W + 0.06 + 0.05 * (1 - h) + fold(z + side, h)), y, z], (z) => roofHeight(side * W, z)));
  }
  // Poles: a tall row down the middle, a shorter one holding up the front edge.
  const wood: Vec3 = [0.3, 0.2, 0.12];
  m.seeThrough(() =>
    m.with(wood, () => {
      for (const x of POLES) {
        frustum(m, [x, 0, 0], [x, roofHeight(x, 0) + 0.01, 0], 0.035, 0.028, 8, MAT.finish);
        frustum(m, [x, 0, front - 0.02], [x, roofHeight(x, front - 0.02) + 0.01, front - 0.02], 0.03, 0.025, 8, MAT.finish);
      }
    }),
  );
  // A hurricane lantern hanging by the entrance (where the room's lamp is).
  const lx = -0.733;
  const top = roofHeight(lx, front - 0.05) - 0.03;
  m.seeThrough(() => {
    m.cylinder([lx, top, front - 0.05], [lx, LANTERN_Y + 0.215, front - 0.05], 0.002, MAT.iron, { segments: 4 });
    lantern(m, [lx, LANTERN_Y, front - 0.05]);
  });
  // Rugs over the sand inside.
  rug(m, -2.8, 2.8, back + 0.1, front - 0.15, 0.006, 3, 0);
  if (detail === 'low') return;
  // Guy ropes out to stakes in the sand, from the front and the back.
  m.seeThrough(() =>
    m.with([0.55, 0.47, 0.35], () => {
      for (const x of POLES) {
        // (None in front of the entrance: the two middle poles' front ropes are left out.)
        const ropes = Math.abs(x) > 1 ? [[front, front + 0.9, 1.3], [back, back - 1.3, 1.08]] : [[back, back - 1.3, 1.08]];
        for (const [z, out, splay] of ropes) {
          const from = at(x, z);
          const stake: Vec3 = [x * splay, 0.05, out];
          frustum(m, from, stake, 0.006, 0.006, 5, MAT.fabric);
          m.with(wood, () => frustum(m, [stake[0], -0.1, stake[2]], [stake[0], 0.09, stake[2]], 0.018, 0.012, 6, MAT.finish));
        }
      }
    }),
  );
  // Along the back wall, on the men's side: long mattresses, cushions propped against the wall on
  // them, a bolster at each end.
  const red: Vec3 = [0.42, 0.05, 0.04];
  const black: Vec3 = [0.04, 0.03, 0.03];
  const n = detail === 'high' ? 10 : 7;
  for (const [x0, x1] of [[-2.75, -0.85], [-0.75, 1.35]]) {
    const mid = (x0 + x1) / 2;
    const len = x1 - x0;
    m.seeThrough(() => {
      m.at([mid, 0.06, back + 0.42], 0, () => cushion(m, len, 0.62, 0.11, 0, 4, black, { plump: 0.15, n }));
      const count = Math.round(len / 0.62);
      for (let i = 0; i < count; i++) {
        const x = x0 + (len * (i + 0.5)) / count;
        m.at([x, 0.36, back + 0.2], 0.04 * Math.sin(i * 2.3), () => cushion(m, 0.5, 0.46, 0.15, 1.2, i % 2 ? 3 : 4, i % 2 ? black : red, { n, tassels: true }));
      }
      for (const [x, s] of [[x0 + 0.1, 1], [x1 - 0.1, -1]]) m.at([x, 0.2, back + 0.52], s * 1.57, () => bolster(m, 0.55, 0.1, 4));
    });
  }
  if (detail !== 'high') return;
  // A curtain of patterned weaving dividing off the family's side.
  m.seeThrough(() =>
    m.with([3, 1.6, 1.9], () => {
      const x = 1.47;
      m.quad([x, 0.01, back + 0.05], [x, 0.01, 0.25], [x, roofHeight(x, 0.25) - 0.02, 0.25], [x, roofHeight(x, back + 0.05) - 0.02, back + 0.05], [-1, 0, 0], MAT.rug, (p) => [(p[2] - back) / 1.6, p[1] / 1.9]);
    }),
  );
}

/** A hurricane lantern: tank, glass globe, cap. */
function lantern(m: MeshBuilder, at: Vec3) {
  m.lathe(at, [[0, 0], [0.05, 0], [0.053, 0.01], [0.05, 0.032], [0.032, 0.042], [0.028, 0.046]], MAT.tin, 24);
  m.lathe(at, [[0.028, 0.046], [0.038, 0.062], [0.042, 0.088], [0.038, 0.112], [0.027, 0.128]], MAT.glass, 24);
  m.lathe(at, [[0.029, 0.126], [0.046, 0.133], [0.042, 0.14], [0.027, 0.152], [0.01, 0.165], [0, 0.167]], MAT.tin, 24);
  arcTube(m, add(at, [0, 0.16, 0]), [1, 0, 0], [0, 1, 0], 0.052, 0, Math.PI, 0.002, MAT.iron, 10);
}

/** A brass tray with little glasses of tea and a silver teapot. */
function teaTray(m: MeshBuilder) {
  m.lathe([0, 0, 0], [[0, 0], [0.19, 0], [0.2, 0.008], [0.205, 0.016], [0.198, 0.017], [0.19, 0.008], [0, 0.008]], MAT.brass, 40);
  for (const [x, z] of [[-0.08, 0.07], [0.02, 0.1], [0.1, 0.03]]) {
    m.lathe([x, 0.008, z], [[0, 0], [0.022, 0], [0.025, 0.02], [0.021, 0.045], [0.026, 0.075], [0.024, 0.076], [0.019, 0.046], [0.02, 0.012], [0, 0.012]], MAT.teaGlass, 16);
  }
  // A Moroccan teapot: round belly, tall lid, a long curved spout.
  const pot: Vec3 = [-0.06, 0.008, -0.07];
  m.with([0.6, 0.6, 0.58], () => {
    m.lathe(pot, [[0, 0], [0.035, 0], [0.04, 0.008], [0.058, 0.04], [0.055, 0.075], [0.035, 0.1], [0.03, 0.11], [0.036, 0.113], [0.03, 0.14], [0.012, 0.165], [0.004, 0.18], [0, 0.182]], MAT.ceramic, 28);
    let prev = add(pot, [0.045, 0.03, 0]);
    for (let i = 1; i <= 6; i++) {
      const t = i / 6;
      const p = add(pot, [0.045 + 0.075 * t, 0.03 + 0.1 * t * t, 0]);
      frustum(m, prev, p, 0.011 - 0.006 * t + 0.001, 0.011 - 0.006 * t, 8, MAT.ceramic);
      prev = p;
    }
    arcTube(m, add(pot, [-0.052, 0.06, 0]), [0, 1, 0], [-1, 0, 0], 0.035, -1.2, 1.2, 0.005, MAT.ceramic, 8);
  });
}

/** A heap of dead branches gathered for the fire. */
function buildBranches(m: MeshBuilder, detail: Detail) {
  const rnd = random(77);
  const n = detail === 'high' ? 18 : 12;
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2;
    const start: Vec3 = [-1.25 + (rnd() - 0.5) * 0.4, 0.02 + rnd() * 0.12, 0.25 + (rnd() - 0.5) * 0.4];
    const dir = normalize([Math.cos(a), (rnd() - 0.3) * 0.25, Math.sin(a)]);
    branch(m, rnd, add(start, scale(dir, -0.3)), dir, 0.55 + rnd() * 0.45, 0.012 + rnd() * 0.012);
  }
}

/**
 * A kettle set down by the fire: a soot-blackened body, a domed lid, a long spout and a bail
 * handle. Returns where the tip of its spout is (for its steam).
 */
export function kettle(m: MeshBuilder, at: Vec3, toward: number) {
  m.at(at, toward, () => {
    m.lathe([0, 0, 0], [[0, 0], [0.055, 0], [0.062, 0.008], [0.07, 0.04], [0.066, 0.075], [0.048, 0.1], [0.036, 0.112], [0.036, 0.118]], MAT.kettle, 28);
    m.lathe([0, 0.116, 0], [[0.04, 0], [0.036, 0.012], [0.024, 0.024], [0.008, 0.03], [0.009, 0.036], [0.004, 0.042], [0, 0.043]], MAT.kettle, 24);
    // The spout, from low on its belly curving up and out.
    let prev: Vec3 = [0, 0.03, 0.06];
    for (let i = 1; i <= 7; i++) {
      const t = i / 7;
      const p: Vec3 = [0, 0.03 + 0.1 * t + 0.02 * t * t, 0.06 + 0.07 * t];
      frustum(m, prev, p, 0.013 - 0.006 * t + 0.001, 0.013 - 0.006 * t, 8, MAT.kettle);
      prev = p;
    }
    arcTube(m, [0, 0.12, 0], [1, 0, 0], [0, 1, 0], 0.062, 0.25, Math.PI - 0.25, 0.0035, MAT.iron, 12);
  });
}

/** Where the tip of the kettle's spout is (for its steam), and where its lid is. */
export function kettleVents(at: Vec3, toward: number): { spout: Vec3; lid: Vec3 } {
  const c = Math.cos(toward), s = Math.sin(toward);
  const tip: Vec3 = [0, 0.15, 0.13];
  return { spout: [at[0] + c * tip[0] + s * tip[2], at[1] + tip[1], at[2] - s * tip[0] + c * tip[2]], lid: [at[0], at[1] + 0.155, at[2]] };
}
