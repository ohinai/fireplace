import { add, cross, length, normalize, scale, sub, type Vec3 } from '../math';
import type { Detail } from '../config';
import type { Room } from '../rooms';
import { MAT, type MeshBuilder, type UV } from './geometry';
import { agave, equipal, kindlingBasket, plate, ristra, rug, santo } from './furniture';
import { woodStack } from './props';

// A room in a Spanish hacienda: whitewashed walls with an ochre band along the bottom, a
// wooden floor, and a plastered chimney breast whose arched opening is framed in Talavera
// tiles, with a hand-hewn beam for a mantel and a hood narrowing up to the ceiling. The fire
// sits up on a raised, tiled hearth (a banco you could sit on), with spare firewood, clay pots
// and candles on it, and a kilim on the floor. A candle burns in a niche in the wall. (With more
// detail: a santo in the niche, Talavera plates on the wall, ristras of chiles hanging from the
// beams, a basket of kindling, an equipal drawn up to the fire, agaves in pots.)

const FLOOR = -0.21; // the room's floor: the hearth, two tiles high, brings the fire up to 0
const TILE = 0.105; // Talavera tile (must match scene.wgsl)
const BREAST = 0.8; // half width of the chimney breast
const WALL = -0.3; // the room's back wall
const FACE_TOP = 0.9; // the breast's face runs up to the mantel beam
const BEAM_TOP = 1.02;
const DADO = 0.42; // top of the ochre band along the bottom of the walls
const CEILING = 2.6;
const HOOD = 0.46; // half width of the hood at the ceiling
const HEARTH = { halfWidth: 1.05, depth: 0.5 };
const ARCH_SEGMENTS = 40;
const SIDE = 3.2; // the side walls
/** An arched niche in the wall left of the fireplace, with a candle burning in it. */
export const NICHE = { x: -2.0, halfWidth: 0.2, sill: 0.95, spring: 1.35, depth: 0.18 };
/** The chair drawn up to the fire, where one sits in the room's chair view. */
const CHAIR = { at: [1.575, FLOOR, 2.156] as Vec3, yaw: -2.534 };

const xy = (p: Vec3): UV => [p[0], p[1]];
const zy = (p: Vec3): UV => [p[2], p[1]];

export function buildHacienda(m: MeshBuilder, room: Room, detail: Detail) {
  buildShell(m);
  buildNiche(m);
  buildBreast(m, room);
  buildHearth(m);
  buildMantel(m);
  // (Furniture, pots and firewood each fade to a ghost if they come between the eye and the fire.)
  m.seeThrough(() => buildFirewood(m));
  m.seeThrough(() => buildPottery(m));
  buildCandles(m, room);
  buildFaroles(m, room);
  buildRug(m);
  if (detail === 'low') return;
  m.at([NICHE.x - 0.09, NICHE.sill, WALL - NICHE.depth * 0.55], 0, () => santo(m));
  for (const [x, y, r] of [[1.35, 1.55, 0.15], [1.8, 1.42, 0.11], [2.25, 1.55, 0.15]]) m.at([x, y, WALL], 0, () => plate(m, r));
  ristra(m, [2.7, CEILING - 0.17, 0.85], 0.85, 3);
  ristra(m, [2.95, CEILING - 0.17, 0.85], 0.7, 8);
  m.seeThrough(() => m.at([-1.28, FLOOR, 0.32], 0, () => kindlingBasket(m, 4)));
  m.seeThrough(() => m.at(CHAIR.at, CHAIR.yaw, () => equipal(m)));
  if (detail !== 'high') return;
  m.seeThrough(() => m.at([-2.6, FLOOR, 0.4], 0, () => agave(m, 12)));
  m.seeThrough(() => m.at([2.75, FLOOR, 0.35], 0, () => agave(m, 31)));
}

