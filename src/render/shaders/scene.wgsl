// Fireplace, room, campsite: everything but the logs, lit by the fire. Materials are procedural.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var linSamp: sampler;
@group(0) @binding(2) var scal: texture_3d<f32>;
@group(0) @binding(3) var<storage, read> bb: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(5) var bedMap: texture_2d<f32>;

const MAT_FIREBRICK: u32 = 0u;
const MAT_BRICK: u32 = 1u;
const MAT_HEARTH: u32 = 2u;
const MAT_IRON: u32 = 3u;
const MAT_EMBERS: u32 = 5u;
const MAT_FLOOR: u32 = 6u;
const MAT_MANTEL: u32 = 7u;
const MAT_SOOT: u32 = 8u;
const MAT_BRASS: u32 = 9u;
// The hacienda.
const MAT_PLASTER: u32 = 10u;
const MAT_DADO: u32 = 11u;
const MAT_ADOBE: u32 = 12u;
const MAT_TALAVERA: u32 = 13u;
const MAT_TERRACOTTA: u32 = 14u;
const MAT_BEAM: u32 = 15u;
const MAT_POTTERY: u32 = 16u;
const MAT_BARK: u32 = 17u;
const MAT_END_GRAIN: u32 = 18u;
const MAT_WAX: u32 = 19u;
const MAT_FLAME: u32 = 20u;
const MAT_RUG: u32 = 21u;
// The campsite.
const MAT_SKY: u32 = 22u;
const MAT_GROUND: u32 = 23u;
const MAT_STONE: u32 = 24u;
// Lamps, firelighters, the match.
const MAT_SHADE: u32 = 26u;
const MAT_GLASS: u32 = 27u;
const MAT_FIRELIGHTER: u32 = 28u;
const MAT_MATCH: u32 = 29u;
const MAT_MATCH_HEAD: u32 = 30u;
const MAT_JAR: u32 = 31u;
const MAT_TIN: u32 = 32u;
// Critters.
const MAT_GLOW: u32 = 33u;
const MAT_CRITTER: u32 = 34u;
// Firewood lying about.
const MAT_SPLIT_WOOD: u32 = 35u;
const MAT_DRIFTWOOD: u32 = 36u;
// Furnishings (furnishings.wgsl).
const MAT_WICKER: u32 = 37u;
const MAT_FABRIC: u32 = 38u;
const MAT_BOOK: u32 = 39u;
const MAT_PAINTING: u32 = 40u;
const MAT_GILT: u32 = 41u;
const MAT_CLOCK_FACE: u32 = 42u;
const MAT_PAINT: u32 = 43u;
const MAT_FINISH: u32 = 44u;
const MAT_FUR: u32 = 45u;
const MAT_LEAF: u32 = 46u;
const MAT_CERAMIC: u32 = 47u;
const MAT_PAGES: u32 = 48u;
const MAT_PLATE: u32 = 49u;
const MAT_CHILE: u32 = 50u;
const MAT_NEEDLES: u32 = 51u;
// The desert.
const MAT_SAND: u32 = 52u;
const MAT_TENT: u32 = 53u;
const MAT_KETTLE: u32 = 54u;
const MAT_TEA_GLASS: u32 = 55u;
const MAT_MOUNTAIN: u32 = 56u;
const MAT_HAIR: u32 = 57u;

const TALAVERA_TILE: f32 = 0.105; // m (must match hacienda.ts)
const FLAME_HEIGHT: f32 = 0.03;
const FLAME_WIDTH: f32 = 0.0065;

struct VIn {
  @location(0) pos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) mat: f32,
  @location(4) extra: vec3<f32>, // the material's own settings for this object (a seed, a tint...)
};

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) uv: vec2<f32>,
  @location(3) @interpolate(flat) mat: u32,
  @location(4) @interpolate(flat) extra: vec3<f32>,
  @location(5) @interpolate(flat) clear: u32, // what it is, if it can turn see-through (its number, 1 up; 0: it cannot)
  @location(6) place: vec3<f32>, // extra, blended across the triangle (where on it the point is: a cat's coat)
};

// Something that can turn see-through has its number times this added to its material (see
// geometry.ts).
const SEE_THROUGH: u32 = 128u;

// A 4 x 4 ordered dither: how much must show at this pixel for it to be drawn (0..1).
fn bayer4(pix: vec2<f32>) -> f32 {
  var m = array<f32, 16>(0.0, 8.0, 2.0, 10.0, 12.0, 4.0, 14.0, 6.0, 3.0, 11.0, 1.0, 9.0, 15.0, 7.0, 13.0, 5.0);
  let i = (u32(pix.y) & 3u) * 4u + (u32(pix.x) & 3u);
  return (m[i] + 0.5) / 16.0;
}

// Furniture (or part of a tent) that comes between the eye and the fire fades away (through a
// screen door, over a moment), so that looking round the room it never hides the fire; and so does
// anything of it right up against the eye.
fn seeThrough(id: u32, pix: vec2<f32>, p: vec3<f32>) -> bool {
  let near = smoothstep(0.6, 0.3, distance(p, F.camPos));
  let fade = F.fades[id / 4u][id % 4u];
  return max(near, fade) > bayer4(pix);
}

// The coal bed at p: temperature, CO, depth (1 = a full bed), cover (0..1).
fn bedAt(p: vec3<f32>) -> vec4<f32> {
  let uv = vec2<f32>((p.x - F.bed.x) / (F.bed.y - F.bed.x), (p.z - F.bed.z) / (F.bed.w - F.bed.z));
  return textureSampleLevel(bedMap, linSamp, uv, 0.0);
}

@vertex
fn vs(v: VIn) -> VOut {
  var o: VOut;
  let tagged = u32(v.mat + 0.5);
  let mat = tagged % SEE_THROUGH;
  o.clear = tagged / SEE_THROUGH;
  var pos = v.pos;
  var nrm = v.nrm;
  if (mat == MAT_FLAME) {
    // A candle (or match) flame: every vertex sits at the flame's base, and the normal's x says
    // which flame it is. Spread them into a teardrop that faces the viewer, stretching and
    // swaying a little; a flame that is out has no size.
    let lit = F.candles[u32(clamp(v.nrm.x, 0.0, 3.0) + 0.5)].w;
    let t = F.time;
    let phase = dot(v.pos, vec3<f32>(37.0, 11.0, 23.0));
    let stretch = 1.0 + 0.1 * sin(t * 11.0 + phase) * sin(t * 3.7 + 2.0 * phase);
    let up = v.uv.y;
    let width = FLAME_WIDTH * pow(max(sin(3.14159 * pow(up, 0.55)), 0.0), 0.8);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), F.camPos - v.pos));
    let sway = vec3<f32>(sin(t * 1.9 + phase), 0.0, cos(t * 1.3 + phase)) * (0.0025 * up * up);
    let on = select(0.0, 1.0, lit > 0.0);
    pos = v.pos + (right * (v.uv.x * width) + vec3<f32>(0.0, up * FLAME_HEIGHT * stretch, 0.0) + sway) * on;
    nrm = vec3<f32>(0.0, 0.0, 1.0);
  } else if (mat == MAT_EMBERS) {
    // The mesh is a full bed's lumps of coal: heap it up only where there are coals.
    let depth = clamp(bedAt(v.pos).z, 0.0, 1.5);
    pos.y = 0.0015 + (v.pos.y - 0.0015) * depth;
    nrm = normalize(mix(vec3<f32>(0.0, 1.0, 0.0), v.nrm, min(depth, 1.0)));
  } else if (mat == MAT_FUR) {
    // A sleeping cat breathes: its ribs slowly rise and fall. (extra: where on the cat the point
    // is; on its body, part 0, in the cat's own frame, +z toward its head: see cat.ts.)
    if (v.extra.x < 5.0) {
      let q = v.extra;
      let ribs = smoothstep(-0.17, -0.07, q.z) * smoothstep(0.17, 0.07, q.z) * smoothstep(0.012, 0.045, q.y);
      pos = v.pos + v.nrm * (0.003 * sin(F.time * 1.25) * ribs);
    }
  } else if (mat == MAT_GLOW) {
    // A glowing dot facing the viewer (normal: brightness, radius, tint). Never smaller on
    // screen than a pixel or two; a dot made bigger is made dimmer to match.
    let toCam = F.camPos - v.pos;
    let dist = length(toCam);
    let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), toCam));
    let up = cross(normalize(toCam), right);
    let pixel = 0.69 * dist / F.resolution.y; // (38 degree field of view)
    let radius = max(v.nrm.y, 1.4 * pixel);
    pos = v.pos + (right * v.uv.x + up * v.uv.y) * radius;
    let r = v.nrm.y / radius;
    nrm = vec3<f32>(v.nrm.x * r * r, v.nrm.z, 0.0);
  }
  o.clip = F.viewProj * vec4<f32>(pos, 1.0);
  o.wpos = pos;
  o.nrm = nrm;
  o.uv = v.uv;
  o.mat = mat;
  o.extra = v.extra;
  o.place = v.extra;
  return o;
}

