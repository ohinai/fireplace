// Draws each live spark as a thin streak along its recent motion, glowing at its temperature.
// Added on top of the image (and hidden behind logs by the depth test).

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> sparks: array<Spark>;
@group(0) @binding(2) var<storage, read> bb: array<vec4<f32>>;

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) colour: vec3<f32>,
  @location(1) across: f32,
};

const STREAK_TIME: f32 = 0.035; // s of motion shown as a streak
const WIDTH_PX: f32 = 1.8;

@vertex
fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  var o: VOut;
  let sp = sparks[ii];
  if (sp.life <= 0.0) {
    o.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
    return o;
  }
  let c0 = F.viewProj * vec4<f32>(sp.pos - sp.vel * STREAK_TIME, 1.0);
  let c1 = F.viewProj * vec4<f32>(sp.pos, 1.0);
  let px = F.resolution * 0.5;
  let d = (c1.xy / c1.w - c0.xy / c0.w) * px;
  let len = length(d);
  let along = select(vec2<f32>(1.0, 0.0), d / len, len > 1e-3);
  let side = vec2<f32>(-along.y, along.x);

  // Two triangles: corners (end, side) = (0,-1) (1,-1) (1,1) (0,-1) (1,1) (0,1).
  var ends = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  var sides = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let e = ends[vi];
  let sgn = sides[vi];
  var c = mix(c0, c1, e);
  let grow = (along * (e * 2.0 - 1.0) + side * sgn) * WIDTH_PX * 0.5 / px;
  c = vec4<f32>(c.xy + grow * c.w, c.z, c.w);
  o.clip = c;
  // A short, fast streak spreads the same light over more pixels.
  let spread = WIDTH_PX / max(len + WIDTH_PX, WIDTH_PX);
  o.colour = glow(sp.temp + F.glowBoost) * 6.0 * spread * clamp(sp.life * 3.0, 0.0, 1.0);
  o.across = sgn;
  return o;
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let falloff = 1.0 - in.across * in.across;
  return vec4<f32>(in.colour * falloff, 1.0);
}
