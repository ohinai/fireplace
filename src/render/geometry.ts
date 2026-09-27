import { BED_HEIGHT, FIREBOX, grateFingers, type Detail } from '../config';
import { add, cross, length, normalize, scale, sub, type Vec3 } from '../math';
import { ANDIRONS, GRATE_BARS, type Rect, type Room } from '../rooms';
import { buildBrickRoom } from './brickroom';
import { buildCampsite } from './campfire';
import { buildDesert, kettle } from './desert';
import { arcTube } from './furniture';
import { frustum } from './props';
import { buildHacienda } from './hacienda';

// Material ids (must match scene.wgsl). Logs are drawn separately (logs.wgsl).
export const MAT = {
  firebrick: 0,
  brick: 1,
  hearth: 2,
  iron: 3,
  embers: 5,
  floor: 6,
  mantel: 7,
  soot: 8,
  brass: 9,
  // The hacienda.
  plaster: 10,
  dado: 11,
  adobe: 12,
  talavera: 13,
  terracotta: 14,
  beam: 15,
  pottery: 16,
  bark: 17,
  endGrain: 18,
  wax: 19,
  flame: 20,
  rug: 21,
  // The campsite.
  sky: 22,
  ground: 23,
  stone: 24,
  // Lamps, firelighters, the match.
  shade: 26,
  glass: 27,
  firelighter: 28,
  match: 29,
  matchHead: 30,
  jar: 31,
  tin: 32,
  // Critters.
  glow: 33,
  critter: 34,
  // Firewood lying about.
  splitWood: 35,
  driftwood: 36,
  // Furnishings.
  wicker: 37,
  fabric: 38, // extra: colour
  book: 39, // extra: colour seed, bottom, height
  painting: 40, // extra: seed
  gilt: 41,
  clockFace: 42,
  paint: 43, // extra: colour
  finish: 44, // varnished wood; extra: colour
  fur: 45, // a cat's coat (extra: where on the cat, part by part: see cat.ts)
  leaf: 46, // extra: colour
  ceramic: 47, // extra: colour
  pages: 48,
  plate: 49, // a Talavera plate
  chile: 50,
  needles: 51, // a pine's
  // The desert.
  sand: 52,
  tent: 53, // woven goat hair
  kettle: 54, // sooty metal (uv.y: height up it)
  teaGlass: 55,
  mountain: 56, // (uv.x: height up it)
  hair: 57, // Bigfoot's
} as const;

/** Floats per vertex: position(3) normal(3) uv(2) material(1) extra(3). */
export const VERTEX_FLOATS = 12;
/**
 * Something that turns see-through when it comes between the eye and the fire has its number
 * (1 up) times this added to its material.
 */
export const SEE_THROUGH = 128;
/** The most things in a scene that can turn see-through (one uniform slot each, and slot 0 unused). */
export const MAX_CLEARINGS = 31;
const VOXEL = 0.08; // m: the grid on which they are known

/**
 * Where the things that turn see-through are, as the cells of a coarse grid their surfaces pass
 * through, each holding the thing's number: a line of sight stepped through it finds what stands
 * in the way.
 */
export class Clearings {
  readonly cells = new Map<number, number>();
  count = 0;

  static key(x: number, y: number, z: number): number {
    const i = Math.floor(x / VOXEL) + 1024;
    const j = Math.floor(y / VOXEL) + 1024;
    const k = Math.floor(z / VOXEL) + 1024;
    return (i * 2048 + j) * 2048 + k;
  }

  /** Adds the numbers of what stands between a and b to `hits` (leaving out the last `spare` m before b). */
  between(a: Vec3, b: Vec3, spare: number, hits: Set<number>) {
    const d = sub(b, a);
    const len = Math.hypot(d[0], d[1], d[2]);
    const step = VOXEL * 0.5;
    for (let s = 0; s * step < len - spare; s++) {
      const t = (s * step) / len;
      const id = this.cells.get(Clearings.key(a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t));
      if (id) hits.add(id);
    }
  }

