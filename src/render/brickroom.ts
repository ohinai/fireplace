import type { Detail } from '../config';
import type { Vec3 } from '../math';
import type { Room } from '../rooms';
import { cat } from './cat';
import { armchair, bookshelf, candlestick, companionSet, figPlant, logBasket, mantelClock, picture, rug, sideTable, book } from './furniture';
import { MAT, type MeshBuilder, type UV } from './geometry';

// A sitting room round a brick fireplace: the chimney breast of old red brick up to the ceiling,
// bookshelves built into the alcoves either side of it, walls painted a warm stone colour above
// the skirting, a wooden floor. On the mantel a clock, candlesticks and books, a painting above;
// by the hearth a basket of logs and the fire irons; a rug, an armchair drawn up to the fire.
// (With more detail: a table by the chair with a mug of tea, a cat asleep on the rug, a fig.)

const FLOOR = -0.05;
const CEILING = 2.45;
const BREAST = 1.0; // half width of the chimney breast
const ALCOVE = -0.4; // the wall either side of it
const SIDE = 3.0; // the side walls
const PAINT: Vec3 = [0.6, 0.53, 0.43];
const WHITE: Vec3 = [0.8, 0.77, 0.7];

const xy = (p: Vec3): UV => [p[0], p[1]];
const zy = (p: Vec3): UV => [p[2], p[1]];
const xz = (p: Vec3): UV => [p[0], p[2]];

/** The chair drawn up to the fire, and where one sits in it (see the room's 'chair' view). */
export const ARMCHAIR = { at: [-1.45, FLOOR, 1.97] as Vec3, yaw: 2.54 };

export function buildBrickRoom(m: MeshBuilder, room: Room, detail: Detail) {
  buildShell(m, room);
  buildMantel(m);
  buildLamps(m, room);
  buildCandles(m, room);
  if (detail === 'low') return;
  // The mantelpiece: a clock in the middle, candlesticks at the ends, books, a painting above.
  m.at([0, 1.03, 0.08], 0, () => mantelClock(m));
  for (const x of [-0.6, 0.6]) m.at([x, 1.03, 0.1], 0, () => candlestick(m, 0.24));
  m.at([0.36, 1.03, 0.1], 0.25, () => {
    let y = 0;
    for (const [w, h, t, seed] of [[0.17, 0.24, 0.035, 0.12], [0.15, 0.22, 0.028, 0.57], [0.13, 0.19, 0.022, 0.83]]) {
      m.at([0, y, 0], (seed - 0.5) * 0.3, () => book(m, [w, h, t], seed, true));
      y += t;
    }
  });
  m.with([0.28, 0.38, 0.34], () => m.lathe([-0.35, 1.03, 0.1], [[0, 0], [0.04, 0], [0.055, 0.05], [0.05, 0.11], [0.028, 0.16], [0.026, 0.19], [0.034, 0.2], [0, 0.2]], MAT.ceramic, 24));
  m.at([0, 1.2, 0.002], 0, () => picture(m, 0.86, 0.62, 3));
  // By the hearth: the fire irons, a basket of logs. (Like the rest of the furniture, each fades
  // to a ghost if it comes between the eye and the fire.)
  m.seeThrough(() => m.at([0.95, FLOOR, 0.28], -0.3, () => companionSet(m)));
  m.seeThrough(() => m.at([-1.28, FLOOR, 0.3], 0.1, () => logBasket(m, ['oak', 'birch'], 5)));
  // The alcoves: shelves of books.
  for (const side of [-1, 1]) m.at([side * (BREAST + SIDE) / 2, FLOOR, ALCOVE], 0, () => bookshelf(m, SIDE - BREAST - 0.1, 2.3, 0.34, side < 0 ? 17 : 29));
  rug(m, -1.0, 1.0, 0.58, 2.35, FLOOR + 0.004, 2);
  m.seeThrough(() => m.at(ARMCHAIR.at, ARMCHAIR.yaw, () => armchair(m, [0.12, 0.2, 0.14])));
  if (detail !== 'high') return;
  m.seeThrough(() => m.at([-0.72, FLOOR, 2.42], 0.5, () => sideTable(m)));
  m.seeThrough(() => m.with([0.55, 0.36, 0.1], () => m.ellipsoid([-1.3, FLOOR + 0.62, 1.78], [0.15, 0.12, 0.07], MAT.fabric, 8, 14)));
  // (Near the hearth, in the firelight: its head toward the fire, its face and its left side
  // toward the armchair.)
  m.seeThrough(() => cat(m, [0.38, FLOOR, 0.84], -2.55));
  m.seeThrough(() => m.at([2.45, FLOOR, 0.55], 0, () => figPlant(m, 9)));
}

/**
 * Walls, floor and ceiling: the brick breast with the fireplace opening, the alcoves either
 * side, painted walls with skirting and a cornice, and the floorboards.
 */
