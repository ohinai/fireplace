// Vorticity (curl of velocity) at cell centres, for vorticity confinement. w = |curl|.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var vel: texture_3d<f32>;
@group(0) @binding(2) var<storage, read_write> curlOut: array<vec4<f32>>;

// Cell-centred velocity: the average of the two faces on each axis.
fn V(c0: vec3<i32>) -> vec3<f32> {
  let c = clamp(c0, vec3<i32>(0), vec3<i32>(P.dims) - 1);
  let lo = textureLoad(vel, c, 0);
  return 0.5 * vec3<f32>(
    lo.x + textureLoad(vel, c + vec3<i32>(1, 0, 0), 0).x,
    lo.y + textureLoad(vel, c + vec3<i32>(0, 1, 0), 0).y,
    lo.z + textureLoad(vel, c + vec3<i32>(0, 0, 1), 0).z);
}

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= P.dims)) { return; }
  let c = vec3<i32>(gid);
  let L = V(c - vec3<i32>(1, 0, 0));
  let R = V(c + vec3<i32>(1, 0, 0));
  let D = V(c - vec3<i32>(0, 1, 0));
  let U = V(c + vec3<i32>(0, 1, 0));
  let B = V(c - vec3<i32>(0, 0, 1));
  let Fr = V(c + vec3<i32>(0, 0, 1));
  let w = vec3<f32>(
    (U.z - D.z) - (Fr.y - B.y),
    (Fr.x - B.x) - (R.z - L.z),
    (R.y - L.y) - (U.x - D.x)) * (0.5 / P.h);
  curlOut[cellIndex(c)] = vec4<f32>(w, length(w));
}