  /** Marks the cells the triangles (corners, three floats each, three corners each) pass through. */
  add(id: number, corners: number[]) {
    for (let t = 0; t + 8 < corners.length; t += 9) {
      const a: Vec3 = [corners[t], corners[t + 1], corners[t + 2]];
      const ab = sub([corners[t + 3], corners[t + 4], corners[t + 5]], a);
      const ac = sub([corners[t + 6], corners[t + 7], corners[t + 8]], a);
      const longest = Math.max(Math.hypot(...ab), Math.hypot(...ac), Math.hypot(ab[0] - ac[0], ab[1] - ac[1], ab[2] - ac[2]));
      const n = Math.max(1, Math.ceil(longest / (VOXEL * 0.5)));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; i + j <= n; j++) {
          const u = i / n, v = j / n;
          this.cells.set(Clearings.key(a[0] + ab[0] * u + ac[0] * v, a[1] + ab[1] * u + ac[1] * v, a[2] + ab[2] * u + ac[2] * v), id);
        }
      }
    }
  }
}

export type UV = [number, number];

export class MeshBuilder {
  private readonly v: number[] = [];
  /** A material's own settings for what is being built (a seed, a tint...), put on every vertex. */
  extra: Vec3 = [0, 0, 0];
  // Where what is being built goes: moved to o and turned about the vertical (see at()).
  private place: { o: Vec3; c: number; s: number } | null = null;
  /** The things built that turn see-through, and where they are. */
  readonly clearings = new Clearings();
  private clear = 0; // the number of the see-through thing being built (0: none)
  private corners: number[] = []; // (its triangles)

