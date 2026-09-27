// Net outflow of each cell (in m/s, i.e. divergence times cell size), minus the expansion the
// gas is supposed to have. The pressure solve removes what is left.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var vel: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read> expand: array<f32>;
@group(0) @binding(4) var<storage, read_write> divOut: array<f32>;

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= P.dims)) { return; }
  let c = vec3<i32>(gid);
  let i = cellIndex(c);
  if (solid[i] != SOLID_NONE) {
    divOut[i] = 0.0;
    return;
  }
  let lo = textureLoad(vel, c, 0);
  let d = textureLoad(vel, c + vec3<i32>(1, 0, 0), 0).x - lo.x
        + textureLoad(vel, c + vec3<i32>(0, 1, 0), 0).y - lo.y
        + textureLoad(vel, c + vec3<i32>(0, 0, 1), 0).z - lo.z;
  divOut[i] = d - expand[i];
}
