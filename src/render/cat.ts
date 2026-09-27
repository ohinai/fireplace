import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from '../math';
import { MAT, type MeshBuilder } from './geometry';

// A cat asleep by the fire: a brown tabby, lying on its front and stretched out long, rolled a
// little onto its right side. Its head is down on the floor, turned toward its left and resting
// on its chin, eyes shut and ears up; its left forepaw is stretched out by its chin and the other
// tucked under; its left hind leg is folded along its side, the foot forward; its tail lies round
// the far side of it. Built in its own frame: on the floor at the origin, +z ahead (the way its
// head points), +x to its left.
//
// Its coat is painted by catFur() (furnishings.wgsl), which has to know where on the cat each
// point is. So every vertex carries, in `extra`, its place in the frame of the part it is on,
// with ten times the part's number added to x:
const BODY = 0; // body and haunch (the cat's frame; it breathes)
const HEAD = 1; // head (the head's frame: x to its left, y up through its crown, z out along its nose)
const LEG = 2; // legs (the cat's frame)
const TAIL = 3; // tail (x: how far along it from the root, in m)
const EAR = 4; // an ear (x: across it, -1..1; y: up it, 0..1; z: +1 in front, -1 behind)
const NOSE = 5; // the nose (the head's frame)
const PAW = 6; // a forepaw and its toes (the paw's frame: x across, y up, z toward the toes)
const HIND = 7; // the hind paw (likewise)

const tag = (part: number, q: Vec3): Vec3 => [part * 10 + q[0], q[1], q[2]];

type Vertex = { p: Vec3; n: Vec3; e: Vec3 };
type Axes = [Vec3, Vec3, Vec3];

/** Where p is in a frame (origin o, axes at right angles). */
const local = (p: Vec3, o: Vec3, [a, b, c]: Axes): Vec3 => {
  const d = sub(p, o);
  return [dot(d, a), dot(d, b), dot(d, c)];
};

/** Triangles between neighbouring vertices of a grid (rows along, columns round). */
function grid(m: MeshBuilder, rows: Vertex[][]) {
  for (let i = 0; i + 1 < rows.length; i++) {
    const cols = rows[i].length;
    for (let j = 0; j < cols; j++) {
      const k = (j + 1) % cols;
      for (const [a, b] of [[i, j], [i + 1, j], [i + 1, k], [i, j], [i + 1, k], [i, k]]) {
        const v = rows[a][b];
        m.extra = v.e;
        m.vertex(v.p, v.n, [0, 0], MAT.fur);
      }
    }
  }
}

/** An ellipsoid with its own axes (unit, at right angles) and radii along them. */
function ovoid(m: MeshBuilder, centre: Vec3, axes: Axes, r: Vec3, mark: (p: Vec3) => Vec3, rows = 10, cols = 16) {
  const [a, b, c] = axes;
  const out: Vertex[][] = [];
  for (let i = 0; i <= rows; i++) {
    const lat = (i / rows) * Math.PI - Math.PI / 2;
    const ring: Vertex[] = [];
    for (let j = 0; j < cols; j++) {
      const lon = (j / cols) * Math.PI * 2;
      const u: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      const p = add(centre, add(add(scale(a, u[0] * r[0]), scale(b, u[1] * r[1])), scale(c, u[2] * r[2])));
      const n = normalize(add(add(scale(a, u[0] / r[0]), scale(b, u[1] / r[1])), scale(c, u[2] / r[2])));
      ring.push({ p, n, e: mark(p) });
    }
    out.push(ring);
  }
  grid(m, out);
}

const LEVEL: Axes = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

/**
 * A tube along a path, round in section (a radius at each point), its ends rounded off. `mark`
 * is given each point and how far along the path it is.
 */
function tube(m: MeshBuilder, path: Vec3[], radius: number[], mark: (p: Vec3, s: number) => Vec3, sides = 12) {
  const rows: Vertex[][] = [];
  const t0 = normalize(sub(path[1], path[0]));
  let side = cross(t0, [0, 1, 0]);
  side = length(side) < 1e-3 ? [1, 0, 0] : normalize(side);
  let s = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) s += length(sub(path[i], path[i - 1]));
    const t = normalize(sub(path[Math.min(i + 1, path.length - 1)], path[Math.max(i - 1, 0)]));
    // (The frame is carried along the path without twisting.)
    side = normalize(sub(side, scale(t, dot(side, t))));
    const up = cross(t, side);
    const ring: Vertex[] = [];
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const n = add(scale(side, Math.cos(a)), scale(up, Math.sin(a)));
      const p = add(path[i], scale(n, radius[i]));
      ring.push({ p, n, e: mark(p, s) });
    }
    rows.push(ring);
  }
  grid(m, rows);
  const last = path.length - 1;
  ovoid(m, path[0], LEVEL, [radius[0], radius[0], radius[0]], (p) => mark(p, 0), 6, sides);
  ovoid(m, path[last], LEVEL, [radius[last], radius[last], radius[last]], (p) => mark(p, s), 6, sides);
}

