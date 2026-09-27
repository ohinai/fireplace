// Subtracts the pressure gradient from every free face, which makes the flow exactly
// divergence free (up to the solver's convergence). Blocked faces move with the log they belong
// to (or stay shut) and flue faces keep the chimney's draw. Dispatched over velocity texels;
// padding copies the nearest face.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var velIn: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read> pressure: array<f32>;
@group(0) @binding(4) var velOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var<storage, read> logs: array<LogGPU>;

fn pressureAt(c: vec3<i32>) -> f32 {
  if (inGrid(c)) { return pressure[cellIndex(c)]; }
  return 0.0; // the fireplace opening; other outside cells never border a free face
}

fn projectFace(f: vec3<i32>, a: u32) -> f32 {
  let kind = faceKind(f, a);
  if (kind == FACE_BLOCKED) { return solidFaceVelocity(f, a); }
  if (kind == FACE_FLUE) { return P.flueSpeed; }
  return textureLoad(velIn, f, 0)[a] - (pressureAt(f) - pressureAt(f - axisI(a)));
}

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid > P.dims)) { return; }
  let t = vec3<i32>(gid);
  var vel = vec4<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    vel[a] = projectFace(clampFace(t, a), a);
  }
  textureStore(velOut, t, vel);
}