struct Surface {
  albedo: vec3<f32>,
  emission: vec3<f32>,
  spec: f32,
  gloss: f32,
};

fn simSample(p: vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(scal, linSamp, (p - F.simOrigin) / (F.simDims * F.simH), 0.0);
}

// Running-bond brickwork. Returns (mortar mask, per-brick random value).
fn bricks(uv: vec2<f32>, size: vec2<f32>, joint: f32) -> vec2<f32> {
  let row = floor(uv.y / size.y);
  let shifted = uv.x / size.x + select(0.0, 0.5, (i32(row) & 1) == 1);
  let col = floor(shifted);
  let local = vec2<f32>(fract(shifted) * size.x, uv.y - row * size.y);
  let edge = min(min(local.x, size.x - local.x), min(local.y, size.y - local.y));
  let mortar = 1.0 - smoothstep(joint * 0.5 - 0.0015, joint * 0.5 + 0.0015, edge);
  return vec2<f32>(mortar, hash31(vec3<i32>(i32(col), i32(row), 17)));
}

fn firebrick(p: vec3<f32>, uv: vec2<f32>, N: vec3<f32>) -> Surface {
  let b = bricks(uv, vec2<f32>(0.23, 0.065), 0.006);
  var col = vec3<f32>(0.52, 0.4, 0.29) * (0.75 + 0.5 * b.y) * (0.85 + 0.3 * valueNoise(p * 60.0));
  col = mix(col, vec3<f32>(0.33, 0.31, 0.29), b.x);
  if (N.y > 0.5) {
    // hearth floor inside the firebox: a layer of old ash
    col = mix(col, vec3<f32>(0.3, 0.29, 0.28), 0.55 + 0.4 * fbm(p * 20.0));
  } else {
    // Years of soot: black toward the top, patchy lower down, heaviest above the fire.
    let above = 1.0 - 0.35 * smoothstep(0.15, 0.4, abs(p.x));
    let soot = smoothstep(-0.05, 0.55, p.y) * above + 0.3 * (fbm(p * 7.0) - 0.5) + 0.15;
    col *= mix(1.0, 0.08, clamp(soot, 0.0, 1.0));
  }
  return Surface(col, vec3<f32>(0.0), 0.02, 8.0);
}

fn redBrick(p: vec3<f32>, uv: vec2<f32>) -> Surface {
  let b = bricks(uv, vec2<f32>(0.215, 0.075), 0.01);
  var col = vec3<f32>(0.42, 0.15, 0.09) * (0.7 + 0.6 * b.y) * (0.8 + 0.4 * valueNoise(p * 45.0));
  col = mix(col, vec3<f32>(0.42, 0.4, 0.37), b.x);
  let stain = smoothstep(0.15, 0.0, abs(p.x) - 0.35) * smoothstep(0.62, 0.72, p.y) * smoothstep(1.0, 0.7, p.y);
  col *= mix(1.0, 0.35, stain * (0.6 + 0.4 * fbm(p * 10.0)));
  return Surface(col, vec3<f32>(0.0), 0.03, 10.0);
}

fn hearthStone(p: vec3<f32>, uv: vec2<f32>) -> Surface {
  let tile = uv / 0.3;
  let f = fract(tile);
  let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  let id = hash31(vec3<i32>(vec2<i32>(floor(tile)), 5));
  var col = vec3<f32>(0.13, 0.125, 0.12) * (0.75 + 0.5 * id) * (0.8 + 0.4 * fbm(p * 18.0));
  col *= mix(0.4, 1.0, smoothstep(0.0, 0.015, edge));
  return Surface(col, vec3<f32>(0.0), 0.35, 40.0);
}

fn floorPlanks(p: vec3<f32>) -> Surface {
  let width = 0.12;
  let row = floor(p.z / width);
  let along = p.x + hash31(vec3<i32>(i32(row), 3, 9)) * 2.0;
  let board = floor(along / 1.1);
  let id = hash31(vec3<i32>(i32(row), i32(board), 11));
  let across = fract(p.z / width);
  let endGap = fract(along / 1.1);
  let gap = smoothstep(0.0, 0.025, min(across, 1.0 - across)) * smoothstep(0.0, 0.004, min(endGap, 1.0 - endGap));
  let grain = fbm(vec3<f32>(along * 2.5, p.z * 70.0, id * 13.0));
  var col = vec3<f32>(0.34, 0.19, 0.1) * (0.7 + 0.5 * id) * (0.75 + 0.5 * grain);
  col *= mix(0.3, 1.0, gap);
  return Surface(col, vec3<f32>(0.0), 0.4, 60.0);
}

fn mantelWood(p: vec3<f32>) -> Surface {
  let grain = fbm(vec3<f32>(p.x * 3.0, p.y * 80.0, p.z * 80.0));
  let col = vec3<f32>(0.2, 0.11, 0.06) * (0.7 + 0.6 * grain);
  return Surface(col, vec3<f32>(0.0), 0.25, 30.0);
}

// Wrought iron with patches of rust (uv: along and around the bar, so tools keep their rust
// as they move).
fn iron(uv: vec2<f32>) -> Surface {
  let rust = fbm(vec3<f32>(uv * 80.0, 3.7));
  let col = mix(vec3<f32>(0.03, 0.03, 0.03), vec3<f32>(0.09, 0.05, 0.03), smoothstep(0.5, 0.8, rust));
  return Surface(col, vec3<f32>(0.0), 0.3, 25.0);
}

// Coal bed: chunks of glowing charcoal with hotter seams between them, slowly "breathing",
// a skin of grey ash on the cooler ones, brighter where flames or blowing reach them. Where the
// bed is thin more of it greys over; where there are no coals at all, only old ash shows.
fn embers(p: vec3<f32>) -> Surface {
  let t = F.time;
  let bed = bedAt(p); // T, CO, depth, ash
  let cover = smoothstep(0.003, 0.22, bed.z);
  let amount = clamp(bed.z, 0.0, 1.0);
  let bedAsh = bed.w;
  // Irregular lumps of charcoal, each with its own temperature.
  let chunks = voronoi(p * 55.0 + (fbm(p * 40.0) - 0.5) * 0.8);
  let gap = 1.0 - smoothstep(0.0, 0.13, chunks.y - chunks.x);
  let lump = chunks.z;
  let n = fbm(vec3<f32>(p.x * 22.0, p.z * 22.0, t * 0.02));
  let breathe = fbm(vec3<f32>(p.x * 14.0 + t * 0.07, p.z * 14.0, t * 0.3));
  let gas = simSample(p + vec3<f32>(0.0, F.simH * 2.0, 0.0));
  let heat = smoothstep(600.0, 1300.0, gas.x);

  // Ash skins the cooler lumps (and, left alone, most of them, all but the hottest); the crevices
  // between lumps trap heat and glow, some more than others.
  let hottest = step(0.84, lump);
  let skin = n + 0.25 * (lump - 0.5) + 0.45 * (1.0 - amount) + 0.5 * (1.0 - cover) + 0.6 * bedAsh * (1.0 - gap) - 0.45 * hottest * bedAsh;
  let ash = smoothstep(0.66, 0.9, skin) * 0.95;
  let seam = gap * smoothstep(0.25, 0.65, valueNoise(p * 70.0 + vec3<f32>(0.0, t * 0.05, 0.0)) + 0.3 * (1.0 - bedAsh));
  let T = ((bed.x + F.glowBoost) * (0.84 + 0.12 * lump + 0.16 * breathe) + 100.0 * heat) * mix(1.0, 1.04, seam);
  let coal = mix(vec3<f32>(0.03, 0.028, 0.027), vec3<f32>(0.42, 0.41, 0.39), ash);
  let oldAsh = vec3<f32>(0.36, 0.35, 0.33) * (0.75 + 0.4 * fbm(p * 20.0));
  let lumpy = smoothstep(0.0, 0.25, cover);
  let albedo = mix(oldAsh, coal, lumpy);
  let hot = smoothstep(620.0, 760.0, bed.x);
  // Through a skin of ash the coals still show a dull red; the ash itself, lit by the glow round
  // it, looks pale grey. Unskinned crevices glow brightest.
  let g = glow(T - 60.0 * ash);
  let through = mix(1.0, 0.06, ash) * mix(1.0, 0.55 + 0.45 * seam, bedAsh);
  let glowLevel = dot(g, vec3<f32>(0.2126, 0.7152, 0.0722));
  let ashLit = vec3<f32>(0.66, 0.6, 0.53) * glowLevel * 0.55 * ash;
  return Surface(albedo, (g * through + ashLit) * cover * hot, 0.0, 1.0);
}

