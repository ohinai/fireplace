import { WOODS } from '../config';
import { add, cross, length, normalize, scale, sub, type Vec3 } from '../math';
import { MAT, noise2, type MeshBuilder, type UV } from './geometry';

// Wood that lies about: split firewood stacked by the hearth, and the twisted, sun-bleached
// branches gathered for a fire in the desert.

/** A small deterministic random number generator (0..1). */
export function random(seed: number): () => number {
  let s = Math.max(1, Math.floor(seed) % 2147483646);
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** How a piece of firewood was split from its log: whole, in half, or in quarters. */
export type Split = 'round' | 'half' | 'quarter';

export interface Firewood {
  a: Vec3; // one end of its centre line
  b: Vec3; // the other
  radius: number; // of the log it was split from
  split: Split;
  turn: number; // roll about its length (which way its split faces look)
  wood: string; // (WOODS key) for its bark and heartwood
  seed: number;
}

interface Pt {
  x: number;
  y: number;
  bark: boolean;
  th: number; // angle round the pith
}

/**
 * A piece's cross-section: pith at the origin, an arc of bark and, for a split piece, two rough
 * faces from the pith out to it; a closed outline going round anticlockwise. (cx, cy) is its
 * middle, which lies on the line a..b; e1 and e2 span it in the world.
 */
function section(f: Firewood) {
  const rnd = random(f.seed * 7919 + 13);
  const d = normalize(sub(f.b, f.a));
  let u = cross(d, [0, 1, 0]);
  if (length(u) < 0.1) u = cross(d, [1, 0, 0]);
  u = normalize(u);
  const w = cross(d, u);
  const e1 = add(scale(u, Math.cos(f.turn)), scale(w, Math.sin(f.turn)));
  const e2 = cross(d, e1);
  const R = f.radius;
  const arc: [number, number] = f.split === 'round' ? [0, Math.PI * 2] : f.split === 'half' ? [0, Math.PI] : [0, Math.PI / 2];
  const arcSteps = f.split === 'round' ? 20 : f.split === 'half' ? 12 : 7;
  const lump = (th: number) => 1 + 0.07 * (noise2(Math.cos(th) * 2.5 + f.seed, Math.sin(th) * 2.5) - 0.5) + 0.03 * Math.sin(th * 7 + f.seed);
  const rim = (th: number): Pt => ({ x: R * lump(th) * Math.cos(th), y: R * lump(th) * Math.sin(th), bark: true, th });
  const pts: Pt[] = [];
  // A split face wanders along the grain rather than running true.
  const face = (from: Pt, to: Pt) => {
    const nx = -(to.y - from.y), ny = to.x - from.x;
    const nl = Math.hypot(nx, ny) || 1;
    for (const t of [1 / 3, 2 / 3]) {
      const wob = (rnd() - 0.5) * 0.08 * R;
      const x = from.x + (to.x - from.x) * t + (nx / nl) * wob;
      const y = from.y + (to.y - from.y) * t + (ny / nl) * wob;
      pts.push({ x, y, bark: false, th: Math.atan2(y, x) });
    }
  };
  const pith: Pt = { x: 0, y: 0, bark: false, th: 0 };
  if (f.split !== 'round') {
    pts.push(pith);
    face(pith, rim(arc[0]));
  }
  for (let i = 0; i < (f.split === 'round' ? arcSteps : arcSteps + 1); i++) pts.push(rim(arc[0] + ((arc[1] - arc[0]) * i) / arcSteps));
  if (f.split !== 'round') face(rim(arc[1]), pith);
  let cx = 0, cy = 0;
  if (f.split !== 'round') {
    for (const p of pts) {
      cx += p.x / pts.length;
      cy += p.y / pts.length;
    }
  }
  return { pts, cx, cy, d, e1, e2, R, rnd };
}

/**
 * A piece of split firewood: bark round the outside, rough split faces through the middle of the
 * log, and sawn ends showing the growth rings. Its outline is a little irregular, it bends a
 * little along its length, and its ends are not quite square.
 */
export function firewood(m: MeshBuilder, f: Firewood) {
  const { pts, cx, cy, d, e1, e2, R, rnd } = section(f);
  const n = pts.length;
  const L = length(sub(f.b, f.a));
  const wood = WOODS[f.wood] ?? WOODS.oak;
  const endExtra: Vec3 = [R, wood.heart, f.seed % 97];

  // Along it: a gentle bend, and ends sawn a little off square.
  const rings = 6;
  const bend = [(rnd() - 0.5) * 0.2 * R, (rnd() - 0.5) * 0.2 * R];
  const tilt = [[(rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12], [(rnd() - 0.5) * 0.12, (rnd() - 0.5) * 0.12]];
  const along = (k: number, p: { x: number; y: number }) => {
    const shift = k === 0 ? tilt[0][0] * p.x + tilt[0][1] * p.y : k === rings ? tilt[1][0] * p.x + tilt[1][1] * p.y : 0;
    return (k / rings) * L + shift;
  };
  const place = (k: number, p: { x: number; y: number }): Vec3 => {
    const b = Math.sin((Math.PI * k) / rings);
    return add(add(add(f.a, scale(d, along(k, p))), scale(e1, p.x - cx + bend[0] * b)), scale(e2, p.y - cy + bend[1] * b));
  };
  const radial = (p: Pt): Vec3 => normalize(add(scale(e1, Math.cos(p.th)), scale(e2, Math.sin(p.th))));

  // The sides: bark where the outline is bark, split faces elsewhere. (uv: along, and round
  // the bark or out from the pith, in m.)
  const cum = [0];
  for (let i = 1; i <= n; i++) cum.push(cum[i - 1] + Math.hypot(pts[i % n].x - pts[i - 1].x, pts[i % n].y - pts[i - 1].y));
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const bark = p.bark && q.bark;
    let np: Vec3, nq: Vec3;
    if (bark) {
      np = radial(p);
      nq = radial(q);
    } else {
      np = nq = normalize(cross(add(scale(e1, q.x - p.x), scale(e2, q.y - p.y)), d));
    }
    const vp = bark ? cum[i] : Math.hypot(p.x, p.y);
    const vq = bark ? cum[i + 1] : Math.hypot(q.x, q.y);
    m.with(bark ? wood.bark : endExtra, () => {
      for (let k = 0; k < rings; k++) {
        const c = [place(k, p), place(k + 1, p), place(k + 1, q), place(k, q)];
        const nn = [np, np, nq, nq];
        const uv: UV[] = [[along(k, p), vp], [along(k + 1, p), vp], [along(k + 1, q), vq], [along(k, q), vq]];
        for (const j of [0, 1, 2, 0, 2, 3]) m.vertex(c[j], nn[j], uv[j], bark ? MAT.bark : MAT.splitWood);
      }
    });
  }

  // The sawn ends: a fan round the pith (uv: distance from the pith, angle round it).
  m.with(endExtra, () => {
    for (const k of [0, rings]) {
      const nrm = scale(d, k === 0 ? -1 : 1);
      const pc = place(k, { x: 0, y: 0 });
      for (let i = 0; i < n; i++) {
        const p = pts[i];
        const q = pts[(i + 1) % n];
        const rp = Math.hypot(p.x, p.y);
        const rq = Math.hypot(q.x, q.y);
        if (rp < 1e-6 || rq < 1e-6) continue;
        const ta = Math.atan2(p.y, p.x);
        let tb = Math.atan2(q.y, q.x);
        if (tb < ta - Math.PI) tb += Math.PI * 2;
        if (tb > ta + Math.PI) tb -= Math.PI * 2;
        m.vertex(pc, nrm, [0, (ta + tb) / 2], MAT.endGrain);
        m.vertex(place(k, p), nrm, [rp, ta], MAT.endGrain);
        m.vertex(place(k, q), nrm, [rq, tb], MAT.endGrain);
      }
    }
  });
}

/**
 * Firewood stacked lengthways along z, as by a hearth, across x0..x1 on the floor at `floor`,
 * cut ends at z0 and z1: laid a piece at a time, each lying on a flat face where it has one and
 * settling onto whatever is below it, each row a little narrower than the one under it.
 */
export function woodStack(m: MeshBuilder, x0: number, x1: number, floor: number, z0: number, z1: number, rows: number, woods: string[], seed: number) {
  const rnd = random(seed);
  const step = 0.003;
  const cells = Math.ceil((x1 - x0) / step) + 1;
  const ground = new Float32Array(cells).fill(floor); // height of the stack so far across x
  const cell = (x: number) => Math.min(cells - 1, Math.max(0, Math.round((x - x0) / step)));
  let count = 0;
  for (let level = 0; level < rows; level++) {
    const inset = level * 0.035;
    let x = x0 + inset + rnd() * 0.01;
    while (true) {
      const r = rnd();
      const split: Split = r < 0.42 ? 'quarter' : r < 0.84 ? 'half' : 'round';
      const radius = split === 'round' ? 0.028 + 0.008 * rnd() : split === 'half' ? 0.04 + 0.01 * rnd() : 0.05 + 0.012 * rnd();
      // Lying on a flat face: a half on its split face, a quarter on either of its faces.
      const turn = (split === 'half' ? Math.PI : split === 'quarter' ? (rnd() < 0.5 ? Math.PI : 1.5 * Math.PI) : rnd() * 6) + (rnd() - 0.5) * 0.12;
      const za = z0 + (rnd() - 0.5) * 0.03;
      const zb = z1 + (rnd() - 0.5) * 0.03;
      const f: Firewood = { a: [0, 0, za], b: [0, 0, zb], radius, split, turn, wood: woods[Math.floor(rnd() * woods.length)], seed: seed * 31 + count };
      // Its outline across x and y, in the world, about its centre line.
      const { pts, cx, cy, e1, e2 } = section(f);
      const outline = pts.map((p) => [e1[0] * (p.x - cx) + e2[0] * (p.y - cy), e1[1] * (p.x - cx) + e2[1] * (p.y - cy)]);
      const minX = Math.min(...outline.map((p) => p[0]));
      const maxX = Math.max(...outline.map((p) => p[0]));
      if (x + maxX - minX > x1 - inset) break;
      const centre = x - minX;
      // Lower it until some part of its underside touches the stack.
      let lift = -Infinity;
      const under: [number, number][] = [];
      for (let s = minX; s <= maxX; s += step) {
        const [lo, hi] = span(outline, s);
        under.push([lo, hi]);
        lift = Math.max(lift, ground[cell(centre + s)] - lo);
      }
      under.forEach(([, hi], i) => {
        const c = cell(centre + minX + i * step);
        ground[c] = Math.max(ground[c], lift + hi);
      });
      firewood(m, { ...f, a: [centre, lift, za], b: [centre, lift, zb] });
      count++;
      x += maxX - minX + 0.002 + rnd() * 0.006;
    }
  }
}

/** Lowest and highest points of a closed outline at x (by its edges crossing there). */
function span(outline: number[][], x: number): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < outline.length; i++) {
    const [ax, ay] = outline[i];
    const [bx, by] = outline[(i + 1) % outline.length];
    if ((ax - x) * (bx - x) > 0 || ax === bx) continue;
    const y = ay + ((by - ay) * (x - ax)) / (bx - ax);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  return Number.isFinite(lo) ? [lo, hi] : [0, 0];
}

