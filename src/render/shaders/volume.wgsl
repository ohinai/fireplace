// Ray-marches the fire volume in front of the already-rendered scene. Output is premultiplied:
// rgb = light added along the ray, a = transmittance, blended as dst * a + rgb.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var linSamp: sampler;
@group(0) @binding(2) var scal: texture_3d<f32>;
@group(0) @binding(3) var depthTex: texture_depth_2d;
@group(0) @binding(4) var<storage, read> bb: array<vec4<f32>>;
@group(0) @binding(5) var vel: texture_3d<f32>;
@group(0) @binding(6) var smokeTex: texture_3d<f32>;
@group(0) @binding(7) var lightField: texture_3d<f32>;
@group(0) @binding(8) var flameNoise: texture_3d<f32>;
@group(0) @binding(9) var repeatSamp: sampler;
@group(0) @binding(10) var carriedA: texture_3d<f32>; // how far the gas has moved (m), for each layer of detail (flame_coords.wgsl)
@group(0) @binding(11) var carriedB: texture_3d<f32>;

// Share of light that smoke scatters rather than absorbs: tar and water droplets are pale,
// soot is dark.
const SMOKE_ALBEDO: f32 = 0.85;
const SOOT_ALBEDO: f32 = 0.15;
// Smoke lit by a fire is hundreds of times dimmer than its flames: a camera exposed for the
// flames shows it black, but the eye, adapting to what it looks at, sees the pale plume rising
// beside them. (As with glowing embers, brightness is compressed for the eye, not the camera.)
const SMOKE_SEEN: f32 = 2.5;
// How bright CO flames are next to the blue base of wood-gas flames (they are thin, but pure blue).
const CO_BLUE: f32 = 40.0;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

// A 3D texture sampled with a cubic B-spline rather than trilinearly (at Ultra): smooth right
// across the cells' faces, so that no trace of the grid shows in the flames even close up. Eight
// trilinear samples, each weighted and placed to sum to the sixty-four texels' B-spline (Sigg and
// Hadwiger's trick).
fn smoothSample(tex: texture_3d<f32>, uvw: vec3<f32>) -> vec4<f32> {
  let size = vec3<f32>(textureDimensions(tex));
  let c = uvw * size - 0.5;
  let i = floor(c);
  let f = c - i;
  let f2 = f * f;
  let f3 = f2 * f;
  let w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  let w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  let w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  let w3 = f3 / 6.0;
  let g0 = w0 + w1;
  let g1 = w2 + w3;
  let h0 = (i - 0.5 + w1 / g0) / size;
  let h1 = (i + 1.5 + w3 / g1) / size;
  let s000 = textureSampleLevel(tex, linSamp, vec3<f32>(h0.x, h0.y, h0.z), 0.0);
  let s100 = textureSampleLevel(tex, linSamp, vec3<f32>(h1.x, h0.y, h0.z), 0.0);
  let s010 = textureSampleLevel(tex, linSamp, vec3<f32>(h0.x, h1.y, h0.z), 0.0);
  let s110 = textureSampleLevel(tex, linSamp, vec3<f32>(h1.x, h1.y, h0.z), 0.0);
  let s001 = textureSampleLevel(tex, linSamp, vec3<f32>(h0.x, h0.y, h1.z), 0.0);
  let s101 = textureSampleLevel(tex, linSamp, vec3<f32>(h1.x, h0.y, h1.z), 0.0);
  let s011 = textureSampleLevel(tex, linSamp, vec3<f32>(h0.x, h1.y, h1.z), 0.0);
  let s111 = textureSampleLevel(tex, linSamp, vec3<f32>(h1.x, h1.y, h1.z), 0.0);
  let z0 = g0.y * (g0.x * s000 + g1.x * s100) + g1.y * (g0.x * s010 + g1.x * s110);
  let z1 = g0.y * (g0.x * s001 + g1.x * s101) + g1.y * (g0.x * s011 + g1.x * s111);
  return g0.z * z0 + g1.z * z1;
}