// ---- The hacienda ---------------------------------------------------------------------------

// Tilts normal N by the slope of the height field amp * fbm(p * freq): a hand-finished surface.
fn bumped(N: vec3<f32>, p: vec3<f32>, amp: f32, freq: f32) -> vec3<f32> {
  let e = 0.3 / freq;
  let h = fbm(p * freq);
  let g = vec3<f32>(
    fbm((p + vec3<f32>(e, 0.0, 0.0)) * freq),
    fbm((p + vec3<f32>(0.0, e, 0.0)) * freq),
    fbm((p + vec3<f32>(0.0, 0.0, e)) * freq)) - h;
  let grad = g * (amp / e);
  return normalize(N - (grad - N * dot(grad, N)));
}

// How blackened the chimney breast is by smoke curling out over the top of the opening.
fn smokeStain(p: vec3<f32>) -> f32 {
  if (p.z < -0.005 || p.z > 0.05 || abs(p.x) > 0.8) { return 0.0; }
  let top = openingTop(clamp(p.x, -F.opening.x * 0.999, F.opening.x * 0.999));
  let above = p.y - top;
  let spread = smoothstep(0.62, 0.15, abs(p.x) - 0.25 * max(above, 0.0));
  let fresh = smoothstep(-0.03, 0.03, above);
  return clamp(exp(-max(above, 0.0) / 0.2) * spread * fresh * (0.45 + 0.6 * fbm(p * 7.0 + vec3<f32>(0.0, -1.3, 0.0))), 0.0, 1.0);
}

// Hand-troweled lime plaster, whitewashed.
fn plaster(p: vec3<f32>) -> Surface {
  let broad = fbm(p * 4.0);
  let grit = valueNoise(p * 160.0);
  var col = vec3<f32>(0.86, 0.81, 0.71) * (0.86 + 0.16 * broad + 0.05 * grit);
  col *= 1.0 - 0.8 * smokeStain(p);
  return Surface(col, vec3<f32>(0.0), 0.02, 6.0);
}

// The band of ochre-red paint along the bottom of the walls, scuffed here and there.
fn dado(p: vec3<f32>) -> Surface {
  var col = vec3<f32>(0.52, 0.2, 0.11) * (0.85 + 0.2 * fbm(p * 5.0));
  let worn = smoothstep(0.68, 0.82, fbm(p * 13.0 + 4.0));
  col = mix(col, vec3<f32>(0.8, 0.74, 0.64), worn * 0.5);
  return Surface(col, vec3<f32>(0.0), 0.03, 8.0);
}

// Inside the firebox: adobe, clay plaster laid on by hand and fired hard by years of fires. The
// clay is ochre, reddened low down where the fire has baked it; fine cracks run through it where
// it shrank; soot blackens it from the top down, most at the back and over the fire, in streaks
// where the smoke rolls up, glazed here and there with glossy black creosote. Old ash on the floor.
// (Its relief, the sweep of the trowel, is in the normal: see fs.)
fn adobe(p: vec3<f32>, N: vec3<f32>) -> Surface {
  let broad = fbm(p * 5.0);
  let fine = fbm(p * 38.0);
  let baked = smoothstep(0.38, 0.04, p.y) * smoothstep(0.45, 0.1, abs(p.x));
  var col = mix(vec3<f32>(0.52, 0.41, 0.3), vec3<f32>(0.55, 0.3, 0.18), baked) * (0.8 + 0.3 * broad) * (0.9 + 0.2 * fine);
  // (Hairline cracks: only here and there, where the plaster shrank most.)
  let cells = voronoi(p * 9.0 + (fbm(p * 5.0) - 0.5) * 1.2);
  let cracked = smoothstep(0.55, 0.7, fbm(p * 3.0 + 7.0));
  col *= 1.0 - 0.32 * cracked * (1.0 - smoothstep(0.0, 0.02, cells.y - cells.x));
  var glaze = 0.0;
  if (N.y > 0.6) {
    col = mix(col, vec3<f32>(0.3, 0.29, 0.28) * (0.8 + 0.4 * fine), 0.6 + 0.35 * fbm(p * 20.0));
  } else {
    let streaks = fbm(vec3<f32>(p.x * 16.0, p.y * 2.5, p.z * 16.0));
    let soot = smoothstep(-0.05, 0.55, p.y) + 0.3 * (streaks - 0.5) + 0.3 * smoothstep(-0.12, -0.38, p.z) + 0.2 * smoothstep(0.3, 0.0, abs(p.x)) - 0.12;
    col *= mix(1.0, 0.06, clamp(soot, 0.0, 1.0));
    glaze = smoothstep(0.58, 0.74, fbm(p * 7.0 + 3.0)) * smoothstep(0.25, 0.55, p.y);
  }
  return Surface(col, vec3<f32>(0.0), mix(0.02, 0.3, glaze), mix(6.0, 45.0, glaze));
}

// Hand-painted Talavera tiles: cobalt and yellow on a white tin glaze. Neighbouring tiles
// alternate between a rosette and a star; quarter circles in the corners join up into rings.
fn talavera(uv: vec2<f32>, p: vec3<f32>) -> Surface {
  let g = uv / TALAVERA_TILE;
  let cell = floor(g);
  let f = fract(g) - 0.5;
  let id = hash31(vec3<i32>(vec2<i32>(cell), 13));
  let wobble = (valueNoise(vec3<f32>(uv * 90.0, 2.0)) - 0.5) * 0.035; // painted by hand
  let edge = 0.5 - max(abs(f.x), abs(f.y));
  let grout = 1.0 - smoothstep(0.012, 0.028, edge);
  let r = length(f);
  let a = atan2(f.y, f.x);
  let rosette = (i32(cell.x + cell.y) & 1) == 0;
  var petal = 0.17 + 0.09 * abs(cos(4.0 * a));
  if (!rosette) {
    petal = 0.09 + 0.2 * pow(abs(cos(2.0 * a)), 12.0) + 0.2 * pow(abs(sin(2.0 * a)), 12.0);
  }
  let flower = smoothstep(0.012, -0.004, r - petal + wobble);
  let outline = smoothstep(0.012, 0.003, abs(r - petal + wobble) - 0.004);
  let eye = smoothstep(0.01, -0.004, r - 0.05 + wobble);
  let rc = length(abs(f) - vec2<f32>(0.5)); // distance to the nearest corner
  let corner = smoothstep(0.01, -0.004, rc - 0.19 + wobble);
  let ring = smoothstep(0.012, 0.003, abs(rc - 0.19 + wobble) - 0.012);
  let border = smoothstep(0.01, 0.002, abs(edge - 0.055 + wobble * 0.5) - 0.006);

  let glaze = vec3<f32>(0.9, 0.87, 0.78);
  let cobalt = vec3<f32>(0.05, 0.11, 0.45);
  let yellow = vec3<f32>(0.88, 0.58, 0.1);
  var col = glaze;
  col = mix(col, yellow, corner);
  col = mix(col, cobalt, ring);
  col = mix(col, select(yellow, cobalt, rosette), flower);
  col = mix(col, cobalt, outline * select(1.0, 0.0, rosette));
  col = mix(col, select(cobalt, yellow, rosette), eye);
  col = mix(col, cobalt, border * (1.0 - corner) * (1.0 - ring));
  col *= 0.93 + 0.1 * id;
  col = mix(col, vec3<f32>(0.5, 0.47, 0.42), grout);
  col *= 1.0 - 0.7 * smokeStain(p);
  return Surface(col, vec3<f32>(0.0), mix(0.55, 0.05, grout), 90.0);
}