  vertex(p: Vec3, n: Vec3, uv: UV, mat: number) {
    const e = this.extra;
    const t = this.place;
    if (t) {
      p = [t.o[0] + t.c * p[0] + t.s * p[2], t.o[1] + p[1], t.o[2] - t.s * p[0] + t.c * p[2]];
      n = [t.c * n[0] + t.s * n[2], n[1], -t.s * n[0] + t.c * n[2]];
    }
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], mat + SEE_THROUGH * this.clear, e[0], e[1], e[2]);
    if (this.clear) this.corners.push(p[0], p[1], p[2]);
  }

  /**
   * Builds a thing that fades to a ghost of itself when it comes between the eye and the fire, so
   * that looking round, furniture (or a tent) never hides the fire. (Inside another, it is part
   * of that one.)
   */
  seeThrough(build: () => void) {
    if (this.clear || this.clearings.count >= MAX_CLEARINGS) {
      build();
      return;
    }
    this.clear = ++this.clearings.count;
    this.corners = [];
    build();
    this.clearings.add(this.clear, this.corners);
    this.clear = 0;
    this.corners = [];
  }

  /** Builds something with the material settings `extra`. */
  with(extra: Vec3, build: () => void) {
    const before = this.extra;
    this.extra = extra;
    build();
    this.extra = before;
  }

  /**
   * Builds something in its own frame, then puts it at `origin`, turned by `yaw` about the
   * vertical (its +z, its front, then faces (sin yaw, 0, cos yaw)). Placements nest.
   */
  at(origin: Vec3, yaw: number, build: () => void) {
    const before = this.place;
    const o: Vec3 = before
      ? [before.o[0] + before.c * origin[0] + before.s * origin[2], before.o[1] + origin[1], before.o[2] - before.s * origin[0] + before.c * origin[2]]
      : origin;
    const a = (before ? Math.atan2(before.s, before.c) : 0) + yaw;
    this.place = { o, c: Math.cos(a), s: Math.sin(a) };
    build();
    this.place = before;
  }

  /**
   * A solid with eight corners: 0-3 round the bottom (-x-z, +x-z, +x+z, -x+z) and 4-7 above them.
   * Flat faces; uv in m across each face.
   */
  hexa(c: Vec3[], mat: number) {
    const faces = [[0, 1, 2, 3], [4, 7, 6, 5], [3, 2, 6, 7], [1, 0, 4, 5], [2, 1, 5, 6], [0, 3, 7, 4]];
    for (const [i, j, k, l] of faces) {
      const n = normalize(cross(sub(c[k], c[i]), sub(c[l], c[j])));
      const t1 = normalize(sub(c[j], c[i]));
      const t2 = cross(n, t1);
      const uv = (p: Vec3): UV => [p[0] * t1[0] + p[1] * t1[1] + p[2] * t1[2], p[0] * t2[0] + p[1] * t2[1] + p[2] * t2[2]];
      this.quad(c[i], c[j], c[k], c[l], n, mat, uv);
    }
  }

  /** An ellipsoid (radii along x, y, z). uv = (fraction round, fraction up). */
  ellipsoid(centre: Vec3, radii: Vec3, mat: number, rows = 10, cols = 18) {
    const point = (i: number, j: number): [Vec3, Vec3] => {
      const lat = (i / rows) * Math.PI - Math.PI / 2;
      const lon = (j / cols) * Math.PI * 2;
      const u: Vec3 = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
      return [add(centre, [u[0] * radii[0], u[1] * radii[1], u[2] * radii[2]]), normalize([u[0] / radii[0], u[1] / radii[1], u[2] / radii[2]])];
    };
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        const q = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]];
        for (const [a, b] of q) {
          const [p, n] = point(a, b);
          this.vertex(p, n, [b / cols, a / rows], mat);
        }
      }
    }
  }

  /**
   * A flat outline (x, y; anticlockwise, and every point in sight of its middle) drawn out
   * along z from z0 to z1. uv: x, y on the faces; distance round, z on the sides.
   */
  extrude(outline: [number, number][], z0: number, z1: number, mat: number, sideMat = mat) {
    let cx = 0, cy = 0;
    for (const [x, y] of outline) {
      cx += x / outline.length;
      cy += y / outline.length;
    }
    const n = outline.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = outline[i];
      const [bx, by] = outline[(i + 1) % n];
      this.vertex([cx, cy, z1], [0, 0, 1], [cx, cy], mat);
      this.vertex([ax, ay, z1], [0, 0, 1], [ax, ay], mat);
      this.vertex([bx, by, z1], [0, 0, 1], [bx, by], mat);
      this.vertex([cx, cy, z0], [0, 0, -1], [cx, cy], mat);
      this.vertex([bx, by, z0], [0, 0, -1], [bx, by], mat);
      this.vertex([ax, ay, z0], [0, 0, -1], [ax, ay], mat);
    }
    let run = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = outline[i];
      const [bx, by] = outline[(i + 1) % n];
      const len = Math.hypot(bx - ax, by - ay);
      const nrm = normalize([by - ay, -(bx - ax), 0]);
      this.quad([ax, ay, z1], [ax, ay, z0], [bx, by, z0], [bx, by, z1], nrm, sideMat, (p) => [run + Math.hypot(p[0] - ax, p[1] - ay), p[2]]);
      run += len;
    }
  }

  /** Quad p0-p1-p2-p3 with a flat normal; uv is derived from position. */
  quad(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: Vec3, mat: number, uv: (p: Vec3) => UV) {
    for (const p of [p0, p1, p2, p0, p2, p3]) this.vertex(p, n, uv(p), mat);
  }

  box(min: Vec3, max: Vec3, mat: number) {
    const [x0, y0, z0] = min;
    const [x1, y1, z1] = max;
    const xy = (p: Vec3): UV => [p[0], p[1]];
    const xz = (p: Vec3): UV => [p[0], p[2]];
    const zy = (p: Vec3): UV => [p[2], p[1]];
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], mat, xy);
    this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1], mat, xy);
    this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0], mat, xz);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], mat, xz);
    this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0], mat, zy);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0], mat, zy);
  }

  /** Box with the same uv on every vertex (for materials that take their state through uv). */
  boxUV(min: Vec3, max: Vec3, mat: number, uv: UV) {
    const start = this.v.length;
    this.box(min, max, mat);
    for (let i = start; i < this.v.length; i += VERTEX_FLOATS) {
      this.v[i + 6] = uv[0];
      this.v[i + 7] = uv[1];
    }
  }

  /**
   * Cylinder from a to b. uv = (distance along the axis, distance around it), unless `uv` gives
   * it from (fraction along, angle). The texture seam faces `seam`, which should point away from
   * the viewer.
   */
  cylinder(
    a: Vec3,
    b: Vec3,
    r: number,
    mat: number,
    opts: { segments?: number; rings?: number; seam?: Vec3; capMat?: number; open?: boolean; uv?: (s: number, th: number) => UV } = {},
  ) {
    const { segments = 24, rings = 1, seam = [0, 0, -1], capMat } = opts;
    const axis = sub(b, a);
    const len = Math.hypot(...axis);
    const d = scale(axis, 1 / len);
    let e1 = sub(seam, scale(d, seam[0] * d[0] + seam[1] * d[1] + seam[2] * d[2]));
    if (Math.hypot(...e1) < 1e-4) e1 = Math.abs(d[1]) < 0.9 ? cross(d, [0, 1, 0]) : cross(d, [1, 0, 0]);
    e1 = normalize(e1);
    const e2 = cross(d, e1);
    const uvAt = opts.uv ?? ((s: number, th: number): UV => [s * len, th * r]);

    const point = (s: number, th: number): Vec3 => {
      const dir = add(scale(e1, Math.cos(th)), scale(e2, Math.sin(th)));
      return add(add(a, scale(d, s * len)), scale(dir, r));
    };
    const normal = (th: number): Vec3 => add(scale(e1, Math.cos(th)), scale(e2, Math.sin(th)));

    for (let j = 0; j < rings; j++) {
      const s0 = j / rings;
      const s1 = (j + 1) / rings;
      for (let i = 0; i < segments; i++) {
        const t0 = (i / segments) * Math.PI * 2;
        const t1 = ((i + 1) / segments) * Math.PI * 2;
        const quad: [number, number][] = [[s0, t0], [s1, t0], [s1, t1], [s0, t0], [s1, t1], [s0, t1]];
        for (const [s, th] of quad) this.vertex(point(s, th), normal(th), uvAt(s, th), mat);
      }
    }

    if (capMat !== undefined) {
      // Sawn ends take (distance from the middle, angle round it), and the radius as a setting.
      const sawn = capMat === MAT.endGrain;
      const before = this.extra;
      if (sawn) this.extra = [r, before[1] || 0.55, before[2]];
      for (const [s, n] of [[0, scale(d, -1)], [1, d]] as [number, Vec3][]) {
        const centre = add(a, scale(d, s * len));
        for (let i = 0; i < segments; i++) {
          const t0 = (i / segments) * Math.PI * 2;
          const t1 = ((i + 1) / segments) * Math.PI * 2;
          const p0 = point(s, t0);
          const p1 = point(s, t1);
          const own = opts.uv ? uvAt(s, 0) : undefined;
          this.vertex(centre, n, own ?? (sawn ? [0, (t0 + t1) / 2] : [0, r]), capMat);
          this.vertex(p0, n, own ?? (sawn ? [r, t0] : [r, r]), capMat);
          this.vertex(p1, n, own ?? (sawn ? [r, t1] : [r, r]), capMat);
        }
      }
      this.extra = before;
    }
  }

  /**
   * Surface of revolution about the vertical through base. profile: (radius, height) from the
   * bottom up. uv = (fraction of the way around, height).
   */
  lathe(base: Vec3, profile: [number, number][], mat: number, segments = 32, squash: [number, number] = [1, 1]) {
    // Smooth normals: average the slopes of the profile on either side of each point.
    const normals = profile.map((_, j) => {
      const [ra, ya] = profile[Math.max(j - 1, 0)];
      const [rb, yb] = profile[Math.min(j + 1, profile.length - 1)];
      const n = normalize([yb - ya, -(rb - ra), 0]);
      return [n[0], n[1]] as [number, number];
    });
    // (squash makes it oval: x and z scaled.)
    const [sx, sz] = squash;
    const point = (j: number, a: number): Vec3 => [base[0] + profile[j][0] * Math.cos(a) * sx, base[1] + profile[j][1], base[2] + profile[j][0] * Math.sin(a) * sz];
    const normal = (j: number, a: number): Vec3 => normalize([(normals[j][0] * Math.cos(a)) / sx, normals[j][1], (normals[j][0] * Math.sin(a)) / sz]);
    for (let j = 0; j + 1 < profile.length; j++) {
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const corners: [number, number][] = [[j, a0], [j + 1, a0], [j + 1, a1], [j, a0], [j + 1, a1], [j, a1]];
        for (const [k, a] of corners) this.vertex(point(k, a), normal(k, a), [a / (Math.PI * 2), profile[k][1]], mat);
      }
    }
  }

  /**
   * A small flame standing at base: candle `slot` (0..2) or the match (3). Every vertex sits at
   * the base; uv (across -1..1, up 0..1) tells the shader how to spread it into a teardrop
   * facing the viewer, and the normal's x which flame it is (so it goes out with it).
   */
  flame(base: Vec3, slot = 0) {
    const rows = 8;
    for (let j = 0; j < rows; j++) {
      const v0 = j / rows;
      const v1 = (j + 1) / rows;
      for (const [u0, u1] of [[-1, 0], [0, 1]]) {
        const corners: UV[] = [[u0, v0], [u1, v0], [u1, v1], [u0, v0], [u1, v1], [u0, v1]];
        for (const uv of corners) this.vertex(base, [slot, 0, 1], uv, MAT.flame);
      }
    }
  }

  /**
   * A small glowing dot at pos (a firefly, an eye catching the light), drawn as a quad facing the
   * viewer: the vertices sit at pos, uv gives the corner, the normal carries brightness, radius
   * (m) and tint (0 firefly, 1 eyes) for the shader.
   */
  glowDot(pos: Vec3, radius: number, bright: number, tint: number) {
    const corners: UV[] = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
    for (const uv of corners) this.vertex(pos, [bright, radius, tint], uv, MAT.glow);
  }

  /**
   * A pair of wings flapping (a moth or a bat): body at pos, flying along heading; flap -1..1
   * raises and lowers them. uv.x says pale (1) or dark (0).
   */
  wings(pos: Vec3, heading: Vec3, span: number, flap: number, pale: boolean) {
    let right = cross(heading, [0, 1, 0]);
    right = Math.hypot(...right) < 1e-3 ? [1, 0, 0] : normalize(right);
    const up = cross(right, heading);
    const front = add(pos, scale(heading, span * 0.14));
    const back = add(pos, scale(heading, -span * 0.12));
    const angle = flap * 0.9;
    for (const side of [-1, 1]) {
      const out = add(scale(right, side * Math.cos(angle)), scale(up, Math.sin(angle)));
      const tip = add(pos, scale(out, span / 2));
      const trail = add(add(pos, scale(out, span * 0.3)), scale(heading, -span * 0.2));
      const n = normalize(cross(out, heading));
      const uv: UV = [pale ? 1 : 0, 0];
      for (const p of [front, tip, back, back, tip, trail]) this.vertex(p, n, uv, MAT.critter);
    }
  }

  /** Height field over a rectangle in xz, with normals from finite differences. */
  heightField(x0: number, x1: number, z0: number, z1: number, nx: number, nz: number, height: (x: number, z: number) => number, mat: number) {
    const e = 0.002;
    const vert = (x: number, z: number) => {
      const y = height(x, z);
      const n = normalize([height(x - e, z) - height(x + e, z), 2 * e, height(x, z - e) - height(x, z + e)]);
      this.vertex([x, y, z], n, [x, z], mat);
    };
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const xa = x0 + ((x1 - x0) * i) / nx;
        const xb = x0 + ((x1 - x0) * (i + 1)) / nx;
        const za = z0 + ((z1 - z0) * j) / nz;
        const zb = z0 + ((z1 - z0) * (j + 1)) / nz;
        vert(xa, za); vert(xb, za); vert(xb, zb);
        vert(xa, za); vert(xb, zb); vert(xa, zb);
      }
    }
  }

  build(): Float32Array {
    return new Float32Array(this.v);
  }
}

