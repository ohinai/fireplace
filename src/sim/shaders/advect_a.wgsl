// MacCormack step 1: plain semi-Lagrangian advection of face velocities and cell fields.
// Dispatched over velocity texels (dims + 1).

@group(0) @binding(5) var velOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(6) var scalOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(7) var auxOut: texture_storage_3d<rgba16float, write>;

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid > P.dims)) { return; }
  let t = vec3<i32>(gid);
  let s = P.dt / P.h;

  var vel = vec4<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    vel[a] = sampleComp(velIn, trace(facePos(clampFace(t, a), a), s), a);
  }
  textureStore(velOut, t, vel);

  if (all(gid < P.dims)) {
    let xb = trace(vec3<f32>(gid) + 0.5, s);
    let room = fromRoom(xb);
    textureStore(scalOut, t, select(sampleScal(scalIn, xb), ambient(), room));
    textureStore(auxOut, t, select(sampleScal(auxIn, xb), vec4<f32>(0.0), room));
  }
}