// Saltillo tiles: handmade terracotta, each its own shade, mottled and sealed to a soft sheen.
fn terracotta(uv: vec2<f32>) -> Surface {
  let size = 0.3;
  let g = uv / size;
  let cell = floor(g);
  let f = fract(g);
  let id = hash31(vec3<i32>(vec2<i32>(cell), 21));
  let wob = (valueNoise(vec3<f32>(uv * 40.0, 5.0)) - 0.5) * 0.006;
  let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)) * size + wob;
  let grout = 1.0 - smoothstep(0.004, 0.008, edge);
  var col = vec3<f32>(0.56, 0.26, 0.13) * (0.78 + 0.4 * id);
  col *= 0.8 + 0.35 * fbm(vec3<f32>(uv * 8.0, id * 9.0));
  col = mix(col, col * vec3<f32>(0.6, 0.5, 0.45), smoothstep(0.55, 0.85, fbm(vec3<f32>(uv * 3.5, id * 5.0))) * 0.6);
  col = mix(col, vec3<f32>(0.4, 0.36, 0.31), grout);
  return Surface(col, vec3<f32>(0.0), mix(0.25, 0.02, grout), 30.0);
}

// A hand-hewn beam: dark, grain along it, adze marks across it, drying cracks.
fn beam(p: vec3<f32>) -> Surface {
  let grain = fbm(vec3<f32>(p.x * 1.5, p.y * 60.0, p.z * 60.0));
  let adze = smoothstep(0.15, 0.95, fract(p.x * 8.0 + (fbm(p * 10.0) - 0.5) * 1.2));
  var col = vec3<f32>(0.27, 0.16, 0.09) * (0.6 + 0.55 * grain) * (0.82 + 0.25 * adze);
  let crack = smoothstep(0.035, 0.0, abs(fbm(vec3<f32>(p.x * 2.0, p.y * 22.0, p.z * 22.0)) - 0.5));
  col *= 1.0 - 0.7 * crack * step(0.6, fbm(p * 3.0));
  return Surface(col, vec3<f32>(0.0), 0.1, 16.0);
}

// Burnished terracotta pottery with painted bands (uv.y: height up the pot).
fn pottery(uv: vec2<f32>, p: vec3<f32>) -> Surface {
  var col = vec3<f32>(0.6, 0.3, 0.16) * (0.82 + 0.25 * fbm(p * 30.0));
  let h = uv.y;
  let band = smoothstep(0.004, 0.0, abs(h - 0.24) - 0.012) + smoothstep(0.003, 0.0, abs(h - 0.075) - 0.006);
  let wave = smoothstep(0.004, 0.0, abs(h - 0.2 - 0.012 * sin(uv.x * 6.2832 * 14.0)) - 0.003);
  col = mix(col, vec3<f32>(0.13, 0.07, 0.05), clamp(band, 0.0, 1.0));
  col = mix(col, vec3<f32>(0.86, 0.78, 0.62), wave);
  return Surface(col, vec3<f32>(0.0), 0.35, 28.0);
}

// Bark (uv: along, around, in m), in the wood's own colour (extra; else a grey-brown): deeply
// furrowed, or for pale papery bark like birch's, smooth with dark marks running round it.
// Here and there a piece of it has come away, showing the wood beneath.
fn bark(uv: vec2<f32>, tint: vec3<f32>) -> Surface {
  let own = dot(tint, vec3<f32>(1.0)) > 0.0;
  let colour = select(vec3<f32>(0.25, 0.21, 0.17), tint * 1.1, own);
  let ridge = fbm(vec3<f32>(uv.x * 7.0, uv.y * 60.0, 3.1) + (fbm(vec3<f32>(uv * 25.0, 1.7)) - 0.5) * 1.2);
  let furrow = smoothstep(0.35, 0.62, ridge);
  let base = colour * (0.7 + 0.5 * fbm(vec3<f32>(uv * 45.0, 9.0)));
  var col = mix(base * 0.28, base, furrow);
  let pale = smoothstep(0.4, 0.55, colour.g);
  let marks = smoothstep(0.72, 0.88, fbm(vec3<f32>(uv.x * 90.0, uv.y * 7.0, 4.0)));
  col = mix(col, base * (1.0 - 0.85 * marks), pale);
  if (own) {
    let gone = smoothstep(0.7, 0.76, fbm(vec3<f32>(uv.x * 9.0, uv.y * 14.0, tint.r * 40.0)));
    col = mix(col, vec3<f32>(0.5, 0.4, 0.28) * (0.8 + 0.3 * fbm(vec3<f32>(uv.x * 5.0, uv.y * 120.0, 2.0))), gone);
  }
  return Surface(col, vec3<f32>(0.0), 0.03, 8.0);
}

// The colour of cut wood: pale sapwood, heartwood darker and redder in some woods than others
// (tone 0..1), heart 0..1 how far into the heartwood.
fn woodColour(tone: f32, heart: f32) -> vec3<f32> {
  let sap = mix(vec3<f32>(0.8, 0.68, 0.5), vec3<f32>(0.66, 0.5, 0.34), tone * 0.6);
  let core = mix(vec3<f32>(0.74, 0.62, 0.45), vec3<f32>(0.33, 0.17, 0.09), tone);
  return mix(sap, core, heart);
}

// The sawn end of a log (uv: distance from the pith (m), angle round it; extra: the log's
// radius, how dark its heartwood is, a seed): growth rings a few millimetres apart with darker
// latewood, heartwood, drying cracks running in from the bark, faint saw marks, the bark round
// its edge.
fn endGrain(uv: vec2<f32>, extra: vec3<f32>) -> Surface {
  let R = max(extra.x, 0.01);
  let r = uv.x;
  let rel = r / R;
  let dir = vec2<f32>(cos(uv.y), sin(uv.y));
  let c = dir * r;
  let wob = (fbm(vec3<f32>(c * 25.0, extra.z)) - 0.5) * 0.005;
  let ring = fract((r + wob) / 0.0032);
  let late = smoothstep(0.62, 0.95, ring);
  let heart = smoothstep(0.8, 0.6, rel + (fbm(vec3<f32>(dir * 3.0, extra.z + 1.0)) - 0.5) * 0.1);
  var col = woodColour(extra.y, heart) * (1.0 - 0.25 * late) * (0.9 + 0.15 * fbm(vec3<f32>(c * 60.0, extra.z)));
  // Checks: the wood shrinks as it dries and splits in from the bark.
  let a = valueNoise(vec3<f32>(dir * 5.0, extra.z * 1.7));
  let check = smoothstep(0.012, 0.0, abs(a - 0.5) - 0.003 * rel) * smoothstep(0.25, 0.75, rel);
  col *= 1.0 - 0.75 * check;
  let saw = 0.5 + 0.5 * sin(dot(c, vec2<f32>(0.8, 0.6)) * 800.0 + fbm(vec3<f32>(c * 40.0, 2.0)) * 3.0);
  col *= 0.93 + 0.07 * saw;
  col *= mix(0.55, 1.0, smoothstep(0.0015, 0.004, r));
  col = mix(col, vec3<f32>(0.13, 0.1, 0.08) * (0.8 + 0.4 * fbm(vec3<f32>(c * 90.0, 3.0))), smoothstep(0.9, 0.95, rel));
  return Surface(col, vec3<f32>(0.0), 0.03, 8.0);
}

// A split face (uv: along the log, out from the pith (m); extra as for endGrain): long fibres
// along the grain, torn here and there, heartwood toward the pith, greyed where it has weathered.
fn splitWood(uv: vec2<f32>, extra: vec3<f32>, p: vec3<f32>) -> Surface {
  let R = max(extra.x, 0.01);
  let heart = smoothstep(0.8, 0.6, uv.y / R);
  var col = woodColour(extra.y, heart);
  let fibre = fbm(vec3<f32>(uv.x * 5.0, uv.y * 260.0, extra.z));
  let streak = fbm(vec3<f32>(uv.x * 1.2, uv.y * 70.0, extra.z + 3.0));
  let torn = smoothstep(0.66, 0.74, fbm(vec3<f32>(uv.x * 14.0, uv.y * 140.0, extra.z + 5.0)));
  col *= (0.7 + 0.42 * fibre) * (0.85 + 0.25 * streak) * (1.0 - 0.35 * torn);
  let rings = 0.5 + 0.5 * sin(uv.y * 1900.0 + (fbm(vec3<f32>(uv.x * 3.0, uv.y * 40.0, extra.z)) - 0.5) * 8.0);
  col *= 0.9 + 0.12 * rings;
  col = mix(col, vec3<f32>(0.45, 0.43, 0.4) * (0.8 + 0.3 * fibre), 0.3 * smoothstep(0.55, 0.8, fbm(p * 7.0)));
  return Surface(col, vec3<f32>(0.0), 0.04, 10.0);
}

