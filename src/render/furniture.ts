import { add, cross, normalize, scale, sub, type Vec3 } from '../math';
import { MAT, type MeshBuilder, type UV } from './geometry';
import { frustum, random, woodStack } from './props';

// Furniture and things about a room, each built in its own frame: standing on the floor at the
// origin, its front toward +z (place and turn it with MeshBuilder.at).

/** A flat disc facing `normal` (uv: -1..1 across it, x along `right`). */
export function disc(m: MeshBuilder, centre: Vec3, normal: Vec3, right: Vec3, radius: number, mat: number, segments = 32) {
  const up = cross(normal, right);
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const at = (a: number): [Vec3, UV] => [add(centre, add(scale(right, Math.cos(a) * radius), scale(up, Math.sin(a) * radius))), [Math.cos(a), Math.sin(a)]];
    const [p0, uv0] = at(a0);
    const [p1, uv1] = at(a1);
    m.vertex(centre, normal, [0, 0], mat);
    m.vertex(p0, normal, uv0, mat);
    m.vertex(p1, normal, uv1, mat);
  }
}

/** A tube bent round an arc (for handles and rings): centre, the arc's plane (u, v), radius, angles. */
export function arcTube(m: MeshBuilder, centre: Vec3, u: Vec3, v: Vec3, radius: number, from: number, to: number, thick: number, mat: number, steps = 10) {
  let prev: Vec3 | null = null;
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps;
    const p = add(centre, add(scale(u, Math.cos(a) * radius), scale(v, Math.sin(a) * radius)));
    if (prev) frustum(m, prev, p, thick, thick, 6, mat);
    prev = p;
  }
}

/**
 * A wingback armchair, upholstered in `colour`: a deep seat and cushion, rolled arms, a tall
 * back leaning back a little with wings either side, on short turned legs.
 */
export function armchair(m: MeshBuilder, colour: Vec3) {
  m.with([0.3, 0.17, 0.08], () => {
    for (const x of [-0.35, 0.35]) for (const z of [-0.35, 0.35]) m.cylinder([x, 0, z], [x, 0.1, z], 0.022, MAT.finish, { segments: 10, capMat: MAT.finish });
  });
  m.with(colour, () => {
    m.box([-0.42, 0.1, -0.38], [0.42, 0.4, 0.42], MAT.fabric);
    m.box([-0.29, 0.4, -0.26], [0.29, 0.53, 0.44], MAT.fabric);
    for (const side of [-1, 1]) {
      const [xa, xb] = side < 0 ? [-0.42, -0.29] : [0.29, 0.42];
      m.box([xa, 0.4, -0.38], [xb, 0.6, 0.42], MAT.fabric);
      m.cylinder([side * 0.36, 0.61, -0.36], [side * 0.36, 0.61, 0.44], 0.066, MAT.fabric, { segments: 16, capMat: MAT.fabric, seam: [0, -1, 0] });
      // A wing: from the top of the arm up the side of the back.
      const x0 = side * 0.33, x1 = side * 0.44;
      const corners: Vec3[] = [
        [x0, 0.64, -0.46], [x1, 0.64, -0.46], [x1 + side * 0.03, 0.64, -0.16], [x0 + side * 0.03, 0.64, -0.16],
        [x0, 1.08, -0.5], [x1, 1.08, -0.5], [x1 + side * 0.05, 1.02, -0.2], [x0 + side * 0.05, 1.02, -0.2],
      ];
      m.hexa(side < 0 ? [corners[1], corners[0], corners[3], corners[2], corners[5], corners[4], corners[7], corners[6]] : corners, MAT.fabric);
    }
    // The back, leaning back, and its cushion.
    m.hexa([[-0.42, 0.4, -0.44], [0.42, 0.4, -0.44], [0.42, 0.4, -0.28], [-0.42, 0.4, -0.28], [-0.42, 1.12, -0.56], [0.42, 1.12, -0.56], [0.42, 1.12, -0.4], [-0.42, 1.12, -0.4]], MAT.fabric);
    m.hexa([[-0.3, 0.53, -0.28], [0.3, 0.53, -0.28], [0.3, 0.53, -0.14], [-0.3, 0.53, -0.14], [-0.3, 1.02, -0.4], [0.3, 1.02, -0.4], [0.3, 1.02, -0.28], [-0.3, 1.02, -0.28]], MAT.fabric);
  });
}

