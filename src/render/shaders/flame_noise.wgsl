// Bakes the noise that the flames' fine detail is drawn from (see volume.wgsl): four independent
// fields of smooth gradient noise, one per channel, that tile (repeat seamlessly) across the
// texture, scaled to about unit variance. Worked out once, at the start.

@group(0) @binding(0) var noiseOut: texture_storage_3d<rgba16float, write>;

// Lattice cells across the texture.
const PERIOD: i32 = 8;
// Standard deviation of the raw noise below (measured over the baked texture).
const NOISE_STD: f32 = 0.19;

fn pcg4d(v0: vec4<u32>) -> vec4<u32> {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  v ^= v >> vec4<u32>(16u);
  v.x += v.y * v.w; v.y += v.z * v.x; v.z += v.x * v.y; v.w += v.y * v.z;
  return v;
}

// A random unit vector for a lattice point (wrapped, so the noise tiles), one set per channel.
fn gradient(cell: vec3<i32>, channel: u32) -> vec3<f32> {
  let c = vec3<u32>((cell % PERIOD + PERIOD) % PERIOD);
  let h = pcg4d(vec4<u32>(c, channel));
  let z = f32(h.x) / 4294967296.0 * 2.0 - 1.0;
  let a = f32(h.y) / 4294967296.0 * 6.2831853;
  let r = sqrt(1.0 - z * z);
  return vec3<f32>(r * cos(a), r * sin(a), z);
}

fn gradientNoise(p: vec3<f32>, channel: u32) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var n = 0.0;
  for (var k = 0; k < 8; k++) {
    let o = vec3<i32>(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let w = mix(1.0 - u, u, vec3<f32>(o));
    n += w.x * w.y * w.z * dot(gradient(i + o, channel), f - vec3<f32>(o));
  }
  return n;
}

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let size = textureDimensions(noiseOut);
  if (any(id >= size)) { return; }
  let p = vec3<f32>(id) * f32(PERIOD) / vec3<f32>(size);
  var v = vec4<f32>(0.0);
  for (var c = 0u; c < 4u; c++) {
    v[c] = gradientNoise(p, c) / NOISE_STD;
  }
  textureStore(noiseOut, id, v);
}