/** A wooden floor (the tiles are round the fire), walls and a beamed ceiling. */
function buildShell(m: MeshBuilder) {
  m.quad([-SIDE, FLOOR, WALL], [SIDE, FLOOR, WALL], [SIDE, FLOOR, 6], [-SIDE, FLOOR, 6], [0, 1, 0], MAT.floor, (p) => [p[0], p[2]]);
  const n = NICHE;
  for (const [x0, x1] of [[-SIDE, -BREAST], [BREAST, SIDE]]) {
    m.quad([x0, FLOOR, WALL], [x1, FLOOR, WALL], [x1, DADO, WALL], [x0, DADO, WALL], [0, 0, 1], MAT.dado, xy);
    if (x0 > n.x || x1 < n.x) {
      m.quad([x0, DADO, WALL], [x1, DADO, WALL], [x1, CEILING, WALL], [x0, CEILING, WALL], [0, 0, 1], MAT.plaster, xy);
      continue;
    }
    // Round the niche: either side of it, below it, above it, and the corners over its arch.
    const [l, r, top] = [n.x - n.halfWidth, n.x + n.halfWidth, n.spring + n.halfWidth];
    m.quad([x0, DADO, WALL], [l, DADO, WALL], [l, CEILING, WALL], [x0, CEILING, WALL], [0, 0, 1], MAT.plaster, xy);
    m.quad([r, DADO, WALL], [x1, DADO, WALL], [x1, CEILING, WALL], [r, CEILING, WALL], [0, 0, 1], MAT.plaster, xy);
    m.quad([l, DADO, WALL], [r, DADO, WALL], [r, n.sill, WALL], [l, n.sill, WALL], [0, 0, 1], MAT.plaster, xy);
    m.quad([l, top, WALL], [r, top, WALL], [r, CEILING, WALL], [l, CEILING, WALL], [0, 0, 1], MAT.plaster, xy);
    const arc = (i: number): Vec3 => {
      const a = Math.PI * (1 - i / 16);
      return [n.x + n.halfWidth * Math.cos(a), n.spring + n.halfWidth * Math.sin(a), WALL];
    };
    for (let i = 0; i < 16; i++) {
      const corner: Vec3 = i < 8 ? [l, top, WALL] : [r, top, WALL];
      for (const p of [corner, arc(i + 1), arc(i)]) m.vertex(p, [0, 0, 1], [p[0], p[1]], MAT.plaster);
    }
  }
  for (const side of [-1, 1]) {
    const x = side * SIDE;
    m.quad([x, FLOOR, 6], [x, FLOOR, WALL], [x, DADO, WALL], [x, DADO, 6], [-side, 0, 0], MAT.dado, zy);
    m.quad([x, DADO, 6], [x, DADO, WALL], [x, CEILING, WALL], [x, CEILING, 6], [-side, 0, 0], MAT.plaster, zy);
  }
  m.quad([-SIDE, CEILING, WALL], [SIDE, CEILING, WALL], [SIDE, CEILING, 6], [-SIDE, CEILING, 6], [0, -1, 0], MAT.plaster, (p) => [p[0], p[2]]);
  // Vigas: dark beams across the ceiling.
  for (const z of [0.15, 0.85, 1.55, 2.25, 2.95]) m.box([-SIDE, CEILING - 0.17, z - 0.08], [SIDE, CEILING, z + 0.08], MAT.beam);
}

/** The inside of the niche: its sill, sides, back and the vault of its arch. */
function buildNiche(m: MeshBuilder) {
  const n = NICHE;
  const [l, r, back] = [n.x - n.halfWidth, n.x + n.halfWidth, WALL - n.depth];
  m.quad([l, n.sill, WALL], [r, n.sill, WALL], [r, n.sill, back], [l, n.sill, back], [0, 1, 0], MAT.plaster, (p) => [p[0], p[2]]);
  m.quad([l, n.sill, back], [r, n.sill, back], [r, n.spring, back], [l, n.spring, back], [0, 0, 1], MAT.plaster, xy);
  m.quad([l, n.sill, WALL], [l, n.sill, back], [l, n.spring, back], [l, n.spring, WALL], [1, 0, 0], MAT.plaster, zy);
  m.quad([r, n.sill, back], [r, n.sill, WALL], [r, n.spring, WALL], [r, n.spring, back], [-1, 0, 0], MAT.plaster, zy);
  for (let i = 0; i < 16; i++) {
    const a0 = Math.PI * (1 - i / 16);
    const a1 = Math.PI * (1 - (i + 1) / 16);
    const at = (a: number, z: number): Vec3 => [n.x + n.halfWidth * Math.cos(a), n.spring + n.halfWidth * Math.sin(a), z];
    const inward = (a: number): Vec3 => [-Math.cos(a), -Math.sin(a), 0];
    const q = [at(a0, WALL), at(a1, WALL), at(a1, back), at(a0, back)];
    const nn = [inward(a0), inward(a1), inward(a1), inward(a0)];
    for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(q[k], nn[k], [q[k][0], q[k][2]], MAT.plaster);
    for (const p of [[n.x, n.spring, back] as Vec3, at(a0, back), at(a1, back)]) m.vertex(p, [0, 0, 1], [p[0], p[1]], MAT.plaster);
  }
}

