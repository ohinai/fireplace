import type { BigfootView, CritterView } from '../critters';
import { LIGHTER, type LighterView } from '../sim/LogSystem';
import { add, cross, length, normalize, scale, sub, type Vec3 } from '../math';
import type { ToolView } from '../tools';
import { MAT, MeshBuilder } from './geometry';
import { frustum } from './props';

const IRON = { segments: 10, capMat: MAT.iron };
const BRASS = { segments: 14, capMat: MAT.brass };
const MATCH_LENGTH = 0.26;

/**
 * Mesh (in the scene's vertex format) of what moves about: the tool in hand, the firelighters,
 * and the creatures round a campfire.
 */
export function buildPropsMesh(view: ToolView | null, lighters: LighterView[], critters: CritterView[]): Float32Array {
  const m = new MeshBuilder();
  if (view) buildTool(m, view);
  for (const l of lighters) {
    // A cube of waxy fibre, burning down from the top. (uv: how much has burnt, how alight it is.)
    const s = LIGHTER.size / 2;
    const [x, y, z] = l.pos;
    m.boxUV([x - s, y, z - s], [x + s, y + l.height, z + s], MAT.firelighter, [l.spent, l.burning]);
  }
  for (const c of critters) {
    if (c.kind === 'glow') m.glowDot(c.pos, c.size, c.bright, c.tint === 'eyes' ? 1 : 0);
    else if (c.kind === 'wings') m.wings(c.pos, c.heading, c.span, c.flap, c.pale);
    else bigfoot(m, c);
  }
  return m.build();
}

function buildTool(m: MeshBuilder, view: ToolView) {
  if (view.kind === 'poker') {
    // A plain iron poker with a hook near the tip and a wooden handle.
    const { tip, dir } = view;
    const at = (d: number) => add(tip, scale(dir, d));
    const across = normalize(cross(perpendicular(dir), dir));
    m.cylinder(tip, at(0.62), 0.0055, MAT.iron, IRON);
    m.cylinder(at(0.03), add(at(0.055), scale(across, 0.038)), 0.0045, MAT.iron, IRON);
    m.cylinder(at(0.62), at(0.64), 0.009, MAT.brass, BRASS);
    m.cylinder(at(0.64), at(0.78), 0.012, MAT.mantel, BRASS);
  } else if (view.kind === 'match') {
    // A long fireplace match: a red head, a pale stick charring back from it while it burns,
    // and its flame (the match's slot among the small flames).
    const { tip, dir, burnt } = view;
    const at = (d: number) => add(tip, scale(dir, d));
    m.cylinder(at(-0.003), at(0.009), 0.0033, MAT.matchHead, { segments: 10, capMat: MAT.matchHead, uv: () => [0, burnt > 0 ? 1 : 0] });
    m.cylinder(at(0.006), at(MATCH_LENGTH), 0.0021, MAT.match, { segments: 8, capMat: MAT.match, uv: (s) => [0.006 + s * (MATCH_LENGTH - 0.006), burnt] });
    if (view.lit) m.flame(add(tip, [0, 0.003, 0]), 3);
  } else {
    // Fire tongs: two iron arms on a pivot, their jaws closed on the log.
    const { grip, axis, radius, dir } = view;
    let across = cross(axis, dir);
    if (length(across) < 0.2) across = cross(axis, perpendicular(axis));
    across = normalize(across);
    const pivot = add(grip, scale(dir, radius + 0.15));
    for (const side of [-1, 1]) {
      const off = (d: number) => scale(across, side * d);
      const jaw = add(grip, off(radius + 0.006));
      const bend = add(add(grip, scale(dir, radius + 0.045)), off(radius + 0.03));
      const hinge = add(pivot, off(0.009));
      const end = add(add(pivot, scale(dir, 0.3)), off(0.03));
      m.cylinder(add(jaw, scale(axis, -0.022)), add(jaw, scale(axis, 0.022)), 0.0065, MAT.iron, IRON);
      m.cylinder(jaw, bend, 0.005, MAT.iron, IRON);
      m.cylinder(bend, hinge, 0.005, MAT.iron, IRON);
      m.cylinder(hinge, end, 0.005, MAT.iron, IRON);
      m.cylinder(end, add(end, scale(dir, 0.06)), 0.009, MAT.brass, BRASS);
    }
    m.cylinder(add(pivot, scale(across, -0.016)), add(pivot, scale(across, 0.016)), 0.007, MAT.brass, BRASS);
  }
}

/** Some direction perpendicular to v. */
function perpendicular(v: Vec3): Vec3 {
  const c = cross(v, [0, 1, 0]);
  return length(c) > 0.1 ? normalize(c) : normalize(cross(v, [1, 0, 0]));
}

