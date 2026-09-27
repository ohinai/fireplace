// Mixing on scales finer than the grid. In a real flame, wood gas and air are brought together
// by eddies far smaller than a grid cell. Without them the flames would depend on the grid: a
// coarse grid's big cells smear fuel and air together, so they burn right by the wood; on a fine
// grid they stay apart, so the flames lift off and fade. A small eddy diffusion of the gases
// (fuel, air, CO and smoke), the same on every grid, stands in for that mixing. Heat and soot are
// left where they are: diffusing heat out of a thin flame on a fine grid would put it out.
// Solids and the edges of the grid let nothing through (the forces pass fills solid cells). On a
// fine grid the mixing in a step reaches further than one explicit pass can safely take, so it is
// done in MIX_PASSES passes (see FireSim).

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var scalIn: texture_3d<f32>;
@group(0) @binding(2) var auxIn: texture_3d<f32>;
@group(0) @binding(3) var<storage, read> solid: array<u32>;
@group(0) @binding(4) var scalOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var auxOut: texture_storage_3d<rgba16float, write>;

override MIXING: f32 = 2.5e-4; // m2/s
override MIX_PASSES: f32 = 1.0;

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= P.dims)) { return; }
  let c = vec3<i32>(gid);
  let s = textureLoad(scalIn, c, 0);
  let a = textureLoad(auxIn, c, 0);
  if (solid[cellIndex(c)] != SOLID_NONE) {
    textureStore(scalOut, c, s);
    textureStore(auxOut, c, a);
    return;
  }
  // (Explicit, so kept inside its stability limit of 1/6.)
  let k = min(MIXING * P.dt / (P.h * P.h) / MIX_PASSES, 0.16);
  var ds = vec4<f32>(0.0);
  var da = vec4<f32>(0.0);
  for (var ax = 0u; ax < 3u; ax++) {
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      let n = c + axisI(ax) * sgn;
      if (inGrid(n) && solid[cellIndex(n)] == SOLID_NONE) {
        ds += textureLoad(scalIn, n, 0) - s;
        da += textureLoad(auxIn, n, 0) - a;
      }
    }
  }
  textureStore(scalOut, c, vec4<f32>(s.x, s.yz + k * ds.yz, s.w));
  textureStore(auxOut, c, vec4<f32>(a.xy + k * da.xy, a.zw));
}