/** A small round table on a turned pedestal, with a mug of tea and a book on it. */
export function sideTable(m: MeshBuilder) {
  const wood: Vec3 = [0.28, 0.14, 0.07];
  m.with(wood, () => {
    m.cylinder([0, 0.56, 0], [0, 0.59, 0], 0.23, MAT.finish, { segments: 40, capMat: MAT.finish });
    m.lathe([0, 0.06, 0], [[0.05, 0], [0.035, 0.05], [0.028, 0.2], [0.04, 0.26], [0.026, 0.33], [0.03, 0.48], [0.05, 0.5]], MAT.finish, 16);
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2;
      frustum(m, [0, 0.1, 0], [Math.cos(a) * 0.2, 0.01, Math.sin(a) * 0.2], 0.022, 0.014, 8, MAT.finish);
    }
  });
  // A mug of tea.
  m.at([0.08, 0.59, 0.06], 0.6, () => {
    m.with([0.52, 0.18, 0.12], () => {
      m.lathe([0, 0, 0], [[0, 0], [0.04, 0], [0.042, 0.008], [0.042, 0.095], [0.037, 0.095], [0.037, 0.012], [0, 0.012]], MAT.ceramic, 28);
      arcTube(m, [0.045, 0.05, 0], [0, 1, 0], [1, 0, 0], 0.026, -Math.PI / 2, Math.PI / 2, 0.006, MAT.ceramic, 8);
    });
    m.with([0.12, 0.06, 0.03], () => disc(m, [0, 0.078, 0], [0, 1, 0], [1, 0, 0], 0.037, MAT.ceramic, 20));
  });
  // A book, left face down.
  m.at([-0.09, 0.59, -0.05], -0.4, () => book(m, [0.2, 0.15, 0.03], 7, true));
}

/**
 * A book: covers and a spine round a block of pages (size: width across the covers, height,
 * thickness). Standing on its end with its spine toward +z (extra: its colour, and its height
 * for the bands on the spine), or lying on its back.
 */
export function book(m: MeshBuilder, size: Vec3, seed: number, lying = false) {
  const [w, h, t] = size;
  const c = 0.0025; // board thickness
  if (!lying) {
    m.with([seed, 0, h], () => {
      m.box([-t / 2, 0, -w], [-t / 2 + c, h, 0], MAT.book);
      m.box([t / 2 - c, 0, -w], [t / 2, h, 0], MAT.book);
      m.box([-t / 2, 0, -c], [t / 2, h, 0.002], MAT.book);
    });
    m.box([-t / 2 + c, 0.004, -w + 0.004], [t / 2 - c, h - 0.004, -c], MAT.pages);
    return;
  }
  // Lying flat: covers above and below, the spine down one side, pages round the other three.
  m.with([seed, 0, 0], () => {
    m.box([-w / 2, 0, -h / 2], [w / 2, c, h / 2], MAT.book);
    m.box([-w / 2, t - c, -h / 2], [w / 2, t, h / 2], MAT.book);
    m.box([-w / 2 - 0.002, 0, -h / 2], [-w / 2 + c, t, h / 2], MAT.book);
  });
  m.box([-w / 2 + c, c, -h / 2 + 0.004], [w / 2 - 0.004, t - c, h / 2 - 0.004], MAT.pages);
}

/**
 * Shelves full of books (and the odd pot) built into an alcove: a cupboard below, shelves above.
 * Its back against z = 0, its front at z = depth, width w centred on x = 0.
 */