/** The chimney breast: its sides, the arched opening in Talavera tiles, and the hood. */
function buildBreast(m: MeshBuilder, room: Room) {
  const o = room.opening;
  const hw = o.halfWidth;
  const rise = o.apex - o.spring;

  for (const side of [-1, 1]) {
    const x = side * BREAST;
    const n: Vec3 = [side, 0, 0];
    m.quad([x, FLOOR, 0], [x, FLOOR, WALL], [x, DADO, WALL], [x, DADO, 0], n, MAT.dado, zy);
    m.quad([x, DADO, 0], [x, DADO, WALL], [x, BEAM_TOP, WALL], [x, BEAM_TOP, 0], n, MAT.plaster, zy);
  }

  // The frame of tiles: up one side of the opening, round the arch and down the other. Inner
  // edge on the opening, outer edge a tile further out; u runs along the frame.
  const inner: Vec3[] = [[-hw, 0, 0]];
  const outer: Vec3[] = [[-hw - TILE, 0, 0]];
  const along: number[] = [0];
  let u = o.spring;
  let prev: Vec3 | null = null;
  for (let i = 0; i <= ARCH_SEGMENTS; i++) {
    const phi = Math.PI * (1 - i / ARCH_SEGMENTS);
    const a: Vec3 = [hw * Math.cos(phi), o.spring + rise * Math.sin(phi), 0];
    const b: Vec3 = [(hw + TILE) * Math.cos(phi), o.spring + (rise + TILE) * Math.sin(phi), 0];
    const mid = scale(add(a, b), 0.5);
    if (prev) u += length(sub(mid, prev));
    prev = mid;
    inner.push(a);
    outer.push(b);
    along.push(u);
  }
  inner.push([hw, 0, 0]);
  outer.push([hw + TILE, 0, 0]);
  along.push(u + o.spring);
  for (let i = 0; i + 1 < inner.length; i++) {
    const uvs: UV[] = [[along[i], 0], [along[i], TILE], [along[i + 1], TILE], [along[i + 1], 0]];
    const corners = [inner[i], outer[i], outer[i + 1], inner[i + 1]];
    for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(corners[k], [0, 0, 1], uvs[k], MAT.talavera);
  }

  // Plaster around it, up to the mantel beam: strips down to the frame's outer edge.
  const edge = hw + TILE;
  m.quad([-BREAST, 0, 0], [-edge, 0, 0], [-edge, FACE_TOP, 0], [-BREAST, FACE_TOP, 0], [0, 0, 1], MAT.plaster, xy);
  m.quad([edge, 0, 0], [BREAST, 0, 0], [BREAST, FACE_TOP, 0], [edge, FACE_TOP, 0], [0, 0, 1], MAT.plaster, xy);
  for (let i = 1; i + 2 < outer.length; i++) {
    const [a, b] = [outer[i], outer[i + 1]];
    m.quad(a, b, [b[0], FACE_TOP, 0], [a[0], FACE_TOP, 0], [0, 0, 1], MAT.plaster, xy);
  }

  // The underside of the arch, tiled as well.
  const depth = 0.1;
  let s = 0;
  for (let i = 1; i + 2 < inner.length; i++) {
    const [a, b] = [inner[i], inner[i + 1]];
    const step = length(sub(b, a));
    const phi = Math.PI * (1 - (i - 0.5) / ARCH_SEGMENTS);
    const n = normalize([-Math.cos(phi) / hw, -Math.sin(phi) / Math.max(rise, 1e-3), 0]);
    const corners: Vec3[] = [a, b, [b[0], b[1], -depth], [a[0], a[1], -depth]];
    const uvs: UV[] = [[s, 0], [s + step, 0], [s + step, depth], [s, depth]];
    for (const k of [0, 1, 2, 0, 2, 3]) m.vertex(corners[k], n, uvs[k], MAT.talavera);
    s += step;
  }

  // The hood, narrowing up to the ceiling and leaning back a little.
  const hood: Vec3[] = [[-BREAST, BEAM_TOP, 0], [BREAST, BEAM_TOP, 0], [HOOD, CEILING, -0.1], [-HOOD, CEILING, -0.1]];
  m.quad(hood[0], hood[1], hood[2], hood[3], normalize(cross(sub(hood[1], hood[0]), sub(hood[3], hood[0]))), MAT.plaster, xy);
  for (const side of [-1, 1]) {
    const bottom: Vec3 = [side * BREAST, BEAM_TOP, 0];
    const top: Vec3 = [side * HOOD, CEILING, -0.1];
    let n = normalize(cross(sub(top, bottom), [0, 0, -1]));
    if (n[0] * side < 0) n = scale(n, -1);
    m.quad(bottom, top, [top[0], CEILING, WALL], [bottom[0], BEAM_TOP, WALL], n, MAT.plaster, zy);
  }
}