// Desert deadwood: the bark long gone, the wood bleached grey by the sun and split along the
// grain (uv: along, around, in m).
fn driftwood(uv: vec2<f32>, p: vec3<f32>) -> Surface {
  let grain = fbm(vec3<f32>(uv.x * 7.0, uv.y * 110.0, 2.3));
  var col = vec3<f32>(0.6, 0.56, 0.5) * (0.72 + 0.38 * grain);
  let crack = smoothstep(0.035, 0.0, abs(fbm(vec3<f32>(uv.x * 2.5, uv.y * 45.0, 7.1)) - 0.5));
  col *= 1.0 - 0.65 * crack;
  col = mix(col, vec3<f32>(0.38, 0.29, 0.21), 0.35 * smoothstep(0.5, 0.8, fbm(p * 18.0)));
  return Surface(col, vec3<f32>(0.0), 0.05, 10.0);
}

// How strongly the candles near p light up wax or glass around them.
fn candleGlow(p: vec3<f32>, reach: f32) -> vec3<f32> {
  var lit = vec3<f32>(0.0);
  for (var i = 0u; i < 4u; i++) {
    let c = F.candles[i];
    if (c.w <= 0.0) { continue; }
    lit += blackbody(CANDLE_TEMP) * c.w * 900.0 * exp(-length(p - c.xyz) / reach);
  }
  return lit;
}

// Beeswax, glowing through near the flame.
fn wax(p: vec3<f32>) -> Surface {
  return Surface(vec3<f32>(0.88, 0.76, 0.5), candleGlow(p, 0.01), 0.25, 20.0);
}

// A candle flame: a bright core above a faint blue base, yellower toward the tip.
fn candleFlame(uv: vec2<f32>) -> Surface {
  let across = abs(uv.x);
  let up = uv.y;
  let core = (1.0 - across * across) * smoothstep(1.0, 0.25, up);
  let T = 1500.0 + 520.0 * core;
  let blue = smoothstep(0.28, 0.0, up) * (1.0 - across);
  let edge = smoothstep(1.0, 0.6, across);
  let e = (glow(T) * (1.2 + 2.5 * core) * (1.0 - 0.8 * blue) + vec3<f32>(0.04, 0.08, 0.35) * blue) * edge;
  return Surface(vec3<f32>(0.0), e, 0.0, 1.0);
}

// ---- The campsite ---------------------------------------------------------------------------

// The Milky Way, where it really is: a band along the galactic plane (d turned into galactic
// coordinates), broad and bright round the centre in Sagittarius, faint and narrow toward
// Auriga, mottled with star clouds, and split by the dark lanes of the Great Rift from Cygnus
// down to Sagittarius.
fn milkyWay(d: vec3<f32>) -> vec3<f32> {
  let g = vec3<f32>(dot(F.worldToGalaxy[0].xyz, d), dot(F.worldToGalaxy[1].xyz, d), dot(F.worldToGalaxy[2].xyz, d));
  let b = asin(clamp(g.z, -1.0, 1.0));
  let l = atan2(g.y, g.x);
  let centre = 0.5 + 0.5 * cos(l);
  let width = 0.075 + 0.09 * centre * centre;
  let disc = exp(-b * b / (2.0 * width * width)) * (0.22 + 0.78 * centre);
  let bulge = exp(-(l * l + 2.5 * b * b) / (2.0 * 0.19 * 0.19));
  let clouds = 0.35 + 1.3 * fbm(g * 16.0) * (0.5 + 0.5 * fbm(g * 5.0 + 2.0));
  let riftAlong = smoothstep(-0.3, -0.05, l) * smoothstep(1.5, 1.2, l);
  let rift = exp(-pow((b - 0.03 - 0.02 * sin(l * 5.0)) / 0.028, 2.0)) * riftAlong * (0.5 + 0.7 * fbm(g * 25.0));
  let lanes = smoothstep(0.55, 0.8, fbm(g * 10.0 + 5.0)) * exp(-b * b / 0.006);
  let dust = clamp(1.0 - 0.9 * rift - 0.35 * lanes, 0.08, 1.0);
  let light = (disc * clouds + 1.4 * bulge) * dust;
  return mix(vec3<f32>(0.85, 0.88, 1.0), vec3<f32>(1.0, 0.88, 0.72), clamp(bulge * 2.0, 0.0, 1.0)) * light * 0.011;
}

// The Moon's near side: darker maria (latitude, longitude, radius in degrees), brighter highlands,
// and the rayed crater Tycho.
fn moonAlbedo(lat: f32, lon: f32) -> f32 {
  var maria = array<vec3<f32>, 16>(
    vec3<f32>(33.0, -16.0, 16.0), vec3<f32>(28.0, 17.0, 9.0), vec3<f32>(8.5, 31.0, 11.0), vec3<f32>(17.0, 59.0, 8.0),
    vec3<f32>(-8.0, 51.0, 9.0), vec3<f32>(-15.0, 35.0, 5.5), vec3<f32>(-21.0, -17.0, 10.0), vec3<f32>(-24.0, -39.0, 6.0),
    vec3<f32>(13.0, 4.0, 4.0), vec3<f32>(7.0, -31.0, 7.0), vec3<f32>(-10.0, -23.0, 5.0), vec3<f32>(20.0, -55.0, 16.0),
    vec3<f32>(5.0, -60.0, 13.0), vec3<f32>(38.0, -48.0, 10.0), vec3<f32>(56.0, -20.0, 6.0), vec3<f32>(56.0, 15.0, 6.0));
  var dark = 0.0;
  for (var i = 0; i < 16; i++) {
    let m = maria[i];
    let dLon = (lon - m.y) * cos(radians(lat));
    let dist = length(vec2<f32>(lat - m.x, dLon));
    dark = max(dark, smoothstep(m.z * 1.15, m.z * 0.6, dist + 3.0 * (valueNoise(vec3<f32>(lat * 0.2, lon * 0.2, 3.0)) - 0.5)));
  }
  let tycho = length(vec2<f32>(lat + 43.0, (lon + 11.0) * cos(radians(lat))));
  let rays = smoothstep(0.8, 1.0, valueNoise(vec3<f32>(atan2(lat + 43.0, lon + 11.0) * 6.0, 0.0, 1.0))) * smoothstep(40.0, 5.0, tycho);
  return mix(1.0, 0.52, dark) * (0.92 + 0.12 * valueNoise(vec3<f32>(lat * 0.5, lon * 0.5, 7.0))) + 0.5 * smoothstep(2.5, 1.0, tycho) + 0.15 * rays;
}

// The Moon: a disc in its true phase, north up toward the celestial pole, maria and all, and the
// faint earthshine on its dark side; a glow round it.
fn moonDisc(d: vec3<f32>) -> vec3<f32> {
  let m = F.moon.xyz;
  let r = F.moonSun.w;
  let c = dot(d, m);
  let halo = vec3<f32>(0.012, 0.013, 0.016) * pow(F.moon.w, 2.0) * exp(-acos(clamp(c, -1.0, 1.0)) / 0.04);
  if (c < cos(r)) { return halo; }
  let pole = normalize(vec3<f32>(F.starsToWorld[0].z, F.starsToWorld[1].z, F.starsToWorld[2].z));
  let east = normalize(cross(pole, m));
  let north = cross(m, east);
  // (Selenographic east, toward Mare Crisium, is toward the sky's west.)
  let q = vec2<f32>(dot(d, -east), dot(d, north)) / sin(r);
  let z = sqrt(max(1.0 - dot(q, q), 0.0));
  let n = -east * q.x + north * q.y - m * z;
  let lit = dot(n, F.moonSun.xyz);
  let shade = smoothstep(-0.03, 0.12, lit) * (0.65 + 0.35 * sqrt(max(lit, 0.0)));
  let albedo = moonAlbedo(degrees(asin(clamp(q.y, -1.0, 1.0))), degrees(atan2(q.x, max(z, 1e-3))));
  let earthshine = 0.012 * (1.0 - F.moon.w);
  let edge = smoothstep(1.0, 0.97, length(q));
  return (vec3<f32>(1.0, 0.97, 0.9) * 1.8 * albedo * (shade + earthshine)) * edge + halo;
}