export function bookshelf(m: MeshBuilder, w: number, h: number, depth: number, seed: number) {
  const rnd = random(seed);
  const wood: Vec3 = [0.3, 0.16, 0.08];
  const base = 0.82;
  m.with(wood, () => {
    m.box([-w / 2, 0, 0], [w / 2, 0.08, depth + 0.02], MAT.finish);
    m.box([-w / 2, 0.08, 0.02], [w / 2, base - 0.03, depth], MAT.finish);
    m.box([-w / 2 - 0.01, base - 0.03, 0], [w / 2 + 0.01, base, depth + 0.04], MAT.finish);
    // Cupboard doors: raised panels.
    for (const x of [-w / 4, w / 4]) m.box([x - w / 4 + 0.05, 0.14, depth], [x + w / 4 - 0.05, base - 0.09, depth + 0.012], MAT.finish);
    for (const side of [-1, 1]) m.box([side * w / 2 - 0.02, base, 0], [side * w / 2 + 0.02, h, depth - 0.04], MAT.finish);
    m.box([-w / 2, h - 0.04, 0], [w / 2, h, depth - 0.02], MAT.finish);
  });
  const shelves = [base, base + 0.34, base + 0.68, base + 1.02];
  shelves.forEach((y, i) => {
    if (i > 0) m.with(wood, () => m.box([-w / 2 + 0.02, y - 0.022, 0], [w / 2 - 0.02, y, depth - 0.04], MAT.finish));
    const top = (shelves[i + 1] ?? h - 0.04) - 0.03;
    let x = -w / 2 + 0.03 + rnd() * 0.05;
    while (x < w / 2 - 0.08) {
      const r = rnd();
      if (r < 0.06) {
        // A little pot.
        m.with([0.2 + 0.4 * rnd(), 0.25 + 0.2 * rnd(), 0.3 + 0.3 * rnd()], () =>
          m.lathe([x + 0.05, y, depth * 0.55], [[0, 0], [0.035, 0], [0.045, 0.04], [0.04, 0.09], [0.028, 0.11], [0.03, 0.125], [0, 0.125]], MAT.ceramic, 20),
        );
        x += 0.12;
      } else if (r < 0.14) {
        // A few lying one on another.
        let yy = y;
        const n = 2 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          const t = 0.025 + rnd() * 0.02;
          m.at([x + 0.1, yy, depth * 0.5], (rnd() - 0.5) * 0.2, () => book(m, [0.16 + rnd() * 0.04, 0.23 + rnd() * 0.04, t], rnd(), true));
          yy += t;
        }
        x += 0.25;
      } else {
        const t = 0.018 + rnd() * 0.028;
        const hh = Math.min(0.19 + rnd() * 0.09, top - y);
        m.at([x + t / 2, y, depth - 0.045 - rnd() * 0.02], 0, () => book(m, [0.15 + rnd() * 0.05, hh, t], rnd()));
        x += t + 0.001;
      }
    }
  });
}

/** Fireside tools on their stand: poker, shovel, brush and tongs hanging from a ring. */
export function companionSet(m: MeshBuilder) {
  const IRON = { segments: 10, capMat: MAT.iron };
  m.lathe([0, 0, 0], [[0, 0.02], [0.1, 0.02], [0.105, 0.012], [0.1, 0], [0, 0]], MAT.iron, 24);
  m.lathe([0, 0.02, 0], [[0.03, 0], [0.018, 0.03], [0.012, 0.05]], MAT.iron, 12);
  m.cylinder([0, 0.05, 0], [0, 0.74, 0], 0.009, MAT.iron, IRON);
  m.lathe([0, 0.74, 0], [[0.016, 0], [0.022, 0.012], [0.02, 0.03], [0.008, 0.042], [0, 0.044]], MAT.brass, 16);
  arcTube(m, [0, 0.66, 0], [1, 0, 0], [0, 0, 1], 0.055, 0, Math.PI * 2, 0.004, MAT.iron, 16);
  const tools = ['poker', 'shovel', 'brush', 'tongs'];
  tools.forEach((tool, i) => {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const x = Math.cos(a) * 0.055, z = Math.sin(a) * 0.055;
    const foot: Vec3 = [x * 1.9, 0.07, z * 1.9];
    const top: Vec3 = [x, 0.66, z];
    m.lathe([top[0], top[1] - 0.012, top[2]], [[0.008, 0], [0.016, 0.02], [0.012, 0.045], [0.004, 0.06]], MAT.brass, 12);
    if (tool === 'tongs') {
      for (const s of [-1, 1]) frustum(m, top, add(foot, [-z * s * 0.25, 0, x * s * 0.25]), 0.004, 0.004, 6, MAT.iron);
      return;
    }
    frustum(m, top, foot, 0.005, 0.005, 6, MAT.iron);
    const dir = normalize(sub(foot, top));
    if (tool === 'poker') {
      frustum(m, foot, add(foot, scale(dir, 0.05)), 0.005, 0.003, 6, MAT.iron);
      frustum(m, add(foot, scale(dir, 0.02)), add(add(foot, scale(dir, 0.03)), [x * 0.6, 0, z * 0.6]), 0.004, 0.003, 6, MAT.iron);
    } else if (tool === 'shovel') {
      const side = normalize([-z, 0, x]);
      const out = normalize([x, 0, z]);
      const c = add(foot, scale(dir, 0.05));
      const corner = (s: number, t: number): Vec3 => add(add(c, scale(side, s * 0.055)), scale(dir, t * 0.06));
      m.hexa([corner(-1, -1), corner(1, -1), add(corner(1, -1), scale(out, 0.004)), add(corner(-1, -1), scale(out, 0.004)), corner(-1, 1), corner(1, 1), add(corner(1, 1), scale(out, 0.004)), add(corner(-1, 1), scale(out, 0.004))], MAT.iron);
    } else {
      m.with([0.06, 0.05, 0.04], () => frustum(m, foot, add(foot, scale(dir, 0.1)), 0.03, 0.036, 12, MAT.fabric));
    }
  });
}