// Small deterministic value noise for the ember bed shape.
function hash2(x: number, z: number): number {
  const s = Math.sin(x * 127.1 + z * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
export function noise2(x: number, z: number): number {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash2(xi, zi), b = hash2(xi + 1, zi), c = hash2(xi, zi + 1), d = hash2(xi + 1, zi + 1);
  return a + (b - a) * ux + (c - a) * uz + (a - b - c + d) * ux * uz;
}

/** Height of rounded coal lumps scattered on a jittered grid. */
function coalLumps(x: number, z: number): number {
  const cell = 0.028;
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  let best = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = (gx + i + hash2(gx + i, gz + j)) * cell;
      const cz = (gz + j + hash2(gz + j + 17.3, gx + i + 31.1)) * cell;
      const r = cell * (0.5 + 0.4 * hash2(gx + i + 5.7, gz + j + 9.1));
      const d = Math.hypot(x - cx, z - cz) / r;
      if (d < 1) best = Math.max(best, r * 0.75 * Math.sqrt(1 - d * d));
    }
  }
  return best;
}

/**
 * Everything that doesn't move: the room, the fireplace, what the logs rest on, the coals. How
 * much else there is (furniture, ornaments, trees) depends on the detail asked for. And the
 * kettle, if one has been set down by the fire.
 */
