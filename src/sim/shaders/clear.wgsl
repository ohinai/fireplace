// Resets the air to still, room-temperature, fuel-free, smokeless air. Dispatched over
// velocity texels.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var velOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(2) var scalOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(3) var auxOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid > P.dims)) { return; }
  let t = vec3<i32>(gid);
  textureStore(velOut, t, vec4<f32>(0.0));
  if (all(gid < P.dims)) {
    textureStore(scalOut, t, ambient());
    textureStore(auxOut, t, vec4<f32>(0.0));
  }
}