/** An oval wicker basket of split logs, its length along z. */
export function logBasket(m: MeshBuilder, woods: string[], seed: number) {
  const wall: [number, number][] = [[0, 0], [0.2, 0], [0.21, 0.02], [0.23, 0.18], [0.245, 0.3], [0.255, 0.315], [0.25, 0.33], [0.235, 0.32], [0.225, 0.3], [0.21, 0.18], [0.195, 0.03], [0, 0.03]];
  m.lathe([0, 0, 0], wall, MAT.wicker, 40, [0.62, 1]);
  for (const side of [-1, 1]) arcTube(m, [0, 0.33, side * 0.25], [0, 1, 0], [1, 0, 0], 0.07, 0, Math.PI, 0.008, MAT.wicker, 10);
  // (on more logs below, out of sight)
  woodStack(m, -0.12, 0.12, 0.12, -0.185, 0.185, 3, woods, seed);
}

/** A mantel clock: a mahogany case, humped like a hat, a white dial behind a brass bezel. */
export function mantelClock(m: MeshBuilder) {
  const outline: [number, number][] = [[-0.19, 0.012], [0.19, 0.012], [0.19, 0.06], [0.16, 0.07], [0.12, 0.1], [0.08, 0.14], [0.04, 0.16], [0, 0.165], [-0.04, 0.16], [-0.08, 0.14], [-0.12, 0.1], [-0.16, 0.07], [-0.19, 0.06]];
  m.with([0.3, 0.1, 0.05], () => {
    m.extrude(outline, -0.05, 0.05, MAT.finish);
    m.box([-0.205, 0, -0.06], [0.205, 0.014, 0.06], MAT.finish);
  });
  for (const x of [-0.17, 0.17]) m.lathe([x, -0.012, 0], [[0.012, 0], [0.016, 0.006], [0.012, 0.012]], MAT.brass, 10);
  m.cylinder([0, 0.095, 0.05], [0, 0.095, 0.058], 0.058, MAT.brass, { segments: 32 });
  disc(m, [0, 0.095, 0.0585], [0, 0, 1], [1, 0, 0], 0.05, MAT.clockFace, 40);
}

/** A brass candlestick with a tall taper in it (not lit). */
export function candlestick(m: MeshBuilder, height: number) {
  const k = height / 0.25;
  m.lathe([0, 0, 0], [[0, 0], [0.05, 0], [0.052, 0.006], [0.04, 0.014], [0.014, 0.03], [0.012, 0.09 * k], [0.02, 0.1 * k], [0.011, 0.12 * k], [0.01, 0.2 * k], [0.02, 0.23 * k], [0.024, 0.25 * k], [0.014, 0.25 * k]], MAT.brass, 24);
  m.cylinder([0, 0.24 * k, 0], [0, 0.24 * k + 0.2, 0], 0.011, MAT.wax, { segments: 14, capMat: MAT.wax });
  m.cylinder([0, 0.24 * k + 0.2, 0], [0, 0.24 * k + 0.208, 0], 0.0012, MAT.soot, { segments: 5 });
}

/** A painting in a gilt frame, hung flat on the wall (its face toward +z). */
export function picture(m: MeshBuilder, w: number, h: number, seed: number) {
  const b = 0.065; // width of the moulding
  const depth = 0.045;
  // Four mitred lengths of moulding, rising to a rounded crest and back.
  const corner = (x: number, y: number, inset: number, z: number): Vec3 => [x - Math.sign(x) * inset, y - Math.sign(y) * inset, z];
  const outer = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = outer[i];
    const [bx, by] = outer[(i + 1) % 4];
    const back = [corner(ax, ay, 0, 0), corner(bx, by, 0, 0), corner(bx, by, b, 0), corner(ax, ay, b, 0)];
    const front = [corner(ax, ay, 0.01, depth * 0.6), corner(bx, by, 0.01, depth * 0.6), corner(bx, by, b - 0.012, depth), corner(ax, ay, b - 0.012, depth)];
    m.hexa([back[0], back[1], front[1], front[0], back[3], back[2], front[2], front[3]], MAT.gilt);
    // A raised bead round the picture.
    const bead = (z: number) => [corner(ax, ay, b - 0.018, z), corner(bx, by, b - 0.018, z), corner(bx, by, b - 0.002, z), corner(ax, ay, b - 0.002, z)];
    const [bb, bf] = [bead(depth - 0.012), bead(depth + 0.007)];
    m.hexa([bb[0], bb[1], bf[1], bf[0], bb[3], bb[2], bf[2], bf[3]], MAT.gilt);
  }
  m.with([seed, 0, 0], () =>
    m.quad([-w / 2 + b - 0.006, -h / 2 + b - 0.006, 0.02], [w / 2 - b + 0.006, -h / 2 + b - 0.006, 0.02], [w / 2 - b + 0.006, h / 2 - b + 0.006, 0.02], [-w / 2 + b - 0.006, h / 2 - b + 0.006, 0.02], [0, 0, 1], MAT.painting, (p) => [(p[0] + w / 2 - b) / (w - 2 * b), (p[1] + h / 2 - b) / (h - 2 * b)]),
  );
}

