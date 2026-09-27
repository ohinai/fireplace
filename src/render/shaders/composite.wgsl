// Adds bloom, applies exposure and a filmic tonemap, and writes the sRGB image.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var hdr: texture_2d<f32>;
@group(0) @binding(2) var bloomTex: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;
@group(0) @binding(4) var<storage, read> adapt: array<f32>;

struct FsIn {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> FsIn {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FsIn;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}

// ACES filmic fit (Stephen Hill): highlights roll off and desaturate toward white, which is
// what makes the hottest parts of a flame read as yellow-white.
fn aces(c: vec3<f32>) -> vec3<f32> {
  let a = vec3<f32>(
    dot(c, vec3<f32>(0.59719, 0.35458, 0.04823)),
    dot(c, vec3<f32>(0.076, 0.90834, 0.01566)),
    dot(c, vec3<f32>(0.0284, 0.13383, 0.83777)));
  let b = (a * (a + 0.0245786) - 0.000090537) / (a * (0.983729 * a + 0.432951) + 0.238081);
  return clamp(vec3<f32>(
    dot(b, vec3<f32>(1.60475, -0.53108, -0.07367)),
    dot(b, vec3<f32>(-0.10208, 1.10813, -0.00605)),
    dot(b, vec3<f32>(-0.00327, -0.07276, 1.07602))), vec3<f32>(0.0), vec3<f32>(1.0));
}

fn toSrgb(c: vec3<f32>) -> vec3<f32> {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3<f32>(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3<f32>(0.0031308));
}

@fragment
fn fs(in: FsIn) -> @location(0) vec4<f32> {
  let pix = vec2<i32>(in.pos.xy);
  var c = textureLoad(hdr, pix, 0).rgb;
  c += textureSampleLevel(bloomTex, samp, in.uv, 0.0).rgb * F.bloom;
  c *= F.exposure * max(adapt[0], F.adaptMin);
  let q = in.uv - 0.5;
  c *= 1.0 - 0.6 * dot(q, q);
  // Colour: richer or greyer (keeping the brightness).
  let grey = dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3<f32>(grey), c, F.grade.x), vec3<f32>(0.0));
  var o = toSrgb(aces(c));
  // Dither to avoid banding in the dark gradients.
  let n = fract(52.9829189 * fract(dot(in.pos.xy + F.frameIdx * 5.588238, vec2<f32>(0.06711056, 0.00583715))));
  o += (n - 0.5) / 255.0;
  return vec4<f32>(o, 1.0);
}