function buildShell(m: MeshBuilder, room: Room) {
  const fw = room.opening.halfWidth;
  const OH = room.opening.apex;
  // The breast's face, round the opening, and the underside of the lintel.
  m.quad([-BREAST, FLOOR, 0], [-fw, FLOOR, 0], [-fw, CEILING, 0], [-BREAST, CEILING, 0], [0, 0, 1], MAT.brick, xy);
  m.quad([fw, FLOOR, 0], [BREAST, FLOOR, 0], [BREAST, CEILING, 0], [fw, CEILING, 0], [0, 0, 1], MAT.brick, xy);
  m.quad([-fw, OH, 0], [fw, OH, 0], [fw, CEILING, 0], [-fw, CEILING, 0], [0, 0, 1], MAT.brick, xy);
  m.quad([-fw, OH, -0.1], [fw, OH, -0.1], [fw, OH, 0], [-fw, OH, 0], [0, -1, 0], MAT.brick, (p) => [p[0], p[2]]);
  // Its sides, back to the alcoves.
  for (const side of [-1, 1]) {
    const x = side * BREAST;
    m.quad([x, FLOOR, 0], [x, FLOOR, ALCOVE], [x, CEILING, ALCOVE], [x, CEILING, 0], [side, 0, 0], MAT.brick, zy);
  }
  // The hearth: a slab of stone in front of the fire.
  m.box([-0.78, FLOOR, 0], [0.78, 0, 0.46], MAT.hearth);
  // Floor, ceiling and the painted walls.
  m.quad([-SIDE, FLOOR, ALCOVE], [SIDE, FLOOR, ALCOVE], [SIDE, FLOOR, 5], [-SIDE, FLOOR, 5], [0, 1, 0], MAT.floor, xz);
  m.with(WHITE, () => m.quad([-SIDE, CEILING, 5], [SIDE, CEILING, 5], [SIDE, CEILING, ALCOVE], [-SIDE, CEILING, ALCOVE], [0, -1, 0], MAT.paint, xz));
  m.with(PAINT, () => {
    for (const side of [-1, 1]) {
      const [x0, x1] = side < 0 ? [-SIDE, -BREAST] : [BREAST, SIDE];
      m.quad([x0, FLOOR, ALCOVE], [x1, FLOOR, ALCOVE], [x1, CEILING, ALCOVE], [x0, CEILING, ALCOVE], [0, 0, 1], MAT.paint, xy);
      const x = side * SIDE;
      m.quad([x, FLOOR, 5], [x, FLOOR, ALCOVE], [x, CEILING, ALCOVE], [x, CEILING, 5], [-side, 0, 0], MAT.paint, zy);
    }
  });
  // Skirting boards and a cornice where the walls meet the floor and the ceiling.
  m.with(WHITE, () => {
    for (const side of [-1, 1]) {
      m.box([side < 0 ? -SIDE : BREAST, FLOOR, ALCOVE], [side < 0 ? -BREAST : SIDE, FLOOR + 0.16, ALCOVE + 0.02], MAT.finish);
      m.box([side * SIDE - 0.02, FLOOR, ALCOVE], [side * SIDE + 0.02, FLOOR + 0.16, 5], MAT.finish);
      m.box([side < 0 ? -SIDE : BREAST, CEILING - 0.1, ALCOVE], [side < 0 ? -BREAST : SIDE, CEILING, ALCOVE + 0.07], MAT.finish);
      m.box([side * SIDE - 0.07, CEILING - 0.1, ALCOVE], [side * SIDE + 0.07, CEILING, 5], MAT.finish);
    }
    m.box([-BREAST - 0.02, CEILING - 0.1, 0], [BREAST + 0.02, CEILING, 0.07], MAT.finish);
  });
}

/** The mantel: a shelf of dark oak on a moulding, a little proud of the brick. */
function buildMantel(m: MeshBuilder) {
  m.box([-0.84, 0.985, -0.01], [0.84, 1.03, 0.22], MAT.mantel);
  m.box([-0.8, 0.95, -0.01], [0.8, 0.985, 0.17], MAT.mantel);
  m.box([-0.78, 0.93, -0.01], [0.78, 0.95, 0.12], MAT.mantel);
  for (const x of [-0.72, 0.72]) m.box([x - 0.05, 0.84, -0.01], [x + 0.05, 0.95, 0.1], MAT.mantel);
}

/** Brass wall lights with fabric shades, either side of the fireplace. */
function buildLamps(m: MeshBuilder, room: Room) {
  for (const lamp of room.lamps) {
    // A wall light: a brass backplate, an arm out from the wall, a drum shade round the bulb.
    const [x, y, z] = lamp.pos;
    m.box([x - 0.028, y - 0.075, 0], [x + 0.028, y + 0.035, 0.012], MAT.brass);
    m.cylinder([x, y - 0.06, 0.006], [x, y - 0.06, z], 0.006, MAT.brass, { segments: 10 });
    m.cylinder([x, y - 0.066, z], [x, y - 0.018, z], 0.012, MAT.brass, { segments: 12, capMat: MAT.brass });
    m.cylinder([x, y - 0.018, z], [x, y + 0.028, z], 0.009, MAT.glass, { segments: 12, capMat: MAT.glass });
    m.lathe([x, y - 0.052, z], [[0.068, 0], [0.066, 0.02], [0.06, 0.06], [0.052, 0.098]], MAT.shade, 40);
  }
}

/** Pillar candles of different heights on the hearth. */
function buildCandles(m: MeshBuilder, room: Room) {
  room.candles.forEach(([x, flameY, z], i) => {
    const r = [0.029, 0.026, 0.025][i] ?? 0.026;
    const top = flameY - 0.004;
    m.cylinder([x, 0, z], [x, top, z], r, MAT.wax, { segments: 24, capMat: MAT.wax });
    m.cylinder([x, top - 0.001, z], [x, top + 0.006, z], 0.0012, MAT.soot, { segments: 6 });
    m.flame([x, flameY, z], i);
  });
}