/**
 * A rug on the floor (y), pattern 0 serape, 1 kilim, 2 Persian, 3 Bedouin. A fringe at each
 * end: uv.y runs below 0 and above 1 there.
 */
export function rug(m: MeshBuilder, x0: number, x1: number, z0: number, z1: number, y: number, pattern: number, fringe = 0.05) {
  const len = z1 - z0;
  m.with([pattern, x1 - x0, len], () =>
    m.quad([x0, y, z0 - fringe], [x1, y, z0 - fringe], [x1, y, z1 + fringe], [x0, y, z1 + fringe], [0, 1, 0], MAT.rug, (p) => [(p[0] - x0) / (x1 - x0), (p[2] - z0) / len]),
  );
}

/**
 * A cushion covered in a weaving (`pattern`, as for rug()): two faces sewn together round the
 * edge and stuffed full, so it bulges in the middle and pinches in to the seam, most at the
 * corners, its sides drawing in a little between them; piping (in `piping`'s colour) along the
 * seam, and a tassel at each corner if `tassels`. Lying flat it is `w` across (x) by `d` deep (z),
 * `t` thick at its fullest, its middle at the origin; `lean` stands it up (radians about x, its
 * top face turning toward +z), as a cushion propped against a wall. `plump` 0..1: from a mattress
 * (fat right to its edges) to a pillow (round).
 */
export function cushion(m: MeshBuilder, w: number, d: number, t: number, lean: number, pattern: number, piping: Vec3, opts: { plump?: number; tassels?: boolean; n?: number } = {}) {
  const { plump = 1, tassels = false, n = 10 } = opts;
  const c = Math.cos(lean), s = Math.sin(lean);
  const turn = (p: Vec3): Vec3 => [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  const edge = 2.5 + 5 * (1 - plump); // (how square its outline stays)
  const point = (u: number, v: number, side: number): Vec3 => {
    const x = u * (w / 2) * (1 - 0.08 * plump * (1 - v * v));
    const z = v * (d / 2) * (1 - 0.08 * plump * (1 - u * u));
    const fill = Math.pow(Math.max(0, 1 - Math.abs(u) ** edge), 0.5) * Math.pow(Math.max(0, 1 - Math.abs(v) ** edge), 0.5);
    return turn([x, side * (t / 2) * fill, z]);
  };
  const e = 1e-3;
  m.with([pattern, w, d], () => {
    for (const side of [1, -1]) {
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) {
            const u = -1 + (2 * a) / n;
            const v = -1 + (2 * b) / n;
            const du = sub(point(Math.min(u + e, 1), v, side), point(Math.max(u - e, -1), v, side));
            const dv = sub(point(u, Math.min(v + e, 1), side), point(u, Math.max(v - e, -1), side));
            m.vertex(point(u, v, side), scale(normalize(cross(dv, du)), side), [(u + 1) / 2, (v + 1) / 2], MAT.rug);
          }
        }
      }
    }
  });
  // Piping round the seam, and tassels at the corners.
  m.with(piping, () => {
    const ring: Vec3[] = [];
    const k = Math.max(4, n / 2);
    for (let i = 0; i < k; i++) ring.push(point(-1 + (2 * i) / k, -1, 1));
    for (let i = 0; i < k; i++) ring.push(point(1, -1 + (2 * i) / k, 1));
    for (let i = 0; i < k; i++) ring.push(point(1 - (2 * i) / k, 1, 1));
    for (let i = 0; i < k; i++) ring.push(point(-1, 1 - (2 * i) / k, 1));
    ring.forEach((p, i) => frustum(m, p, ring[(i + 1) % ring.length], 0.006, 0.006, 5, MAT.fabric));
    if (!tassels) return;
    // (On a cushion lying down they lie out on the floor; on one propped up, they hang.)
    for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const corner = point(u, v, 1);
      const out: Vec3 = [u * 0.04 * c, -0.012 - 0.04 * s, v * 0.04 * c];
      frustum(m, corner, add(corner, out), 0.008, 0.004, 6, MAT.fabric);
    }
  });
}

