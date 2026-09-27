// Coarse grid of how much firelight reaches each point in the fire's volume, for lighting smoke.
// Stores the light an isotropic smoke particle scatters toward the viewer: irradiance / 4 pi.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> bb: array<vec4<f32>>; // (unused here; common.wgsl needs it declared)
@group(0) @binding(2) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(3) var fieldOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(fieldOut);
  if (any(gid >= dims)) { return; }
  let uvw = (vec3<f32>(gid) + 0.5) / vec3<f32>(dims);
  let p = F.simOrigin + uvw * F.simDims * F.simH;
  var e = vec3<f32>(0.0);
  for (var i = 0u; i < F.numLights; i++) {
    let l = lights[2u * i].xyz - p;
    e += lights[2u * i + 1u].rgb / (dot(l, l) + 0.004);
  }
  for (var i = 0u; i < 3u; i++) {
    let le = F.embers[2u * i].xyz - p;
    e += F.embers[2u * i + 1u].rgb / (dot(le, le) + 0.004);
  }
  // Moonlight or daylight on the smoke (little of it inside a firebox).
  let outside = select(0.15, 1.0, F.opening.x <= 0.0);
  e += (F.sky.rgb + 0.5 * F.sunColour.rgb) * (4.0 * PI * outside);
  textureStore(fieldOut, gid, vec4<f32>(e / (4.0 * PI), 0.0));
}