/**
 * A dead branch as gathered in the desert: twisting as it goes, tapering, forking now and then,
 * its bark long gone and the wood bleached grey by the sun. Grows from `start` along `dir`.
 */
export function branch(m: MeshBuilder, rnd: () => number, start: Vec3, dir: Vec3, len: number, radius: number, depth = 0) {
  const segments = 4 + Math.floor(rnd() * 3);
  const step = len / segments;
  let p = start;
  let heading = normalize(dir);
  let r = radius;
  const sides = depth === 0 ? 8 : 6;
  for (let i = 0; i < segments; i++) {
    // Wander: turn a little each way, and sag toward the ground.
    const kink: Vec3 = [(rnd() - 0.5) * 0.7, (rnd() - 0.5) * 0.35 - 0.08, (rnd() - 0.5) * 0.7];
    heading = normalize(add(heading, kink));
    const q = add(p, scale(heading, step * (0.8 + 0.4 * rnd())));
    const r1 = Math.max(r * (0.8 + 0.1 * rnd()), 0.0025);
    frustum(m, p, q, r, r1, sides, MAT.driftwood, depth * 0.37 + i * step);
    if (depth < 2 && i > 0 && rnd() < 0.4) {
      // A fork: off to one side, thinner and shorter.
      const side = normalize(cross(heading, [rnd() - 0.5, 1, rnd() - 0.5]));
      const fork = normalize(add(heading, scale(side, 0.8 + 0.8 * rnd())));
      branch(m, rnd, p, fork, len * (0.25 + 0.3 * rnd()), r * (0.45 + 0.2 * rnd()), depth + 1);
    }
    p = q;
    r = r1;
  }
  // A broken-off tip.
  frustum(m, p, add(p, scale(heading, r * 1.5)), r, r * 0.3, sides, MAT.driftwood, len);
}