// ---- Body ---------------------------------------------------------------------------------

const ROLL = 0.32; // (it lies a little over on its right side, its left flank turned up)
const SR = Math.sin(ROLL);
const CR = Math.cos(ROLL);
const ACROSS: Vec3 = [CR, SR, 0]; // across its back, to its left
const UP: Vec3 = [-SR, CR, 0]; // up through its back

// From its rump to its neck: how far along (m), half its width, and half its height above and
// below its middle. Behind the first, its rump is rounded off.
const PROFILE: number[][] = [
  [-0.175, 0.07, 0.088, 0.052],
  [-0.13, 0.075, 0.094, 0.055],
  [-0.07, 0.071, 0.08, 0.056],
  [-0.02, 0.072, 0.072, 0.055],
  [0.03, 0.072, 0.073, 0.053],
  [0.08, 0.066, 0.068, 0.048],
  [0.115, 0.057, 0.061, 0.042],
  [0.145, 0.047, 0.05, 0.034],
  [0.175, 0.038, 0.04, 0.028],
  [0.205, 0.032, 0.032, 0.023],
];
const RUMP = 0.065;

/** Column k of PROFILE at z, smoothly (Catmull-Rom). */
function profile(z: number, k: number): number {
  const P = PROFILE;
  const n = P.length;
  if (z <= P[0][0]) return P[0][k];
  if (z >= P[n - 1][0]) return P[n - 1][k];
  let i = 1;
  while (P[i][0] < z) i++;
  const [p0, p1, p2, p3] = [P[Math.max(i - 2, 0)][k], P[i - 1][k], P[i][k], P[Math.min(i + 1, n - 1)][k]];
  const t = (z - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (3 * p1 - p0 - 3 * p2 + p3) * t * t * t);
}

/** The middle of its body at z: its belly resting on the floor (a little sunk into it). */
function middle(z: number): Vec3 {
  const zc = Math.max(z, PROFILE[0][0]);
  return [0, Math.hypot(profile(zc, 1) * SR, profile(zc, 3) * CR) - 0.003, z];
}

/** The body's surface at z, a round its section (0: its left side; pi / 2: its back). */
function bodySurface(z: number, a: number): Vec3 {
  const zc = Math.max(z, PROFILE[0][0]);
  const round = z < PROFILE[0][0] ? Math.sqrt(Math.max(0, 1 - ((PROFILE[0][0] - z) / RUMP) ** 2)) : 1;
  const h = profile(zc, Math.sin(a) > 0 ? 2 : 3);
  return add(middle(z), add(scale(ACROSS, Math.cos(a) * profile(zc, 1) * round), scale(UP, Math.sin(a) * h * round)));
}

function body(m: MeshBuilder) {
  const zs: number[] = [];
  for (let i = 0; i < 8; i++) zs.push(PROFILE[0][0] - RUMP * Math.cos((i / 8) * (Math.PI / 2)));
  const end = PROFILE[PROFILE.length - 1][0];
  for (let i = 0; i <= 30; i++) zs.push(PROFILE[0][0] + ((end - PROFILE[0][0]) * i) / 30);
  const sides = 28;
  const e = 1e-4;
  const rows = zs.map((z) =>
    Array.from({ length: sides }, (_, j): Vertex => {
      const a = (j / sides) * Math.PI * 2;
      const p = bodySurface(z, a);
      let n = cross(sub(bodySurface(z, a + e), bodySurface(z, a - e)), sub(bodySurface(z + e, a), bodySurface(z - e, a)));
      if (length(n) < 1e-12) n = [0, 0, -1]; // (the very end of its rump)
      n = normalize(n);
      if (dot(n, sub(p, middle(z))) < 0) n = scale(n, -1);
      return { p, n, e: tag(BODY, p) };
    }),
  );
  grid(m, rows);
  // Its left haunch, the thigh folded forward along its side.
  const along = normalize([0.03, -0.05, 0.1]);
  let out: Vec3 = [1, 0.2, -0.05];
  out = normalize(sub(out, scale(along, dot(out, along))));
  ovoid(m, [0.058, 0.07, -0.14], [out, cross(along, out), along], [0.04, 0.06, 0.074], (p) => tag(BODY, p), 12, 18);
}

