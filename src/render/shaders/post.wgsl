// Bloom (downsample / upsample chain, after Jimenez 2014) and the final tonemap.

struct FsIn {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vsFull(@builtin(vertex_index) vi: u32) -> FsIn {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FsIn;
  o.pos = vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2<f32>(p.x, 1.0 - p.y);
  return o;
}

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

override KARIS: bool = false;

fn tap(uv: vec2<f32>, ts: vec2<f32>, x: f32, y: f32) -> vec3<f32> {
  return textureSampleLevel(src, samp, uv + ts * vec2<f32>(x, y), 0.0).rgb;
}

fn karisWeight(c: vec3<f32>) -> f32 {
  return 1.0 / (1.0 + dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)));
}

@fragment
fn fsDown(in: FsIn) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  let uv = in.uv;
  let a = tap(uv, ts, -2.0, -2.0);
  let b = tap(uv, ts, 0.0, -2.0);
  let c = tap(uv, ts, 2.0, -2.0);
  let d = tap(uv, ts, -2.0, 0.0);
  let e = tap(uv, ts, 0.0, 0.0);
  let f = tap(uv, ts, 2.0, 0.0);
  let g = tap(uv, ts, -2.0, 2.0);
  let h = tap(uv, ts, 0.0, 2.0);
  let i = tap(uv, ts, 2.0, 2.0);
  let j = tap(uv, ts, -1.0, -1.0);
  let k = tap(uv, ts, 1.0, -1.0);
  let l = tap(uv, ts, -1.0, 1.0);
  let m = tap(uv, ts, 1.0, 1.0);
  var col: vec3<f32>;
  if (KARIS) {
    // Weight each block by inverse brightness so single hot pixels don't flicker in the bloom.
    let g0 = (a + b + d + e) * 0.25;
    let g1 = (b + c + e + f) * 0.25;
    let g2 = (d + e + g + h) * 0.25;
    let g3 = (e + f + h + i) * 0.25;
    let g4 = (j + k + l + m) * 0.25;
    let w0 = karisWeight(g0) * 0.125;
    let w1 = karisWeight(g1) * 0.125;
    let w2 = karisWeight(g2) * 0.125;
    let w3 = karisWeight(g3) * 0.125;
    let w4 = karisWeight(g4) * 0.5;
    col = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  } else {
    col = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  }
  return vec4<f32>(col, 1.0);
}

@fragment
fn fsUp(in: FsIn) -> @location(0) vec4<f32> {
  let ts = 1.0 / vec2<f32>(textureDimensions(src));
  let uv = in.uv;
  var s = tap(uv, ts, 0.0, 0.0) * 4.0;
  s += (tap(uv, ts, -1.0, 0.0) + tap(uv, ts, 1.0, 0.0) + tap(uv, ts, 0.0, -1.0) + tap(uv, ts, 0.0, 1.0)) * 2.0;
  s += tap(uv, ts, -1.0, -1.0) + tap(uv, ts, 1.0, -1.0) + tap(uv, ts, -1.0, 1.0) + tap(uv, ts, 1.0, 1.0);
  return vec4<f32>(s / 16.0, 1.0);
}