/** A tapered tube from a (radius ra) to b (radius rb), uv along (m) and around (m). */
export function frustum(m: MeshBuilder, a: Vec3, b: Vec3, ra: number, rb: number, sides: number, mat: number, uvStart = 0) {
  const axis = sub(b, a);
  const len = length(axis);
  if (len < 1e-5) return;
  const d = scale(axis, 1 / len);
  let e1 = cross(d, [0, 1, 0]);
  if (length(e1) < 0.1) e1 = cross(d, [1, 0, 0]);
  e1 = normalize(e1);
  const e2 = cross(d, e1);
  const slope = (ra - rb) / len;
  for (let i = 0; i < sides; i++) {
    const t0 = (i / sides) * Math.PI * 2;
    const t1 = ((i + 1) / sides) * Math.PI * 2;
    const dir = (t: number) => add(scale(e1, Math.cos(t)), scale(e2, Math.sin(t)));
    const nrm = (t: number) => normalize(add(dir(t), scale(d, slope)));
    const c = [add(a, scale(dir(t0), ra)), add(b, scale(dir(t0), rb)), add(b, scale(dir(t1), rb)), add(a, scale(dir(t1), ra))];
    const n = [nrm(t0), nrm(t0), nrm(t1), nrm(t1)];
    const uv: UV[] = [[uvStart, t0 * ra], [uvStart + len, t0 * rb], [uvStart + len, t1 * rb], [uvStart, t1 * ra]];
    for (const j of [0, 1, 2, 0, 2, 3]) m.vertex(c[j], n[j], uv[j], mat);
  }
}
