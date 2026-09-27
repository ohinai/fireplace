// Steam from the kettle: soft, ragged puffs facing the viewer, lit (on the CPU) by the fire and
// the sky, blended over the picture and hidden behind anything in front of them.

@group(0) @binding(0) var<uniform> F: Frame;

struct PuffOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) corner: vec2<f32>,
  @location(1) colour: vec4<f32>,
  @location(2) @interpolate(flat) seed: f32,
};

@vertex
fn vs(@builtin(vertex_index) vi: u32, @location(0) puff: vec4<f32>, @location(1) look: vec4<f32>) -> PuffOut {
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let corner = corners[vi % 6u];
  let toCam = normalize(F.camPos - puff.xyz);
  let right = normalize(cross(vec3<f32>(0.0, 1.0, 0.0), toCam));
  let up = cross(toCam, right);
  var o: PuffOut;
  o.clip = F.viewProj * vec4<f32>(puff.xyz + (right * corner.x + up * corner.y) * puff.w, 1.0);
  o.corner = corner;
  o.colour = look;
  o.seed = fract(puff.x * 13.1 + puff.z * 7.7) * 50.0;
  return o;
}

fn puffNoise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let h = vec4<f32>(fract(sin(dot(i, vec2<f32>(127.1, 311.7))) * 43758.5), fract(sin(dot(i + vec2<f32>(1.0, 0.0), vec2<f32>(127.1, 311.7))) * 43758.5),
    fract(sin(dot(i + vec2<f32>(0.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5), fract(sin(dot(i + vec2<f32>(1.0, 1.0), vec2<f32>(127.1, 311.7))) * 43758.5));
  return mix(mix(h.x, h.y, u.x), mix(h.z, h.w, u.x), u.y);
}

@fragment
fn fs(in: PuffOut) -> @location(0) vec4<f32> {
  let r = length(in.corner);
  if (r > 1.0) { discard; }
  // Ragged, thinning toward the edge.
  let q = in.corner * 2.5 + vec2<f32>(in.seed, F.time * 0.3);
  let wisp = 0.45 + 0.55 * (0.6 * puffNoise(q) + 0.4 * puffNoise(q * 2.3 + 5.0));
  let a = in.colour.a * smoothstep(1.0, 0.25, r) * wisp;
  return vec4<f32>(in.colour.rgb * a, a);
}