// The sky's own light in direction d, without the Moon's disc or the Milky Way: a dark night sky,
// brighter and bluer by moonlight; the last light low where the Sun has set at dusk; blue by day.
// (It is also what far-off hills and mountains fade toward.)
fn skyGradient(d: vec3<f32>) -> vec3<f32> {
  let up = max(d.y, 0.0);
  let tod = F.sun.w;
  let sunDir = F.sunDir.xyz;
  var col: vec3<f32>;
  if (tod < 0.5) {
    col = mix(vec3<f32>(0.0016, 0.0022, 0.0042), vec3<f32>(0.0005, 0.0008, 0.0019), pow(up, 0.5));
    // Airglow: a faint green-grey band low down on a dark night.
    col += vec3<f32>(0.0004, 0.0007, 0.0004) * smoothstep(0.3, 0.0, up) * (1.0 - F.skyLook.z);
  } else if (tod < 1.5) {
    let toward = pow(max(dot(normalize(vec3<f32>(d.x, 0.0, d.z)), normalize(vec3<f32>(sunDir.x, 0.0, sunDir.z) + vec3<f32>(1e-5, 0.0, 0.0))), 0.0), 3.0);
    let horizon = mix(vec3<f32>(0.012, 0.014, 0.028), vec3<f32>(0.06, 0.028, 0.012), toward);
    col = mix(horizon, vec3<f32>(0.004, 0.008, 0.026), pow(up, 0.45));
  } else {
    col = mix(vec3<f32>(0.26, 0.3, 0.34), vec3<f32>(0.07, 0.13, 0.3), pow(up, 0.6));
    col += vec3<f32>(1.0, 0.9, 0.7) * 0.4 * pow(max(dot(d, sunDir), 0.0), 64.0);
  }
  // By moonlight the whole sky is lighter and bluer, most of all round the Moon. (Less so with
  // the starlight brought out: a deeper sky for the stars to show against.)
  let glow = F.skyLook.z * (1.0 - 0.3 * F.grade.y);
  col += glow * (vec3<f32>(0.0035, 0.0055, 0.011) * (0.7 + 0.3 * up) + vec3<f32>(0.005, 0.007, 0.011) * pow(max(dot(d, F.moon.xyz), 0.0), 6.0));
  return col;
}

// The sky seen through the dome, with the Milky Way and the Moon (the stars are drawn over it:
// stars.wgsl). The Sun, Moon and Milky Way are where they really are.
fn sky(d: vec3<f32>) -> vec3<f32> {
  var col = skyGradient(d);
  if (F.skyLook.y > 0.0) {
    col += milkyWay(d) * F.skyLook.y * (1.0 + 0.8 * F.grade.y) * smoothstep(-0.02, 0.2, d.y);
  }
  if (F.moon.w >= 0.0) {
    col += moonDisc(d) * smoothstep(-0.01, 0.01, d.y);
  }
  return col;
}

// A mountain meadow: trampled earth and ash round the fire, then late-summer grass, heather and
// the odd flower, the needles and duff under the trees at its edge; far off, the forest on the
// hills, seen from above: a dark mottle of treetops.
fn ground(p: vec3<f32>) -> Surface {
  let r = length(p.xz);
  let n = fbm(p * 3.0);
  let fine = fbm(p * 40.0);
  // Grass, green going gold, in tussocks; heather in patches.
  var col = mix(vec3<f32>(0.16, 0.18, 0.07), vec3<f32>(0.3, 0.27, 0.12), smoothstep(0.35, 0.7, fbm(p * 0.9 + 4.0))) * (0.75 + 0.5 * fine);
  col = mix(col, vec3<f32>(0.2, 0.12, 0.13) * (0.8 + 0.4 * fine), smoothstep(0.62, 0.75, fbm(p * 1.7 + 13.0)) * 0.7);
  let flower = step(0.985, valueNoise(p * 70.0)) * smoothstep(3.0, 6.0, r) * (1.0 - smoothstep(22.0, 28.0, r));
  col = mix(col, select(vec3<f32>(0.35, 0.28, 0.6), vec3<f32>(0.7, 0.14, 0.08), valueNoise(p * 9.0) > 0.5), flower);
  // Trampled earth round the fire, ash and charcoal in and round the pit.
  let bare = smoothstep(2.6, 1.2, r + 0.5 * (n - 0.5));
  col = mix(col, vec3<f32>(0.2, 0.15, 0.1) * (0.75 + 0.5 * fine), bare);
  let ash = smoothstep(0.45, 0.2, r + 0.08 * (n - 0.5));
  col = mix(col, vec3<f32>(0.31, 0.3, 0.28) * (0.7 + 0.5 * fine), ash);
  col *= mix(1.0, 0.25, smoothstep(0.75, 0.9, fbm(p * 30.0 + 11.0)) * ash);
  // Under the trees and beyond: needles and duff, then the forest's canopy seen from afar.
  col = mix(col, vec3<f32>(0.12, 0.08, 0.05) * (0.7 + 0.5 * fine), smoothstep(30.0, 38.0, r) * 0.8);
  let crowns = voronoi(p * 0.45);
  let canopy = vec3<f32>(0.03, 0.045, 0.03) * (0.5 + 0.9 * (1.0 - crowns.x)) * (0.8 + 0.4 * fbm(p * 0.2));
  col = mix(col, canopy, smoothstep(55.0, 70.0, r));
  return Surface(col, vec3<f32>(0.0), 0.02, 4.0);
}

// Mount Rainier, far off. Snowfields and glaciers cover it but for the crests of its ridges (the
// cleavers), Little Tahoma and whatever is too steep to hold snow, which show as dark rock. Up top
// the snow is fresh and bright; lower down the glaciers in the troughs are grey old ice, streaked
// along their flow and banded by crevasses, reaching down past the rock and the meadows to the
// dark forest on its lower slopes. After sunset its snow still holds a little of the afterglow.
// (uv.x: height up the mountain, 0..1; uv.y: how much it is on a ridge, 0 in a trough, 1 on a crest.)
fn mountain(uv: vec2<f32>, p: vec3<f32>, N: vec3<f32>) -> Surface {
  let h = uv.x;
  let ridge = uv.y;
  let steep = 1.0 - N.y;
  let broad = fbm(p * 0.25);
  let fine = fbm(p * 1.7);
  let snowline = 0.36 + 0.1 * (broad - 0.5) - 0.1 * (1.0 - ridge);
  var snow = smoothstep(snowline - 0.02, snowline + 0.06, h);
  snow *= 1.0 - smoothstep(0.2, 0.34, steep + 0.2 * (fine - 0.5));
  // Rock along the ridges: broad bands between the glaciers low down, narrower ribs higher up,
  // none on the summit dome; ragged at the edges.
  let bare = mix(0.56, 0.76, smoothstep(0.35, 0.82, h)) + 0.2 * (broad - 0.5) + 0.12 * (fbm(p * 0.7) - 0.5) + 0.06 * (fine - 0.5);
  snow *= 1.0 - smoothstep(bare - 0.03, bare + 0.03, ridge) * smoothstep(0.93, 0.8, h);
  let glacier = smoothstep(0.7, 0.4, h) * smoothstep(0.75, 0.35, ridge);
  let crevasses = smoothstep(0.6, 0.8, valueNoise(vec3<f32>(p.x * 1.1, h * 60.0, p.z * 1.1)));
  var ice = mix(vec3<f32>(0.8, 0.83, 0.88), vec3<f32>(0.5, 0.53, 0.56), glacier * 0.75) * (0.9 + 0.12 * fine);
  ice *= 1.0 - 0.3 * crevasses * glacier;
  let rock = mix(vec3<f32>(0.08, 0.075, 0.075), vec3<f32>(0.19, 0.15, 0.12), smoothstep(0.35, 0.75, fine));
  let meadow = vec3<f32>(0.09, 0.09, 0.05) * (0.8 + 0.4 * fine);
  let forest = vec3<f32>(0.025, 0.038, 0.028) * (0.7 + 0.5 * fbm(p * 0.9));
  var col = mix(forest, meadow, smoothstep(0.2, 0.26, h + 0.04 * (broad - 0.5)));
  col = mix(col, rock, smoothstep(0.26, 0.34, h + 0.04 * (broad - 0.5)));
  col = mix(col, ice, snow);
  let afterglow = select(0.0, 1.0, F.sun.w > 0.5 && F.sun.w < 1.5) * snow;
  return Surface(col, vec3<f32>(0.022, 0.009, 0.012) * afterglow, 0.05 * snow, 8.0);
}