/** The raised hearth: terracotta on top, a riser of Talavera tiles. */
function buildHearth(m: MeshBuilder) {
  const { halfWidth: w, depth: d } = HEARTH;
  m.quad([-w, 0, 0], [w, 0, 0], [w, 0, d], [-w, 0, d], [0, 1, 0], MAT.terracotta, (p) => [p[0] * 1.5, p[2] * 1.5]);
  m.quad([-w, FLOOR, d], [w, FLOOR, d], [w, 0, d], [-w, 0, d], [0, 0, 1], MAT.talavera, (p) => [p[0] + w, p[1] - FLOOR]);
  for (const side of [-1, 1]) {
    const x = side * w;
    m.quad([x, FLOOR, 0], [x, FLOOR, d], [x, 0, d], [x, 0, 0], [side, 0, 0], MAT.talavera, (p) => [p[2], p[1] - FLOOR]);
  }
  // A rounded terracotta nosing along the front edge.
  m.cylinder([-w - 0.012, -0.006, d + 0.004], [w + 0.012, -0.006, d + 0.004], 0.012, MAT.terracotta, { segments: 12, capMat: MAT.terracotta });
}

/** A heavy, hand-hewn beam on stepped corbels. */
function buildMantel(m: MeshBuilder) {
  m.box([-0.96, FACE_TOP, -0.02], [0.96, BEAM_TOP, 0.16], MAT.beam);
  for (const side of [-1, 1]) {
    const [xa, xb] = side < 0 ? [-0.86, -0.66] : [0.66, 0.86];
    m.box([xa, 0.8, -0.01], [xb, FACE_TOP, 0.13], MAT.beam);
    m.box([xa + 0.03, 0.73, -0.01], [xb - 0.03, 0.8, 0.09], MAT.beam);
  }
}

/** Spare firewood stacked at the end of the hearth, cut ends toward the room. */
function buildFirewood(m: MeshBuilder) {
  woodStack(m, 0.57, 0.88, 0, 0.05, 0.43, 4, ['encina', 'olivo'], 11);
}

/** A big water jar (olla) and a small jug. */
function buildPottery(m: MeshBuilder) {
  const olla: [number, number][] = [
    [0, 0], [0.06, 0.002], [0.1, 0.02], [0.135, 0.07], [0.148, 0.13], [0.14, 0.19], [0.115, 0.245],
    [0.08, 0.285], [0.062, 0.305], [0.06, 0.33], [0.068, 0.345], [0.074, 0.352], [0.07, 0.356], [0.058, 0.35],
  ];
  for (const [x, z, k] of [[-0.8, 0.25, 1], [-0.6, 0.37, 0.55]]) {
    m.lathe([x, 0, z], olla.map(([r, y]) => [r * k, y * k] as [number, number]), MAT.pottery, 40);
    // The dark inside of its mouth.
    m.lathe([x, 0.33 * k, z], [[0, 0], [0.059 * k, 0]], MAT.soot, 24);
  }
}