/**
 * A bolster: a long round cushion, its ends gathered in; `len` long along x and `r` round, its
 * middle at the origin. Woven bands (`pattern`, as for rug()) run round it.
 */
export function bolster(m: MeshBuilder, len: number, r: number, pattern: number, rings = 16, around = 18) {
  const point = (s: number, a: number): Vec3 => {
    const k = Math.pow(Math.max(0, 1 - Math.abs(s) ** 7), 0.2);
    return [(s * len) / 2, Math.cos(a) * r * k, Math.sin(a) * r * k];
  };
  const e = 1e-3;
  m.with([pattern, len, 2 * Math.PI * r], () => {
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < around; j++) {
        for (const [a, b] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) {
          const s = -1 + (2 * a) / rings;
          const th = (b / around) * Math.PI * 2;
          const p = point(s, th);
          let nrm: Vec3 = [Math.sign(s), 0, 0]; // (at the gathered ends)
          if (Math.abs(s) < 1) {
            const ds = sub(point(Math.min(s + e, 1), th), point(Math.max(s - e, -1), th));
            nrm = normalize(cross(ds, sub(point(s, th + e), point(s, th - e))));
            if (nrm[1] * p[1] + nrm[2] * p[2] < 0) nrm = scale(nrm, -1);
          }
          m.vertex(p, nrm, [(s + 1) / 2, b / around], MAT.rug);
        }
      }
    }
  });
}

/** A fiddle-leaf fig in a glazed pot: big, glossy, violin-shaped leaves up a slender stem. */
export function figPlant(m: MeshBuilder, seed: number) {
  const rnd = random(seed);
  m.with([0.85, 0.83, 0.78], () => m.lathe([0, 0, 0], [[0, 0], [0.12, 0], [0.15, 0.02], [0.17, 0.2], [0.18, 0.3], [0.165, 0.3], [0.155, 0.27], [0, 0.27]], MAT.ceramic, 32));
  m.with([0.08, 0.05, 0.03], () => disc(m, [0, 0.27, 0], [0, 1, 0], [1, 0, 0], 0.156, MAT.ceramic, 24));
  const stem: Vec3[] = [];
  for (let i = 0; i <= 6; i++) stem.push([0.02 * Math.sin(i * 0.9), 0.27 + i * 0.19, 0.015 * Math.cos(i * 1.3)]);
  m.with([0.3, 0.22, 0.14], () => {
    for (let i = 1; i < stem.length; i++) frustum(m, stem[i - 1], stem[i], 0.02 - i * 0.0015, 0.02 - (i + 1) * 0.0015, 8, MAT.finish);
  });
  const n = 26;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const y = 0.62 + t * 0.72;
    const k = Math.min(Math.floor((y - 0.27) / 0.19), 5);
    const f = (y - 0.27) / 0.19 - k;
    const base: Vec3 = add(stem[k], scale(sub(stem[k + 1], stem[k]), f));
    const a = i * 2.4 + rnd() * 0.3;
    const out: Vec3 = [Math.cos(a), 0, Math.sin(a)];
    const rise = 0.5 + 0.5 * rnd() + 0.3 * t;
    leaf(m, base, normalize(add(out, [0, rise, 0])), 0.2 + 0.1 * rnd() * (1 - t * 0.5), 0.12 + 0.04 * rnd(), [0.07 + 0.03 * rnd(), 0.2 + 0.06 * rnd(), 0.06]);
  }
}

/**
 * A broad leaf from `base` along `dir`, curving down toward its tip, folded a little along its
 * midrib (uv: across -1..1, along 0..1).
 */
