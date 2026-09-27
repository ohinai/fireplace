// Vorticity confinement force at cell centres: pushes flow around the local swirl centres,
// putting back small eddies that the coarse grid smears out. Off next to walls and logs: the
// staircase of a voxelised surface looks like swirl, and amplifying it would make jets.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var<storage, read> curl: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read_write> forceOut: array<vec4<f32>>;

fn W(c: vec3<i32>) -> f32 {
  return curl[cellIndex(clamp(c, vec3<i32>(0), vec3<i32>(P.dims) - 1))].w;
}

fn blocked(c: vec3<i32>) -> bool {
  if (!inGrid(c)) { return boundaryKind(c) != BND_OPEN; }
  return solid[cellIndex(c)] != SOLID_NONE;
}

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= P.dims)) { return; }
  let c = vec3<i32>(gid);
  let i = cellIndex(c);
  var f = vec3<f32>(0.0);
  var nearSurface = solid[i] != SOLID_NONE;
  for (var a = 0u; a < 3u; a++) {
    nearSurface = nearSurface || blocked(c + axisI(a)) || blocked(c - axisI(a));
  }
  if (!nearSurface) {
    let grad = vec3<f32>(
      W(c + vec3<i32>(1, 0, 0)) - W(c - vec3<i32>(1, 0, 0)),
      W(c + vec3<i32>(0, 1, 0)) - W(c - vec3<i32>(0, 1, 0)),
      W(c + vec3<i32>(0, 0, 1)) - W(c - vec3<i32>(0, 0, 1)));
    let len = length(grad);
    if (len > 1e-5) {
      f = P.vorticity * P.h * cross(grad / len, curl[i].xyz);
    }
  }
  forceOut[i] = vec4<f32>(f, 0.0);
}