/** An ellipsoid on axes of its own (unit vectors a, b, c; radii r along them). */
function blob(m: MeshBuilder, centre: Vec3, a: Vec3, b: Vec3, c: Vec3, r: Vec3, mat: number, rows = 7, cols = 12) {
  const point = (i: number, j: number): [Vec3, Vec3] => {
    const lat = (i / rows) * Math.PI - Math.PI / 2;
    const lon = (j / cols) * Math.PI * 2;
    const [x, y, z] = [Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon)];
    const p = add(centre, add(add(scale(a, x * r[0]), scale(b, y * r[1])), scale(c, z * r[2])));
    const n = normalize(add(add(scale(a, x / r[0]), scale(b, y / r[1])), scale(c, z / r[2])));
    return [p, n];
  };
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      for (const [u, v] of [[i, j], [i + 1, j], [i + 1, j + 1], [i, j], [i + 1, j + 1], [i, j + 1]]) {
        const [p, n] = point(u, v);
        m.vertex(p, n, [0, 0], mat);
      }
    }
  }
}

/**
 * Bigfoot, walking: tall (well over two metres) and heavy, all over shaggy dark hair; its head
 * low on broad shoulders with a crest to it, no neck to speak of; long arms swinging, hands down
 * by its knees; leaning a little forward, it strides with bent knees. When it stops to look, its
 * head turns toward the fire.
 */
function bigfoot(m: MeshBuilder, v: BigfootView) {
  const f = v.heading;
  const side: Vec3 = [-f[2], 0, f[0]];
  const up: Vec3 = [0, 1, 0];
  const bob = 0.035 * Math.abs(Math.sin(v.stride));
  /** A point in its frame: across (to one side), up, and forward. */
  const at = (x: number, y: number, z: number): Vec3 => add(v.pos, add(add(scale(side, x), scale(up, y + bob)), scale(f, z)));
  const lean = normalize(add(up, scale(f, 0.2))); // (its body leans forward a little)
  const ahead = normalize(sub(f, scale(up, 0.2)));
  const hair = MAT.hair;
  // Hips, belly, chest and the great shoulders.
  blob(m, at(0, 1.07, 0), side, up, f, [0.27, 0.2, 0.2], hair);
  blob(m, at(0, 1.45, 0.05), side, lean, ahead, [0.34, 0.36, 0.25], hair);
  blob(m, at(0, 1.76, 0.1), side, lean, ahead, [0.43, 0.22, 0.25], hair);
  // Its head, turning toward the fire as it looks; a crest along the top of it.
  const face = normalize(add(scale(f, 1 - v.look), scale(v.toward, v.look)));
  const faceSide: Vec3 = [-face[2], 0, face[0]];
  const head = at(0, 2.07, 0.12);
  blob(m, head, faceSide, up, face, [0.14, 0.16, 0.15], hair);
  blob(m, add(head, add(scale(up, 0.11), scale(face, -0.04))), faceSide, up, face, [0.06, 0.08, 0.11], hair);
  // Legs: from the hips, the thighs swinging, the knees bent (most as the leg comes forward).
  for (const s of [-1, 1]) {
    const psi = v.stride + (s > 0 ? Math.PI : 0);
    const swing = 0.42 * Math.sin(psi);
    const bend = 0.15 + 0.5 * Math.pow(Math.max(0, Math.cos(psi)), 1.5);
    const hip = at(s * 0.16, 1.02, 0);
    const knee = add(hip, add(scale(up, -0.5 * Math.cos(swing)), scale(f, 0.5 * Math.sin(swing))));
    const ankle = add(knee, add(scale(up, -0.48 * Math.cos(swing - bend)), scale(f, 0.48 * Math.sin(swing - bend))));
    frustum(m, hip, knee, 0.15, 0.11, 9, hair);
    frustum(m, knee, ankle, 0.11, 0.075, 9, hair);
    blob(m, knee, side, up, f, [0.11, 0.11, 0.11], hair, 5, 8);
    blob(m, add(ankle, add(scale(f, 0.08), scale(up, -0.035))), side, up, f, [0.085, 0.05, 0.17], hair, 5, 8);
  }
  // Arms: long, swinging against the legs; the hands down by the knees.
  for (const s of [-1, 1]) {
    const swing = -0.45 * Math.sin(v.stride + (s > 0 ? Math.PI : 0)) * (1 - v.look);
    const shoulder = at(s * 0.4, 1.8, 0.08);
    const elbow = add(shoulder, add(scale(up, -0.5 * Math.cos(swing)), scale(f, 0.5 * Math.sin(swing))));
    const bend = swing + 0.35;
    const wrist = add(elbow, add(scale(up, -0.48 * Math.cos(bend)), scale(f, 0.48 * Math.sin(bend))));
    frustum(m, shoulder, elbow, 0.11, 0.09, 9, hair);
    frustum(m, elbow, wrist, 0.09, 0.07, 9, hair);
    blob(m, elbow, side, up, f, [0.09, 0.09, 0.09], hair, 5, 8);
    const hand = normalize(sub(wrist, elbow));
    blob(m, add(wrist, scale(hand, 0.08)), side, hand, normalize(cross(side, hand)), [0.05, 0.11, 0.06], hair, 5, 8);
  }
}