// ---- Legs, paws and tail -------------------------------------------------------------------

/** A paw at `centre`, pointing along `dir` on the floor, with four toes in front. */
function paw(m: MeshBuilder, centre: Vec3, dir: Vec3, part: number, size = 1) {
  const z = normalize([dir[0], 0, dir[2]]);
  const y: Vec3 = [0, 1, 0];
  const x = cross(y, z);
  const axes: Axes = [x, y, z];
  const mark = (p: Vec3) => tag(part, local(p, centre, axes));
  ovoid(m, centre, axes, [0.0175 * size, 0.012 * size, 0.022 * size], mark, 8, 14);
  for (const k of [-1.5, -0.5, 0.5, 1.5]) {
    const toe = add(centre, add(add(scale(x, k * 0.0072 * size), scale(z, 0.0165 * size)), [0, 0.0012, 0]));
    ovoid(m, toe, axes, [0.0062 * size, 0.0068 * size, 0.0066 * size], mark, 6, 10);
  }
}

function legs(m: MeshBuilder) {
  const leg = (p: Vec3) => tag(LEG, p);
  // Left foreleg: down from the shoulder to the elbow on the floor, then stretched out ahead.
  const wrist: Vec3 = [0.076, 0.017, 0.192];
  tube(m, [[0.042, 0.066, 0.105], [0.056, 0.042, 0.096], [0.066, 0.021, 0.085], [0.071, 0.018, 0.14], wrist], [0.025, 0.023, 0.02, 0.017, 0.0145], leg);
  paw(m, add(wrist, [0.002, -0.003, 0.021]), [0.096, 0, 1], PAW);
  // Right foreleg, tucked under its chest, only the paw showing.
  tube(m, [[-0.022, 0.03, 0.085], [-0.026, 0.019, 0.13], [-0.03, 0.016, 0.172]], [0.019, 0.016, 0.0145], leg);
  paw(m, [-0.032, 0.013, 0.193], [-0.08, 0, 1], PAW, 0.95);
  // Left hind foot, from the hock at the back of its haunch forward along the floor.
  tube(m, [[0.064, 0.024, -0.212], [0.074, 0.019, -0.175], [0.084, 0.016, -0.138]], [0.017, 0.015, 0.0135], leg);
  paw(m, [0.088, 0.013, -0.117], [0.26, 0, 0.97], HIND, 1.05);
}

function tail(m: MeshBuilder) {
  const path: Vec3[] = [
    [-0.02, 0.058, -0.205],
    [-0.04, 0.036, -0.238],
    [-0.075, 0.02, -0.247],
    [-0.09, 0.017, -0.214],
    [-0.097, 0.016, -0.15],
    [-0.095, 0.016, -0.08],
    [-0.089, 0.016, -0.01],
    [-0.08, 0.015, 0.055],
    [-0.064, 0.0135, 0.105],
  ];
  const radius = [0.02, 0.019, 0.018, 0.017, 0.0165, 0.016, 0.015, 0.0135, 0.0115];
  tube(m, path, radius, (_, s) => tag(TAIL, [s, 0, 0]), 12);
}

// ---- Head ---------------------------------------------------------------------------------

// Its head: turned toward its left, nose down, and tipped over onto its right cheek.
const TURN = 1.05;
const DROOP = 0.22;
const TILT = 0.55;
const HEAD_SIZE = 1.12; // (the shapes below are for a head this much smaller; catFur sees them so)

function headAxes(): Axes {
  const x0: Vec3 = [Math.cos(TURN), 0, -Math.sin(TURN)];
  const z0: Vec3 = [Math.sin(TURN), 0, Math.cos(TURN)];
  const y0: Vec3 = [0, 1, 0];
  const z1 = sub(scale(z0, Math.cos(DROOP)), scale(y0, Math.sin(DROOP)));
  const y1 = add(scale(y0, Math.cos(DROOP)), scale(z0, Math.sin(DROOP)));
  const x2 = add(scale(x0, Math.cos(TILT)), scale(y1, Math.sin(TILT)));
  const y2 = sub(scale(y1, Math.cos(TILT)), scale(x0, Math.sin(TILT)));
  return [x2, y2, z1];
}