export function leaf(m: MeshBuilder, base: Vec3, dir: Vec3, len: number, width: number, colour: Vec3) {
  let side = cross(dir, [0, 1, 0]);
  side = Math.hypot(...side) < 1e-3 ? [1, 0, 0] : normalize(side);
  const up = normalize(cross(side, dir));
  const steps = 8;
  const rows: Vec3[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Violin-shaped: broad near the tip, a waist, narrow at the stalk.
    const w = width * Math.pow(Math.sin(Math.PI * Math.min(t * 1.05, 1)), 0.7) * (1 - 0.22 * Math.exp(-(((t - 0.45) / 0.12) ** 2))) * (0.4 + 0.6 * t) * 1.2;
    const droop = -0.35 * len * t * t;
    const c = add(add(base, scale(dir, len * t)), scale(up, droop));
    const fold = scale(up, -0.12 * w);
    rows.push([add(add(c, scale(side, -w)), fold), c, add(add(c, scale(side, w)), fold)]);
  }
  m.with(colour, () => {
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < 2; j++) {
        const q = [rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]];
        const n = normalize(cross(sub(q[1], q[0]), sub(q[3], q[0])));
        const uv: UV[] = [[j - 1, i / steps], [j - 1, (i + 1) / steps], [j, (i + 1) / steps], [j, i / steps]];
        for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(q[k], n, uv[k], MAT.leaf);
      }
    }
  });
}

/**
 * A long pointed leaf, thick and folded, arching out from `base` along `dir` (an agave's, a
 * yucca's), uv as for leaf().
 */
export function blade(m: MeshBuilder, base: Vec3, dir: Vec3, len: number, width: number, colour: Vec3) {
  let side = cross(dir, [0, 1, 0]);
  side = Math.hypot(...side) < 1e-3 ? [1, 0, 0] : normalize(side);
  const up = normalize(cross(side, dir));
  const steps = 8;
  const rows: Vec3[][] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = width * Math.pow(1 - t, 0.75) * (0.75 + 0.25 * Math.sin(Math.PI * Math.min(t * 2, 1)));
    const c = add(add(base, scale(dir, len * t)), scale(up, -0.45 * len * t * t));
    const fold = scale(up, -0.5 * w);
    rows.push([add(add(c, scale(side, -w)), fold), add(c, scale(up, 0.15 * w)), add(add(c, scale(side, w)), fold)]);
  }
  m.with(colour, () => {
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < 2; j++) {
        const q = [rows[i][j], rows[i + 1][j], rows[i + 1][j + 1], rows[i][j + 1]];
        const n = normalize(cross(sub(q[1], q[0]), sub(q[3], q[0])));
        const uv: UV[] = [[j - 1, i / steps], [j - 1, (i + 1) / steps], [j, (i + 1) / steps], [j, i / steps]];
        for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(q[k], n, uv[k], MAT.leaf);
      }
    }
  });
}

/** An agave in a terracotta pot: a rosette of thick, blue-grey, pointed leaves. */
export function agave(m: MeshBuilder, seed: number) {
  const rnd = random(seed);
  m.lathe([0, 0, 0], [[0, 0], [0.13, 0], [0.16, 0.03], [0.2, 0.24], [0.215, 0.27], [0.2, 0.28], [0.19, 0.26], [0, 0.26]], MAT.pottery, 32);
  m.with([0.07, 0.05, 0.03], () => disc(m, [0, 0.255, 0], [0, 1, 0], [1, 0, 0], 0.19, MAT.ceramic, 24));
  const n = 20;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const a = i * 2.4 + rnd() * 0.2;
    const rise = 1.6 - 1.2 * t;
    const dir = normalize([Math.cos(a), rise, Math.sin(a)]);
    blade(m, [Math.cos(a) * 0.03, 0.26, Math.sin(a) * 0.03], dir, 0.28 + 0.25 * t + 0.05 * rnd(), 0.04 + 0.015 * t, [0.2, 0.3, 0.26]);
  }
}

/** A small painted clay santo: a figure in a blue robe. */
export function santo(m: MeshBuilder) {
  m.with([0.12, 0.2, 0.45], () => m.lathe([0, 0, 0], [[0, 0], [0.034, 0], [0.034, 0.012], [0.03, 0.02], [0.024, 0.07], [0.02, 0.1], [0.024, 0.115], [0.018, 0.125], [0, 0.128]], MAT.ceramic, 18));
  m.with([0.62, 0.45, 0.32], () => m.ellipsoid([0, 0.142, 0], [0.013, 0.016, 0.013], MAT.ceramic, 8, 12));
  m.with([0.55, 0.42, 0.12], () => m.lathe([0, 0.15, -0.004], [[0.022, 0], [0.024, 0.004], [0, 0.006]], MAT.ceramic, 16));
}

/** A Talavera plate hung on the wall, facing +z. */
export function plate(m: MeshBuilder, radius: number) {
  disc(m, [0, 0, 0.012], [0, 0, 1], [1, 0, 0], radius, MAT.plate, 40);
  m.with([0.05, 0.11, 0.45], () => arcTube(m, [0, 0, 0.01], [1, 0, 0], [0, 1, 0], radius, 0, Math.PI * 2, 0.008, MAT.ceramic, 32));
}