/** Beeswax candles on terracotta dishes: on the hearth, and one in the niche. */
function buildCandles(m: MeshBuilder, room: Room) {
  room.candles.forEach(([x, flameY, z], i) => {
    const top = flameY - 0.004;
    const foot = flameY > NICHE.sill ? NICHE.sill : 0;
    m.lathe([x, foot, z], [[0, 0], [0.042, 0], [0.05, 0.004], [0.053, 0.016], [0.048, 0.017], [0.042, 0.009], [0, 0.009]], MAT.pottery, 28);
    m.cylinder([x, foot + 0.009, z], [x, top, z], 0.021, MAT.wax, { segments: 20, capMat: MAT.wax });
    m.cylinder([x, top - 0.001, z], [x, top + 0.006, z], 0.0012, MAT.soot, { segments: 6 });
    m.flame([x, flameY, z], i);
  });
}

/**
 * Faroles: little wrought-iron lanterns on brackets either side of the opening, square, with
 * glass panes and a pointed cap.
 */
function buildFaroles(m: MeshBuilder, room: Room) {
  const IRON = { segments: 8, capMat: MAT.iron };
  for (const lamp of room.lamps) {
    const [x, y, z] = lamp.pos;
    const w = 0.034; // half width of the lantern
    const lo = y - 0.058;
    const hi = y + 0.052;
    // The bracket: an arm out from the wall with a brace under it, the lantern hanging off it.
    m.cylinder([x, hi + 0.075, 0.004], [x, hi + 0.075, z + 0.012], 0.0045, MAT.iron, IRON);
    m.cylinder([x, hi - 0.02, 0.004], [x, hi + 0.07, z - 0.03], 0.0035, MAT.iron, IRON);
    m.box([x - 0.018, hi - 0.035, 0], [x + 0.018, hi + 0.095, 0.005], MAT.iron);
    m.cylinder([x, hi + 0.075, z], [x, hi + 0.04, z], 0.0025, MAT.iron, { segments: 6 });
    // Frame, panes, base and cap.
    for (const [dx, dz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      m.cylinder([x + dx * w, lo, z + dz * w], [x + dx * w, hi, z + dz * w], 0.003, MAT.iron, { segments: 6 });
    }
    const g = w - 0.002;
    const pane = (a: Vec3, b: Vec3, n: Vec3) => m.quad(a, b, [b[0], hi, b[2]], [a[0], hi, a[2]], n, MAT.glass, (p) => [p[0] + p[2], p[1]]);
    pane([x - g, lo, z + g], [x + g, lo, z + g], [0, 0, 1]);
    pane([x + g, lo, z - g], [x - g, lo, z - g], [0, 0, -1]);
    pane([x + g, lo, z + g], [x + g, lo, z - g], [1, 0, 0]);
    pane([x - g, lo, z - g], [x - g, lo, z + g], [-1, 0, 0]);
    m.box([x - w - 0.004, lo - 0.012, z - w - 0.004], [x + w + 0.004, lo, z + w + 0.004], MAT.iron);
    m.lathe([x, hi, z], [[w * 1.5, 0], [w * 1.2, 0.012], [0.006, 0.045], [0, 0.05]], MAT.iron, 4);
    m.lathe([x, lo - 0.012, z], [[0.008, 0], [0.003, -0.02]], MAT.iron, 8);
    // A candle-shaped bulb inside.
    m.cylinder([x, lo, z], [x, y - 0.012, z], 0.009, MAT.wax, { segments: 10, capMat: MAT.wax });
  }
}

/** A kilim on the floor in front of the hearth. */
function buildRug(m: MeshBuilder) {
  rug(m, -0.9, 0.9, 0.62, 2.62, FLOOR + 0.004, 1);
}