// The rounded shapes of its head, in the head's frame: centre and radii.
const SKULL: [Vec3, Vec3] = [[0, 0, 0], [0.045, 0.038, 0.043]];
const FACE: [Vec3, Vec3][] = [
  [[0.02, -0.011, 0.01], [0.026, 0.025, 0.03]], // cheeks
  [[-0.02, -0.011, 0.01], [0.026, 0.025, 0.03]],
  [[0, 0.005, 0.034], [0.0095, 0.011, 0.02]], // the bridge of its nose
  [[0, -0.012, 0.037], [0.021, 0.016, 0.019]], // muzzle
  [[0.0095, -0.0125, 0.0435], [0.0115, 0.0105, 0.011]], // whisker pads
  [[-0.0095, -0.0125, 0.0435], [0.0115, 0.0105, 0.011]],
  [[0, -0.025, 0.031], [0.0115, 0.009, 0.013]], // chin
];
const NOSE_LEATHER: [Vec3, Vec3] = [[0, -0.0015, 0.0525], [0.0062, 0.0042, 0.0035]];

function head(m: MeshBuilder) {
  const axes = headAxes();
  const [hx, hy, hz] = axes;
  // Low enough that it rests on the floor.
  const shapes = [SKULL, ...FACE];
  const k = HEAD_SIZE;
  let drop = 0;
  for (const [c, r] of shapes) {
    const reach = k * Math.hypot(r[0] * hx[1], r[1] * hy[1], r[2] * hz[1]);
    drop = Math.max(drop, reach - k * (c[0] * hx[1] + c[1] * hy[1] + c[2] * hz[1]));
  }
  const centre: Vec3 = [0.022, drop - 0.002, 0.238];
  const inHead = (q: Vec3): Vec3 => add(centre, scale(add(add(scale(hx, q[0]), scale(hy, q[1])), scale(hz, q[2])), k));
  const mark = (part: number) => (p: Vec3) => tag(part, scale(local(p, centre, axes), 1 / k));
  for (const [c, r] of shapes) ovoid(m, inHead(c), axes, scale(r, k), mark(HEAD), c === SKULL[0] ? 14 : 8, c === SKULL[0] ? 22 : 14);
  ovoid(m, inHead(NOSE_LEATHER[0]), axes, scale(NOSE_LEATHER[1], k), mark(NOSE), 6, 10);
  // Ears: pricked up, a little apart and back; cupped in front, rounded behind.
  for (const s of [-1, 1]) ear(m, inHead([s * 0.025, 0.029, -0.005]), inHead([s * 0.035, 0.064, -0.013]), hz);
}

/** An ear from its base (on the head) up to its tip; `ahead`: the way the head faces. */
function ear(m: MeshBuilder, base: Vec3, tip: Vec3, ahead: Vec3) {
  const up = normalize(sub(tip, base));
  const front = normalize(sub(ahead, scale(up, dot(ahead, up))));
  const across = cross(up, front);
  const width = 0.019 * HEAD_SIZE;
  const at = (a: number, v: number): Vec3 => {
    const depth = Math.sin(a) > 0 ? -0.0025 : 0.009; // (the front is hollowed, the back rounded)
    return add(add(base, scale(sub(tip, base), v)), scale(add(scale(across, Math.cos(a) * width), scale(front, Math.sin(a) * depth)), 1 - v));
  };
  const sides = 18;
  const steps = 7;
  const rows: Vertex[][] = [];
  const e = 1e-3;
  for (let i = 0; i <= steps; i++) {
    const v = (i / steps) * 0.999;
    const ring: Vertex[] = [];
    for (let j = 0; j < sides; j++) {
      const a = (j / sides) * Math.PI * 2;
      const p = at(a, v);
      let n = normalize(cross(sub(at(a + e, v), at(a - e, v)), sub(at(a, v + e), at(a, Math.max(v - e, 0)))));
      const outward = add(scale(across, Math.cos(a)), scale(front, Math.sign(Math.sin(a)) * Math.max(Math.abs(Math.sin(a)), 0.3)));
      if (dot(n, outward) < 0) n = scale(n, -1);
      ring.push({ p, n, e: tag(EAR, [Math.cos(a), v, Math.sin(a) > 0 ? 1 : -1]) });
    }
    rows.push(ring);
  }
  grid(m, rows);
}

/** The cat, placed at `at` on the floor, turned by `yaw` (it faces (sin yaw, 0, cos yaw)). */
export function cat(m: MeshBuilder, at: Vec3, yaw: number) {
  const before = m.extra;
  m.at(at, yaw, () => {
    body(m);
    legs(m);
    tail(m);
    head(m);
  });
  m.extra = before;
}