export function buildScene(room: Room, detail: Detail, withKettle = false): { vertices: Float32Array; clearings: Clearings } {
  const m = new MeshBuilder();
  if (room.key === 'desert') {
    buildDesert(m, room, detail);
  } else if (room.key === 'campfire') {
    buildCampsite(m, room, detail);
  } else {
    const hacienda = room.key === 'hacienda';
    if (hacienda) buildAdobeFirebox(m);
    else buildFirebox(m, MAT.firebrick);
    if (hacienda) buildHacienda(m, room, detail);
    else buildBrickRoom(m, room, detail);
    if (room.support === 'andirons') buildAndirons(m);
    else buildGrate(m);
  }
  buildCoalBed(m, room.bed);
  if (withKettle && room.kettle) {
    if (room.kettle.trivet) trivet(m, room.kettle.at);
    kettle(m, room.kettle.at, room.kettle.yaw);
  }
  return { vertices: m.build(), clearings: m.clearings };
}

/** An iron trivet for a kettle to stand on by the fire: a ring on three short legs (its top at `top`). */
function trivet(m: MeshBuilder, top: Vec3) {
  const [x, y, z] = top;
  arcTube(m, [x, y - 0.004, z], [1, 0, 0], [0, 0, 1], 0.066, 0, Math.PI * 2, 0.004, MAT.iron, 24);
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.4;
    frustum(m, [x + Math.cos(a) * 0.066, y - 0.004, z + Math.sin(a) * 0.066], [x + Math.cos(a) * 0.08, 0, z + Math.sin(a) * 0.08], 0.0045, 0.004, 6, MAT.iron);
  }
}