// The fire's fields at uvw: smoothly at Ultra, trilinearly otherwise.
fn fieldSample(tex: texture_3d<f32>, uvw: vec3<f32>) -> vec4<f32> {
  if (F.grade.z > 0.5) { return smoothSample(tex, uvw); }
  return textureSampleLevel(tex, linSamp, uvw, 0.0);
}

// Fine detail for flames on a coarse grid. A flame burns in thin sheets where the wood gas meets
// the air; a grid of 15 mm cells smears them into thick, dim, glowing blobs. (At High, half the
// flames' light comes from a tenth of the gas it does at Low, and the gas over 1500 K fills a
// quarter of the room it does at Low.) So on a coarse grid a cell of flame is taken to be flame
// only in places: its soot is gathered into tongues that fill a share of it, brighter to match
// (the same light on average), drawn from noise carried along with the gas, so that it rises,
// leans, stretches and curls as the flames do.
// Size (m) of a feature of the noise: across the view, up, and along the view. Long along the
// view, so that the ray, adding up all the light behind a pixel, still sees tongues rather than
// averaging many into a blur. (Laid out from the eye, the noise turns as the eye moves round the
// fire; flames change too fast for that to show.)
const DETAIL_SIZE = vec3<f32>(0.024, 0.06, 0.12);
const DETAIL_PERIOD: f32 = 8.0; // noise features across the baked noise (flame_noise.wgsl)
const DETAIL_CYCLE: f32 = 0.3; // s: how long a layer of detail is carried before it is renewed (Renderer.ts)
const FLAME_SHARE: f32 = 0.35; // share of a coarse cell of flame that is flame
const FLAME_EDGE: f32 = 0.3; // how soft the tongues' edges are (in the noise's standard deviations)

// One layer of the noise at p, from where the gas there was when the layer was renewed.
fn carriedNoise(p: vec3<f32>, moved: vec3<f32>, seed: vec3<f32>, across: vec3<f32>, along: vec3<f32>) -> f32 {
  let was = p - moved;
  let at = vec3<f32>(dot(was, across), was.y, dot(was, along));
  return textureSampleLevel(flameNoise, repeatSamp, at / (DETAIL_SIZE * DETAIL_PERIOD) + seed, 0.0).x;
}

// Noise (about unit normal) at p, carried with the gas: two layers, each renewed (at a random
// place in the noise) while the other shows, blended keeping the contrast. `across` and `along`
// are the horizontal directions across and along the view.
fn flowNoise(p: vec3<f32>, uvw: vec3<f32>, across: vec3<f32>, along: vec3<f32>) -> f32 {
  let cycle = F.time / DETAIL_CYCLE;
  let ageA = fract(cycle);
  let ageB = fract(cycle + 0.5);
  let wA = 1.0 - abs(2.0 * ageA - 1.0);
  let wB = 1.0 - wA;
  let seedA = hash33(vec3<i32>(i32(floor(cycle)), 0, 101));
  let seedB = hash33(vec3<i32>(i32(floor(cycle + 0.5)), 1, 101));
  let nA = carriedNoise(p, textureSampleLevel(carriedA, linSamp, uvw, 0.0).xyz, seedA, across, along);
  let nB = carriedNoise(p, textureSampleLevel(carriedB, linSamp, uvw, 0.0).xyz, seedB, across, along);
  return (wA * nA + wB * nB) * inverseSqrt(max(wA * wA + wB * wB, 1e-4));
}

// The soot at p, gathered into tongues: s is the coarse sample there.
fn flameSoot(s: vec4<f32>, p: vec3<f32>, uvw: vec3<f32>, across: vec3<f32>, along: vec3<f32>) -> f32 {
  let soot = max(s.w, 0.0);
  let flame = smoothstep(800.0, 1100.0, s.x) * (1.0 - smoothstep(1900.0, 2200.0, s.x)) * F.grade.w;
  if (flame <= 0.0 || soot <= 1e-4) { return soot; }
  let share = 1.0 - (1.0 - FLAME_SHARE) * flame;
  // Flame where the noise is below the level a share of it lies below (normal quantile, by the
  // logistic approximation).
  let level = log(share / max(1.0 - share, 1e-4)) / 1.702;
  let inFlame = 1.0 - smoothstep(level - FLAME_EDGE, level + FLAME_EDGE, flowNoise(p, uvw, across, along));
  return soot * inFlame / share;
}

