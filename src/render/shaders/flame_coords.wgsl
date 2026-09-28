// Carries the flames' fine detail along with the gas (see volume.wgsl). For each of two layers of
// detail, how far (m) the gas in each cell has moved since the layer was last renewed: the gas now
// in a cell came from where the flow carried it from, a moment back.

struct Carry {
  dims: vec3<f32>,
  h: f32,      // cell size (m)
  dt: f32,     // s of the fire's time since the last frame
  renewA: f32, // 1: start layer A afresh
  renewB: f32,
  pad: f32,
};

@group(0) @binding(0) var<uniform> C: Carry;
@group(0) @binding(1) var vel: texture_3d<f32>; // staggered: component a sits half a cell back along axis a
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var inA: texture_3d<f32>;
@group(0) @binding(4) var inB: texture_3d<f32>;
@group(0) @binding(5) var outA: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var outB: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(4, 4, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (any(vec3<f32>(id) >= C.dims)) { return; }
  let c = vec3<f32>(id) + 0.5;
  let inv = 1.0 / (C.dims + 1.0);
  let v = vec3<f32>(
    textureSampleLevel(vel, samp, (c + vec3<f32>(0.5, 0.0, 0.0)) * inv, 0.0).x,
    textureSampleLevel(vel, samp, (c + vec3<f32>(0.0, 0.5, 0.0)) * inv, 0.0).y,
    textureSampleLevel(vel, samp, (c + vec3<f32>(0.0, 0.0, 0.5)) * inv, 0.0).z);
  let moved = v * C.dt;
  let back = (c - moved / C.h) / C.dims;
  let a = select(textureSampleLevel(inA, samp, back, 0.0).xyz + moved, vec3<f32>(0.0), C.renewA > 0.5);
  let b = select(textureSampleLevel(inB, samp, back, 0.0).xyz + moved, vec3<f32>(0.0), C.renewB > 0.5);
  textureStore(outA, id, vec4<f32>(a, 0.0));
  textureStore(outB, id, vec4<f32>(b, 0.0));
}