/**
 * An adobe firebox (the hacienda's): the plain one's shape, but plastered by hand with no hard
 * edges in it: its back corners rounded into the sides, a cove where the walls meet the floor.
 */
function buildAdobeFirebox(m: MeshBuilder) {
  const { frontHalfWidth: fw, backHalfWidth: bw, depth: D, height: H } = FIREBOX;
  const R = 0.1; // radius of the back corners
  const COVE = 0.05; // and of the cove
  // The outline in plan, from the front of the left wall round the back to the front of the
  // right: straight, round the corner (tangent to the side and the back), straight, and so on.
  const corner: Vec3 = [-bw, 0, -D];
  const up1 = normalize([bw - fw, 0, D]); // (from the corner along the left wall, to the front)
  const theta = Math.acos(up1[0]); // (between that and the back wall, which runs along +x)
  const t = R / Math.tan(theta / 2);
  const centre = add(corner, scale(normalize(add(up1, [1, 0, 0])), R / Math.sin(theta / 2)));
  const t1 = add(corner, scale(up1, t));
  const a1 = Math.atan2(t1[2] - centre[2], t1[0] - centre[0]);
  const left: Vec3[] = [];
  const line = (a: Vec3, b: Vec3, n: number) => {
    for (let i = 0; i < n; i++) left.push(add(a, scale(sub(b, a), i / n)));
  };
  line([-fw, 0, 0], t1, 6);
  for (let i = 0; i < 8; i++) {
    const a = a1 + ((Math.PI - theta) * i) / 8;
    left.push([centre[0] + R * Math.cos(a), 0, centre[2] + R * Math.sin(a)]);
  }
  line([corner[0] + t, 0, -D], [0, 0, -D], 3);
  const outline = [...left, ...left.map(([x, , z]) => [-x, 0, z] as Vec3).reverse()];
  outline.splice(left.length, 0, [0, 0, -D]);
  // Along it: the way in (toward the middle of the firebox), and how far round (for uv).
  const n = outline.length;
  const inward = outline.map((_, i) => {
    const d = sub(outline[Math.min(i + 1, n - 1)], outline[Math.max(i - 1, 0)]);
    return normalize([-d[2], 0, d[0]]);
  });
  const around: number[] = [0];
  for (let i = 1; i < n; i++) around.push(around[i - 1] + length(sub(outline[i], outline[i - 1])));
  // Up the wall: round the cove (angle 0 on the floor to a quarter turn on the wall), then up.
  const rows: { up: number; inset: number; nUp: number; nIn: number }[] = [];
  for (let k = 0; k <= 4; k++) {
    const phi = (k / 4) * (Math.PI / 2);
    rows.push({ up: COVE - COVE * Math.cos(phi), inset: COVE - COVE * Math.sin(phi), nUp: Math.cos(phi), nIn: Math.sin(phi) });
  }
  for (const y of [0.15, 0.3, 0.45, 0.6, 0.72, H]) rows.push({ up: y, inset: 0, nUp: 0, nIn: 1 });
  const at = (i: number, r: number): [Vec3, Vec3, UV] => {
    const row = rows[r];
    const p = add(outline[i], scale(inward[i], row.inset));
    return [[p[0], row.up, Math.min(p[2], 0)], normalize(add(scale(inward[i], row.nIn), [0, row.nUp, 0])), [around[i], row.up]];
  };
  for (let r = 0; r + 1 < rows.length; r++) {
    for (let i = 0; i + 1 < n; i++) {
      for (const [a, b] of [[i, r], [i + 1, r], [i + 1, r + 1], [i, r], [i + 1, r + 1], [i, r + 1]]) {
        const [p, nrm, uv] = at(a, b);
        m.vertex(p, nrm, uv, MAT.adobe);
      }
    }
  }
  // The floor, inside the cove, and out to the front.
  const mid: Vec3 = [0, 0, -D / 2];
  const rim = outline.map((_, i) => at(i, 0)[0]);
  rim.push([rim[n - 1][0], 0, 0], [rim[0][0], 0, 0]);
  for (let i = 0; i < rim.length; i++) {
    for (const p of [mid, rim[(i + 1) % rim.length], rim[i]]) m.vertex(p, [0, 1, 0], [p[0], p[2]], MAT.adobe);
  }
  m.quad([-fw, H, 0], [-bw, H, -D], [bw, H, -D], [fw, H, 0], [0, -1, 0], MAT.soot, (p) => [p[0], p[2]]);
}