/** A ristra: dried red chiles strung round and round a string, hanging from `top` for `len`. */
export function ristra(m: MeshBuilder, top: Vec3, len: number, seed: number) {
  const rnd = random(seed);
  m.with([0.5, 0.42, 0.3], () => frustum(m, top, add(top, [0, -len - 0.04, 0]), 0.003, 0.003, 5, MAT.fabric));
  const count = Math.round(len * 120);
  for (let i = 0; i < count; i++) {
    const t = i / count;
    const a = i * 2.4 + rnd() * 0.4;
    const out: Vec3 = [Math.cos(a), 0, Math.sin(a)];
    // Tied on by their stalks, they hang down and a little out, plump near the stalk.
    const at = add(add(top, [0, -0.04 - t * len, 0]), scale(out, 0.018 * (1 - 0.4 * t)));
    const hang = normalize(add(scale(out, 0.35 + 0.25 * rnd()), [0, -1, 0]));
    const long = 0.09 + 0.05 * rnd();
    const mid = add(at, scale(hang, long * 0.35));
    frustum(m, at, mid, 0.011, 0.016 + 0.004 * rnd(), 6, MAT.chile);
    frustum(m, mid, add(at, scale(add(hang, scale(out, 0.15)), long)), 0.016 + 0.004 * rnd(), 0.002, 6, MAT.chile);
  }
}

/**
 * An equipal: a Mexican chair of pigskin on a drum of cedar lattice, its back curving round to
 * make the arms.
 */
export function equipal(m: MeshBuilder) {
  const skin: Vec3 = [0.66, 0.44, 0.28];
  m.lathe([0, 0, 0], [[0, 0], [0.27, 0], [0.25, 0.1], [0.24, 0.2], [0.26, 0.32], [0.28, 0.36], [0, 0.36]], MAT.wicker, 36);
  m.with(skin, () => {
    m.cylinder([0, 0.36, 0], [0, 0.42, 0], 0.29, MAT.fabric, { segments: 36, capMat: MAT.fabric });
    // The back: a band round the back and sides, highest behind, lower at the arms.
    const steps = 24;
    const [a0, a1] = [-Math.PI / 2 - 1.95, -Math.PI / 2 + 1.95];
    const height = (a: number) => 0.62 + 0.38 * Math.cos((a + Math.PI / 2) * 0.8);
    for (let i = 0; i < steps; i++) {
      const aa = a0 + ((a1 - a0) * i) / steps;
      const ab = a0 + ((a1 - a0) * (i + 1)) / steps;
      for (const [r, sign] of [[0.3, -1], [0.33, 1]] as [number, number][]) {
        const p = (a: number, y: number): Vec3 => [Math.cos(a) * r, y, Math.sin(a) * r];
        const n = (a: number): Vec3 => [Math.cos(a) * sign, 0, Math.sin(a) * sign];
        const q = [p(aa, 0.42), p(ab, 0.42), p(ab, height(ab)), p(aa, height(aa))];
        const nn = [n(aa), n(ab), n(ab), n(aa)];
        for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(q[k], nn[k], [i / steps, q[k][1]], MAT.fabric);
      }
      const top = (a: number, r: number): Vec3 => [Math.cos(a) * r, height(a), Math.sin(a) * r];
      m.quad(top(aa, 0.3), top(ab, 0.3), top(ab, 0.33), top(aa, 0.33), [0, 1, 0], MAT.fabric, (q) => [q[0], q[2]]);
    }
  });
}

/** A round basket of piñon kindling. */
export function kindlingBasket(m: MeshBuilder, seed: number) {
  const rnd = random(seed);
  m.lathe([0, 0, 0], [[0, 0], [0.16, 0], [0.18, 0.03], [0.2, 0.22], [0.21, 0.24], [0.19, 0.245], [0.185, 0.23], [0, 0.23]], MAT.wicker, 32);
  m.with([0.33, 0.26, 0.2], () => {
    for (let i = 0; i < 14; i++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * 0.12;
      const foot: Vec3 = [Math.cos(a) * r, 0.03, Math.sin(a) * r];
      const lean = normalize([Math.cos(a) * (0.15 + 0.3 * rnd()), 1, Math.sin(a) * (0.15 + 0.3 * rnd())]);
      const len = 0.32 + 0.14 * rnd();
      const top = add(foot, scale(lean, len));
      m.cylinder(foot, top, 0.008 + 0.006 * rnd(), MAT.bark, { segments: 6, capMat: MAT.endGrain });
    }
  });
}
