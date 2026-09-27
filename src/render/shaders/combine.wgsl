// Puts the fire in front of the scene. The scene is seen through the churning hot air, which
// bends its light a little (heat haze), and the fire's own light is smoothed over consecutive
// frames, which hides the ray-marching grain and adds the slight motion blur the eye expects.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var sceneTex: texture_2d<f32>;
@group(0) @binding(2) var volTex: texture_2d<f32>;
@group(0) @binding(3) var heatTex: texture_2d<f32>;
@group(0) @binding(4) var histTex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;

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

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

struct CombineOut {
  @location(0) color: vec4<f32>,
  @location(1) history: vec4<f32>,
};

@fragment
fn fs(in: FsIn) -> CombineOut {
  let pix = vec2<i32>(in.pos.xy);
  let v = mix(textureLoad(histTex, pix, 0), textureLoad(volTex, pix, 0), F.volBlend);

  // Heat haze: an offset that grows with the hot air along the view ray, from noise that
  // rises with the gas.
  let heat = textureSampleLevel(heatTex, samp, in.uv, 0.0).x;
  let aspect = F.resolution.x / F.resolution.y;
  let q = vec2<f32>(in.uv.x * aspect, in.uv.y) * 26.0 + vec2<f32>(0.0, F.time * 2.4);
  let wobble = vec2<f32>(noise2(q), noise2(q * 1.3 + vec2<f32>(17.3, 5.1))) - 0.5;
  let offset = wobble * min(heat, 0.5) * F.haze / F.resolution;
  let scene = textureSampleLevel(sceneTex, samp, in.uv + offset, 0.0).rgb;

  var out: CombineOut;
  out.color = vec4<f32>(scene * v.a + v.rgb, 1.0);
  out.history = v;
  return out;
}