/** The firebox: floor, back wall, splayed side walls, sooty throat above. */
function buildFirebox(m: MeshBuilder, mat: number) {
  const { frontHalfWidth: fw, backHalfWidth: bw, depth: D, height: H } = FIREBOX;
  m.quad([-fw, 0, 0], [fw, 0, 0], [bw, 0, -D], [-bw, 0, -D], [0, 1, 0], mat, (p) => [p[0], p[2]]);
  m.quad([-bw, 0, -D], [bw, 0, -D], [bw, H, -D], [-bw, H, -D], [0, 0, 1], mat, (p) => [p[0], p[1]]);
  const sideLen = Math.hypot(fw - bw, D);
  const nl = normalize([D, 0, fw - bw]);
  m.quad([-fw, 0, 0], [-bw, 0, -D], [-bw, H, -D], [-fw, H, 0], nl, mat, (p) => [Math.hypot(p[0] + fw, p[2]) - sideLen, p[1]]);
  m.quad([bw, 0, -D], [fw, 0, 0], [fw, H, 0], [bw, H, -D], [-nl[0], 0, nl[2]], mat, (p) => [Math.hypot(p[0] - fw, p[2]), p[1]]);
  m.quad([-fw, H, 0], [-bw, H, -D], [bw, H, -D], [fw, H, 0], [0, -1, 0], MAT.soot, (p) => [p[0], p[2]]);
}

const IRON = { segments: 10, capMat: MAT.iron };

/** A basket grate: bars front to back, turned up at the ends, on two cross bars with legs. */
function buildGrate(m: MeshBuilder) {
  const g = GRATE_BARS;
  for (let i = 0; i < g.count; i++) {
    const x = g.first + i * g.spacing;
    m.cylinder([x, g.y, -0.33], [x, g.y, -0.09], g.radius, MAT.iron, IRON);
  }
  for (const [a, b] of grateFingers()) {
    const bend: Vec3 = [a[0], a[1] - 0.002, a[2] + Math.sign(a[2] - b[2]) * 0.006];
    m.cylinder(bend, a, 0.007, MAT.iron, { segments: 10 });
    m.cylinder(a, b, 0.007, MAT.iron, IRON);
  }
  for (const z of [-0.31, -0.11]) {
    m.cylinder([-0.24, 0.022, z], [0.24, 0.022, z], 0.008, MAT.iron, IRON);
    for (const x of [-0.22, 0.22]) m.cylinder([x, 0, z], [x, 0.03, z], 0.008, MAT.iron, { segments: 10 });
  }
}

