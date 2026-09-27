import { add, cross, normalize, scale, sub, type Vec3 } from '../math';
import { MAT, type MeshBuilder } from './geometry';
import { frustum } from './props';

// Conifers of the Cascades seen across a mountain meadow: subalpine firs and mountain hemlocks,
// tall and narrow, their branches in drooping layers, ragged at the edges and uneven (a layer
// missing here, a longer branch there), a thin leader at the top; and here and there a dead
// snag, bleached and bare.

const BARK: Vec3 = [0.28, 0.22, 0.18];

/**
 * A conifer standing at `base`, `height` tall and `width` across at its widest. `layers`
 * (0..1) is how finely its branches are built (less is quicker to draw).
 */
export function conifer(m: MeshBuilder, rnd: () => number, base: Vec3, height: number, width: number, layers: number) {
  // The trunk, leaning and wandering a little; only the lowest part shows below the branches.
  const lean: Vec3 = [(rnd() - 0.5) * 0.03, 1, (rnd() - 0.5) * 0.03];
  const trunkAt = (t: number): Vec3 => add(add(base, scale(lean, height * t)), [Math.sin(t * 5 + base[0]) * 0.04 * t, 0, Math.cos(t * 4 + base[2]) * 0.04 * t]);
  m.with(BARK, () => frustum(m, add(base, [0, -0.4, 0]), trunkAt(0.92), width * 0.045 + 0.05, 0.025, 7, MAT.bark));
  // Hemlocks droop more and are broader below; firs are narrow spires.
  const hemlock = rnd() < 0.4;
  const count = Math.max(8, Math.round((height / 0.6) * layers));
  const start = 0.08 + 0.1 * rnd();
  const spacing = (height * (1 - start)) / count;
  for (let k = 0; k < count; k++) {
    const t = start + (1 - start) * ((k + 0.5) / count);
    // A whorl missing now and then: the sky shows through.
    if (t < 0.85 && rnd() < 0.1) continue;
    const taper = hemlock ? Math.pow(1 - t, 0.85) : Math.pow(1 - t, 0.65) * (1 - 0.35 * Math.pow(t, 3));
    const r = (width / 2) * taper * (0.75 + 0.5 * rnd());
    if (r < 0.05) continue;
    // (Each layer droops far enough to overlap the one below: near the top, steep sprays.)
    layer(m, rnd, trunkAt(t), r, Math.max(hemlock ? 0.55 : 0.35, (1.2 * spacing) / r));
  }
  // The leader: a thin spike at the top (a hemlock's nods over).
  const tip = add(trunkAt(1), scale(hemlock ? [0.25, 0.45, 0.1] : [0.02, 0.7, 0.01], height / 15));
  frustum(m, trunkAt(0.9), tip, 0.03, 0.004, 5, MAT.needles);
}

/**
 * One layer of branches round the trunk at `at`: a ragged star of sprays, `r` out, drooping
 * toward their tips.
 */
function layer(m: MeshBuilder, rnd: () => number, at: Vec3, r: number, droop: number) {
  const spokes = 7 + Math.floor(rnd() * 4);
  const turn = rnd() * Math.PI * 2;
  const tips: Vec3[] = [];
  const valleys: Vec3[] = [];
  for (let j = 0; j < spokes; j++) {
    const a = turn + ((j + (rnd() - 0.5) * 0.5) / spokes) * Math.PI * 2;
    const len = r * (0.6 + 0.55 * rnd());
    tips.push(add(at, [Math.cos(a) * len, -len * (droop + 0.25 * rnd()), Math.sin(a) * len]));
    const b = a + Math.PI / spokes;
    const v = len * (0.35 + 0.2 * rnd());
    valleys.push(add(at, [Math.cos(b) * v, -v * droop * 0.8, Math.sin(b) * v]));
  }
  const hub = add(at, [0, r * 0.12, 0]);
  for (let j = 0; j < spokes; j++) {
    for (const [p, q] of [[valleys[(j + spokes - 1) % spokes], tips[j]], [tips[j], valleys[j]]] as [Vec3, Vec3][]) {
      let n = normalize(cross(sub(p, hub), sub(q, hub)));
      if (n[1] < 0) n = scale(n, -1);
      for (const v of [hub, p, q]) m.vertex(v, n, [v[0], v[2]], MAT.needles);
    }
  }
}

/** A dead tree still standing: a bleached, tapering trunk with a few broken-off branches. */
export function snag(m: MeshBuilder, rnd: () => number, base: Vec3, height: number) {
  const top = add(base, [(rnd() - 0.5) * 0.4, height, (rnd() - 0.5) * 0.4]);
  frustum(m, add(base, [0, -0.4, 0]), top, 0.2, 0.03, 7, MAT.driftwood);
  for (let y = height * 0.3; y < height * 0.9; y += 0.8 + rnd() * 1.4) {
    const a = rnd() * Math.PI * 2;
    const at = add(base, scale(sub(top, base), y / height));
    frustum(m, at, add(at, [Math.cos(a) * (0.3 + 0.6 * rnd()), -0.1 - 0.3 * rnd(), Math.sin(a) * (0.3 + 0.6 * rnd())]), 0.03, 0.008, 5, MAT.driftwood);
  }
}