fn heatRamp(x: f32) -> vec3<f32> {
  return clamp(vec3<f32>(x * 3.0, x * 3.0 - 1.0, x * 3.0 - 2.0), vec3<f32>(0.0), vec3<f32>(1.0));
}

// Debug views: returns (colour per metre, extinction per metre).
fn debugSample(s: vec4<f32>, uvw: vec3<f32>) -> vec4<f32> {
  var r = vec4<f32>(0.0);
  switch (F.debugView) {
    case 1u: {
      let x = clamp((s.x - F.tAmb) / 1500.0, 0.0, 1.0);
      r = vec4<f32>(heatRamp(x) * x * 4.0, x * 12.0);
    }
    case 2u: {
      let x = clamp(s.y * 4.0, 0.0, 1.0);
      r = vec4<f32>(vec3<f32>(0.2, 1.0, 0.3) * x * 4.0, x * 12.0);
    }
    case 3u: {
      let x = clamp(1.0 - s.z, 0.0, 1.0);
      r = vec4<f32>(vec3<f32>(0.3, 0.5, 1.0) * x * 4.0, x * 12.0);
    }
    case 4u: {
      let x = clamp(s.w * 3.0, 0.0, 1.0);
      r = vec4<f32>(vec3<f32>(x * 4.0), x * 12.0);
    }
    default: {
      // Staggered velocity: component a sits half a cell back along axis a.
      let q = uvw * F.simDims;
      let inv = 1.0 / (F.simDims + 1.0);
      let v = vec3<f32>(
        textureSampleLevel(vel, linSamp, (q + vec3<f32>(0.5, 0.0, 0.0)) * inv, 0.0).x,
        textureSampleLevel(vel, linSamp, (q + vec3<f32>(0.0, 0.5, 0.0)) * inv, 0.0).y,
        textureSampleLevel(vel, linSamp, (q + vec3<f32>(0.0, 0.0, 0.5)) * inv, 0.0).z);
      let x = clamp(length(v) / 3.0, 0.0, 1.0);
      r = vec4<f32>(heatRamp(x) * x * 4.0, x * 6.0);
    }
  }
  return r;
}

struct VolumeOut {
  @location(0) light: vec4<f32>, // light added along the ray, and transmittance
  @location(1) heat: vec4<f32>,  // x: hot air the ray passes through (drives heat haze)
};