/**
 * Spanish andirons (morillos): a bar for the logs running back to the wall on a foot, and a
 * tall upright in front on splayed feet, with collars and a brass ball on top.
 */
function buildAndirons(m: MeshBuilder) {
  const a = ANDIRONS;
  const sphere = (r: number, n = 10): [number, number][] =>
    Array.from({ length: n + 1 }, (_, i) => {
      const t = (i / n) * Math.PI;
      return [r * Math.sin(t), r - r * Math.cos(t)];
    });
  for (const x of a.x) {
    m.cylinder([x, a.barY, a.back], [x, a.barY, a.postZ], a.barRadius, MAT.iron, IRON);
    m.cylinder([x, 0, a.back + 0.012], [x, a.barY, a.back + 0.012], 0.007, MAT.iron, IRON);
    m.cylinder([x, 0.03, a.postZ], [x, a.postTop, a.postZ], a.postRadius, MAT.iron, IRON);
    for (const side of [-1, 1]) {
      m.cylinder([x + side * 0.06, 0.004, a.postZ + 0.02], [x, 0.045, a.postZ], 0.009, MAT.iron, IRON);
    }
    for (const y of [0.11, 0.2]) {
      m.lathe([x, y, a.postZ], [[0.013, 0], [0.019, 0.004], [0.019, 0.01], [0.013, 0.014]], MAT.iron, 14);
    }
    m.lathe([x, a.postTop - 0.004, a.postZ], sphere(0.024), MAT.brass, 18);
  }
}

/**
 * Coal bed: a heap of rounded lumps, thinning out toward its edges (or a round heap in a fire
 * pit). This is the shape of a full bed; the shader heaps it up only where there are coals.
 */
function buildCoalBed(m: MeshBuilder, bed: Rect & { round: boolean }) {
  const pad = bed.round ? 0 : 0.03;
  const cx = (bed.minX + bed.maxX) / 2;
  const cz = (bed.minZ + bed.maxZ) / 2;
  const rOut = Math.min(bed.maxX - bed.minX, bed.maxZ - bed.minZ) / 2;
  m.heightField(bed.minX - pad, bed.maxX + pad, bed.minZ - pad, bed.maxZ + pad, 150, bed.round ? 150 : 90, (x, z) => {
    let fall: number;
    if (bed.round) {
      fall = Math.min(1, Math.max(0, (rOut - Math.hypot(x - cx, z - cz)) / 0.08));
    } else {
      const ex = Math.min(x - (bed.minX - pad), bed.maxX + pad - x);
      const ez = Math.min(z - (bed.minZ - pad), bed.maxZ + pad - z);
      fall = Math.min(1, Math.max(0, Math.min(ex, ez) / 0.06));
    }
    const base = BED_HEIGHT * 0.35 * (0.6 + 0.8 * noise2(x * 30, z * 30));
    return 0.0015 + fall * (base + coalLumps(x, z) * (0.4 + 0.6 * fall));
  }, MAT.embers);
}

/**
 * Template mesh for a log, shaped at draw time from the log's surface map. Each vertex is
 * (along 0..1, around 0..1, part, radius fraction) where part is 0 for the side and 1 / 2 for
 * the cut ends at A / B.
 */
export function buildLogTemplate(): Float32Array {
  const along = 64;
  const around = 48;
  const rings = 6;
  const v: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[]) => v.push(...a, ...b, ...c, ...a, ...c, ...d);
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      const u0 = i / along, u1 = (i + 1) / along;
      const t0 = j / around, t1 = (j + 1) / around;
      quad([u0, t0, 0, 1], [u1, t0, 0, 1], [u1, t1, 0, 1], [u0, t1, 0, 1]);
    }
  }
  for (const part of [1, 2]) {
    for (let r = 0; r < rings; r++) {
      const f0 = r / rings, f1 = (r + 1) / rings;
      for (let j = 0; j < around; j++) {
        const t0 = j / around, t1 = (j + 1) / around;
        quad([0, t0, part, f0], [0, t0, part, f1], [0, t1, part, f1], [0, t1, part, f0]);
      }
    }
  }
  return new Float32Array(v);
}