// Coarse, shaggy hair, near black with a reddish-brown cast, hanging in locks (Bigfoot's).
fn hair(p: vec3<f32>) -> Surface {
  let locks = fbm(vec3<f32>(p.x * 45.0, p.y * 9.0, p.z * 45.0));
  let col = mix(vec3<f32>(0.045, 0.035, 0.03), vec3<f32>(0.13, 0.075, 0.045), locks) * (0.8 + 0.4 * fbm(p * 160.0));
  return Surface(col, vec3<f32>(0.0), 0.05, 5.0);
}

// Field stones: grey granite, speckled, lichen on their tops, blackened on the side that
// faces the fire.
fn stone(p: vec3<f32>, N: vec3<f32>) -> Surface {
  let speck = valueNoise(p * 400.0);
  var col = vec3<f32>(0.36, 0.35, 0.33) * (0.75 + 0.35 * fbm(p * 25.0)) * (0.85 + 0.3 * speck);
  let lichen = smoothstep(0.62, 0.75, fbm(p * 18.0 + 5.0)) * smoothstep(0.2, 0.8, N.y);
  col = mix(col, vec3<f32>(0.42, 0.44, 0.3), lichen * 0.7);
  let toFire = normalize(vec3<f32>(-p.x, 0.0, -p.z));
  let soot = smoothstep(0.2, 0.9, dot(N, toFire)) * smoothstep(0.5, 0.3, length(p.xz)) * smoothstep(0.12, 0.02, p.y);
  col *= 1.0 - 0.7 * clamp(soot * (0.6 + 0.6 * fbm(p * 12.0)), 0.0, 1.0);
  return Surface(col, vec3<f32>(0.0), 0.08, 12.0);
}

// A pine's needles, in clumps: dark green, fine-grained, the new growth at the tips lighter.
fn needles(p: vec3<f32>) -> Surface {
  let fine = valueNoise(p * 110.0);
  var col = vec3<f32>(0.055, 0.085, 0.045) * (0.55 + 0.8 * fbm(p * 5.0)) * (0.7 + 0.55 * fine);
  col = mix(col, vec3<f32>(0.1, 0.13, 0.05), smoothstep(0.62, 0.85, fine) * 0.45);
  return Surface(col, vec3<f32>(0.0), 0.03, 6.0);
}

// ---- The desert -------------------------------------------------------------------------

// Sand: the Sahara's orange, fine-grained, paler on the crests; round the fire trampled, grey with
// ash and flecked with charcoal.
fn sand(p: vec3<f32>) -> Surface {
  let r = length(p.xz);
  var col = vec3<f32>(0.66, 0.37, 0.2) * (0.86 + 0.16 * fbm(p * 1.3)) * (0.9 + 0.12 * valueNoise(p * 500.0));
  col = mix(col, col * 1.12, smoothstep(0.5, 3.0, p.y) * 0.5);
  let ash = smoothstep(0.46, 0.2, r + 0.07 * (fbm(p * 8.0) - 0.5));
  col = mix(col, vec3<f32>(0.3, 0.29, 0.28) * (0.7 + 0.5 * fbm(p * 30.0)), ash);
  col *= 1.0 - 0.75 * smoothstep(0.75, 0.9, fbm(p * 35.0 + 11.0)) * ash;
  let trodden = smoothstep(1.8, 0.8, r) * (1.0 - ash);
  col *= 1.0 - 0.12 * trodden * fbm(p * 12.0);
  return Surface(col, vec3<f32>(0.0), 0.02, 6.0);
}

// Wind ripples in the sand: low ridges a hand apart, across the wind, tilting the normal.
fn ripples(N: vec3<f32>, p: vec3<f32>) -> vec3<f32> {
  let r = length(p.xz);
  let k = 2.0 * PI / 0.085;
  let phase = dot(p.xz, normalize(vec2<f32>(0.94, 0.33))) * k + 4.0 * fbm(p * 1.5);
  // (fainter far off, where they would shimmer, and patchy: the wind scours some places smooth)
  let patchy = smoothstep(0.3, 0.7, fbm(p * 0.35 + 9.0));
  let slope = cos(phase) * 0.16 * smoothstep(1.2, 3.0, r) * (1.0 - smoothstep(12.0, 30.0, distance(p, F.camPos))) * patchy;
  let across = normalize(vec3<f32>(0.94, 0.0, 0.33));
  return normalize(N - across * slope);
}

// The tent's cloth: goat hair, black and dark brown, coarsely woven in long strips sewn side by
// side (uv: along the strips, and across them, in m). Each strip is a little different; some have
// a stripe of undyed wool woven in near an edge; the seams between them stand out.
fn tentCloth(uv: vec2<f32>, p: vec3<f32>) -> Surface {
  let s = uv.y / 0.62;
  let id = hash31(vec3<i32>(i32(floor(s)), 5, 11));
  let f = fract(s);
  let weave = 0.78 + 0.34 * valueNoise(vec3<f32>(uv.x * 260.0, uv.y * 60.0, 1.0));
  var col = mix(vec3<f32>(0.045, 0.04, 0.036), vec3<f32>(0.085, 0.06, 0.042), id) * weave * (0.85 + 0.3 * fbm(p * 3.0));
  let pale = step(0.62, id) * smoothstep(0.02, 0.0, abs(f - 0.13) - 0.012);
  col = mix(col, vec3<f32>(0.36, 0.31, 0.24) * weave, pale * 0.85);
  col *= mix(1.0, 0.5, smoothstep(0.035, 0.0, min(f, 1.0 - f)));
  return Surface(col, vec3<f32>(0.0), 0.03, 4.0);
}

// A kettle that lives in the fire: bare metal above, blackened with soot from the bottom up
// (uv.y: height up it).
fn kettleMetal(uv: vec2<f32>, p: vec3<f32>) -> Surface {
  let soot = smoothstep(0.1, 0.02, uv.y + 0.03 * (fbm(p * 40.0) - 0.5));
  var col = mix(vec3<f32>(0.34, 0.33, 0.31), vec3<f32>(0.02, 0.018, 0.016), soot) * (0.85 + 0.25 * fbm(p * 80.0));
  return Surface(col, vec3<f32>(0.0), mix(0.55, 0.05, soot), mix(50.0, 4.0, soot));
}

// A little glass of tea: dark amber through the glass, a glint on it.
fn teaGlass() -> Surface {
  return Surface(vec3<f32>(0.2, 0.07, 0.02), vec3<f32>(0.0), 0.8, 120.0);
}

// ---- Lamps, firelighters, the match -------------------------------------------------------

// A pleated fabric lampshade, glowing warm when the lamp is on (uv.y: around the shade).
fn lampShade(uv: vec2<f32>) -> Surface {
  let pleat = 0.85 + 0.15 * sin(uv.y * 520.0);
  let glowing = F.lamps[1].rgb * F.lamps[1].w * pleat;
  return Surface(vec3<f32>(0.78, 0.7, 0.56) * pleat, glowing, 0.02, 4.0);
}

// Lantern glass: dark and glossy when out, glowing when lit.
fn lanternGlass() -> Surface {
  return Surface(vec3<f32>(0.02), F.lamps[1].rgb * F.lamps[1].w * 1.6, 0.6, 120.0);
}

// A glass jar round a tea light: lit from inside.
fn jar(p: vec3<f32>) -> Surface {
  return Surface(vec3<f32>(0.04, 0.05, 0.05), candleGlow(p, 0.03) * 0.15, 0.6, 120.0);
}

// A firelighter cube: waxy white fibre, blackening from the top as it burns (uv.x: how much
// has burnt), its top alight while it burns (uv.y).
fn firelighter(p: vec3<f32>, N: vec3<f32>, uv: vec2<f32>) -> Surface {
  var col = vec3<f32>(0.86, 0.83, 0.74) * (0.8 + 0.25 * fbm(p * 300.0));
  let top = smoothstep(0.3, 0.9, N.y);
  col = mix(col, vec3<f32>(0.05, 0.04, 0.035), clamp(uv.x * 1.5 + top * uv.y * 0.6, 0.0, 1.0));
  let flame = glow(1250.0 + 150.0 * fbm(p * 200.0 + F.time * 3.0)) * uv.y * top * 0.8;
  return Surface(col, flame, 0.2, 20.0);
}