@fragment
fn fs(@builtin(position) fragPos: vec4<f32>) -> VolumeOut {
  var out: VolumeOut;
  out.light = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  out.heat = vec4<f32>(0.0);
  let pix = vec2<i32>(fragPos.xy);
  let ndc = vec2<f32>(fragPos.x / F.resolution.x * 2.0 - 1.0, 1.0 - fragPos.y / F.resolution.y * 2.0);
  let ro = F.camPos;
  let pf = F.invViewProj * vec4<f32>(ndc, 1.0, 1.0);
  let rd = normalize(pf.xyz / pf.w - ro);
  let ps = F.invViewProj * vec4<f32>(ndc, textureLoad(depthTex, pix, 0), 1.0);
  let tScene = length(ps.xyz / ps.w - ro);

  let size = F.simDims * F.simH;
  let bmin = F.simOrigin;
  let inv = 1.0 / rd;
  let t0 = (bmin - ro) * inv;
  let t1 = (bmin + size - ro) * inv;
  let tlo = min(t0, t1);
  let thi = max(t0, t1);
  let tNear = max(max(tlo.x, tlo.y), max(tlo.z, 0.0));
  let tFar = min(min(thi.x, thi.y), min(thi.z, tScene));
  if (tNear >= tFar) {
    return out;
  }

  // The horizontal directions along and across the view (for the flames' fine detail).
  let ahead = F.invViewProj * vec4<f32>(0.0, 0.0, 1.0, 1.0);
  let look = ahead.xyz / ahead.w - ro;
  let along = normalize(vec3<f32>(look.x, 0.0, look.z) + vec3<f32>(0.0, 0.0, 1e-6));
  let across = vec3<f32>(-along.z, 0.0, along.x);

  let stepLen = F.simH * F.stepScale;
  // Random start offset per pixel and frame: hides step banding, and the eye averages the
  // remaining grain over successive frames. (Structured noise such as IGN shows as hatching.)
  let jitter = hash33(vec3<i32>(pix, i32(F.frameIdx))).x;
  var t = tNear + jitter * stepLen;
  var L = vec3<f32>(0.0);
  var Tr = 1.0;
  var heat = 0.0;
  var step = 0;
  loop {
    if (t >= tFar || Tr < 0.005) { break; }
    // Each sample is nudged sideways by up to ~half a cell at random: over a few frames this
    // filters out grid-scale streaks the rising gas carries, at no extra cost. (Less with fine
    // detail in the flames, which hides the streaks itself: on a coarse grid a wide nudge, into a
    // flame whose light climbs steeply with its temperature, shows as grain.)
    let r = hash33(vec3<i32>(pix, i32(F.frameIdx) * 64 + step)).yz - 0.5;
    let nudge = vec3<f32>(r.x, 0.0, r.y) * (mix(0.9, 0.35, F.grade.w) * F.simH);
    let uvw = (ro + rd * t + nudge - bmin) / size;
    step++;
    var s = fieldSample(scal, uvw);
    let ds = min(stepLen, tFar - t);
    heat += max(s.x - 450.0, 0.0) * 0.001 * ds;
    var e: vec3<f32>;
    var sigma: f32;
    if (F.debugView == 0u || F.debugView >= 7u) {
      if (F.grade.w > 0.0) { s.w = flameSoot(s, ro + rd * t, uvw, across, along); }
      let aux = fieldSample(smokeTex, uvw);
      var smoke = F.kSmoke * max(aux.x, 0.0);
      var fade = 1.0;
      if (F.opening.x <= 0.0) {
        // In the open, smoke drifts on out of the simulated box: thin it out toward the box's
        // top and sides rather than show where the box ends (and the tips of tall flames). The
        // smoke above the flames fades gradually, as a plume dispersing into the night.
        let edge = min(min(uvw.x, 1.0 - uvw.x), min(uvw.z, 1.0 - uvw.z));
        let up = clamp((1.0 - uvw.y) / 0.5, 0.0, 1.0);
        smoke *= up * up * smoothstep(0.0, 0.15, edge);
        fade = smoothstep(1.0, 0.86, uvw.y);
      }
      let soot = F.kAbs * max(s.w, 0.0) * fade;
      sigma = soot + smoke;
      e = flameEmission(s) * fade;
      // CO burning over embers: faint blue flames, no soot.
      let coFlame = max(aux.y, 0.0) * clamp(s.z, 0.0, 1.0) * smoothstep(820.0, 980.0, s.x);
      e += F.kBlue * CO_BLUE * coFlame * vec3<f32>(0.15, 0.35, 1.0) * fade;
      if (sigma > 1e-3) {
        e += textureSampleLevel(lightField, linSamp, uvw, 0.0).rgb * (smoke * SMOKE_ALBEDO * SMOKE_SEEN + soot * SOOT_ALBEDO);
      }
      if (F.debugView == 8u) {
        // The moisture view: faint flames, so the logs show through them.
        e *= 0.15;
        sigma *= 0.2;
      }
    } else if (F.debugView == 6u) {
      let x = clamp(textureSampleLevel(smokeTex, linSamp, uvw, 0.0).x * 2.0, 0.0, 1.0);
      e = vec3<f32>(x * 4.0);
      sigma = x * 12.0;
    } else {
      let d = debugSample(s, uvw);
      e = d.rgb;
      sigma = d.a;
    }
    let a = exp(-sigma * ds);
    // Exact integral of constant emission over a step with constant extinction.
    L += Tr * select(e * ds, e * (1.0 - a) / sigma, sigma > 1e-4);
    Tr *= a;
    t += stepLen;
  }
  out.light = vec4<f32>(L, Tr);
  out.heat = vec4<f32>(heat, 0.0, 0.0, 0.0);
  return out;
}