// A long match: pale wood, charred toward the head once it has burnt a way (uv.x: distance
// from the head, uv.y: how far it has burnt).
fn matchStick(uv: vec2<f32>) -> Surface {
  let charred = smoothstep(uv.y + 0.004, uv.y - 0.004, uv.x);
  let col = mix(vec3<f32>(0.78, 0.63, 0.42), vec3<f32>(0.04, 0.03, 0.03), charred);
  let ember = glow(1000.0) * smoothstep(0.012, 0.0, abs(uv.x - uv.y)) * step(0.001, uv.y) * 0.5;
  return Surface(col, ember, 0.05, 8.0);
}

fn matchHead(uv: vec2<f32>) -> Surface {
  let col = mix(vec3<f32>(0.5, 0.06, 0.04), vec3<f32>(0.03, 0.025, 0.025), step(0.0005, uv.y));
  return Surface(col, vec3<f32>(0.0), 0.2, 20.0);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let p = in.wpos;
  if (in.clear > 0u && seeThrough(in.clear, in.clip.xy, p)) { discard; }
  if (in.mat == MAT_SKY) {
    return vec4<f32>(sky(normalize(p - F.camPos)), 1.0);
  }
  if (in.mat == MAT_GLOW) {
    // A firefly's cold yellow-green light, or eyes shining back the firelight.
    let d2 = dot(in.uv, in.uv);
    if (d2 > 1.0) { discard; }
    let tint = select(vec3<f32>(0.55, 1.0, 0.18) * 60.0, vec3<f32>(0.85, 1.0, 0.55) * 8.0, in.nrm.y > 0.5);
    return vec4<f32>(tint * in.nrm.x * (1.0 - d2) * (1.0 - d2), 1.0);
  }
  var N = normalize(in.nrm);
  if (in.mat == MAT_LEAF && dot(N, F.camPos - p) < 0.0) { N = -N; } // (seen from either side)
  if (in.mat == MAT_RUG && (in.uv.y < 0.0 || in.uv.y > 1.0) && !fringeThread(in.uv, in.extra)) { discard; }
  var s: Surface;
  switch (in.mat) {
    case MAT_FIREBRICK: { s = firebrick(p, in.uv, N); }
    case MAT_BRICK: { s = redBrick(p, in.uv); }
    case MAT_HEARTH: { s = hearthStone(p, in.uv); }
    case MAT_IRON: { s = iron(in.uv); }
    case MAT_BRASS: { s = Surface(vec3<f32>(0.5, 0.35, 0.12), vec3<f32>(0.0), 0.7, 60.0); }
    case MAT_PLASTER: {
      s = plaster(p);
      N = bumped(N, p, 0.0012, 9.0);
    }
    case MAT_DADO: {
      s = dado(p);
      N = bumped(N, p, 0.0008, 9.0);
    }
    case MAT_ADOBE: {
      // (Plastered by hand: the broad sweep of the trowel, and the grain of the clay.)
      N = bumped(bumped(N, p, 0.0035, 7.0), p, 0.0006, 45.0);
      s = adobe(p, N);
    }
    case MAT_TALAVERA: { s = talavera(in.uv, p); }
    case MAT_TERRACOTTA: { s = terracotta(in.uv); }
    case MAT_BEAM: {
      s = beam(p);
      N = bumped(N, p, 0.002, 14.0);
    }
    case MAT_POTTERY: { s = pottery(in.uv, p); }
    case MAT_BARK: { s = bark(in.uv, in.extra); }
    case MAT_END_GRAIN: { s = endGrain(in.uv, in.extra); }
    case MAT_SPLIT_WOOD: { s = splitWood(in.uv, in.extra, p); }
    case MAT_DRIFTWOOD: { s = driftwood(in.uv, p); }
    case MAT_WAX: { s = wax(p); }
    case MAT_FLAME: { s = candleFlame(in.uv); }
    case MAT_RUG: {
      if (in.uv.y < 0.0 || in.uv.y > 1.0) {
        s = Surface(vec3<f32>(0.72, 0.64, 0.48) * (0.8 + 0.3 * valueNoise(vec3<f32>(in.uv * 400.0, 1.0))), vec3<f32>(0.0), 0.0, 1.0);
      } else {
        s = Surface(rugColour(in.uv, in.extra), vec3<f32>(0.0), 0.0, 1.0);
      }
    }
    case MAT_WICKER: { s = wicker(in.uv); }
    case MAT_FABRIC: { s = fabric(p, in.extra); }
    case MAT_BOOK: { s = bookCover(in.uv, in.extra, p); }
    case MAT_PAGES: { s = pages(p); }
    case MAT_PAINTING: { s = painting(in.uv, in.extra.x); }
    case MAT_GILT: { s = gilt(p); }
    case MAT_CLOCK_FACE: { s = clockFace(in.uv); }
    case MAT_PAINT: { s = paint(p, in.extra); }
    case MAT_FINISH: { s = finish(p, in.extra); }
    case MAT_FUR: { s = catFur(in.place, N); }
    case MAT_LEAF: { s = leafSurface(in.uv, in.extra); }
    case MAT_CERAMIC: { s = ceramic(p, in.extra); }
    case MAT_PLATE: { s = talaveraPlate(in.uv); }
    case MAT_CHILE: { s = chile(p); }
    case MAT_EMBERS: { s = embers(p); }
    case MAT_FLOOR: { s = floorPlanks(p); }
    case MAT_MANTEL: { s = mantelWood(p); }
    case MAT_SOOT: { s = Surface(vec3<f32>(0.02), vec3<f32>(0.0), 0.0, 1.0); }
    case MAT_GROUND: {
      s = ground(p);
      N = bumped(N, p, 0.004, 12.0);
    }
    case MAT_STONE: {
      s = stone(p, N);
      N = bumped(N, p, 0.004, 22.0);
    }
    case MAT_NEEDLES: { s = needles(p); }
    case MAT_SAND: {
      s = sand(p);
      N = ripples(N, p);
    }
    case MAT_TENT: {
      // (Lit on whichever side is seen: the fire lights the underside of the roof.)
      if (dot(N, F.camPos - p) < 0.0) { N = -N; }
      s = tentCloth(in.uv, p);
    }
    case MAT_KETTLE: { s = kettleMetal(in.uv, p); }
    case MAT_TEA_GLASS: { s = teaGlass(); }
    case MAT_HAIR: { s = hair(p); }
    case MAT_MOUNTAIN: {
      // (Fine relief the mesh is too coarse for: gullies, rock ribs, the lie of the snow.)
      N = bumped(bumped(N, p, 0.1, 0.8), p, 0.03, 3.2);
      s = mountain(in.uv, p, N);
    }
    case MAT_SHADE: { s = lampShade(in.uv); }
    case MAT_GLASS: { s = lanternGlass(); }
    case MAT_JAR: { s = jar(p); }
    case MAT_TIN: { s = Surface(vec3<f32>(0.05, 0.08, 0.06), vec3<f32>(0.0), 0.45, 40.0); }
    case MAT_CRITTER: {
      // Wings: a moth's pale and dusty, a bat's dark and leathery. A bat's is seen from the
      // side it shows; a moth's is thin enough to glow through, lit from the lamp's side.
      let toward = select(F.camPos, F.lamps[0].xyz, in.uv.x > 0.5);
      if (dot(N, toward - p) < 0.0) { N = -N; }
      s = Surface(select(vec3<f32>(0.025, 0.02, 0.02), vec3<f32>(0.6, 0.54, 0.42), in.uv.x > 0.5), vec3<f32>(0.0), 0.02, 4.0);
    }
    case MAT_FIRELIGHTER: { s = firelighter(p, N, in.uv); }
    case MAT_MATCH: { s = matchStick(in.uv); }
    case MAT_MATCH_HEAD: { s = matchHead(in.uv); }
    default: { s = Surface(vec3<f32>(0.5), vec3<f32>(0.0), 0.0, 1.0); }
  }
  var colour = shade(p, N, s.albedo, s.spec, s.gloss, s.emission);
  if (F.opening.x <= 0.0) {
    // Out in the open, the far hills and the mountain fade into the sky behind them.
    let away = p - F.camPos;
    let haze = 1.0 - exp(-max(length(away) - 20.0, 0.0) / 380.0);
    colour = mix(colour, skyGradient(normalize(away)), haze);
  }
  return vec4<f32>(colour, 1.0);
}
