// How wet each log is, for the moisture view: one workgroup per log adds up the water in its
// voxels and the wood that has not yet charred (both as shares of a voxel full of dry wood).

@group(0) @binding(0) var<storage, read> prod: array<vec4<f32>>; // w: water per dry wood
@group(0) @binding(1) var<storage, read> look: array<vec4<f32>>; // y: char share, z: fill
@group(0) @binding(2) var<storage, read_write> totals: array<vec4<f32>>;

var<workgroup> water: array<f32, 256>;
var<workgroup> wood: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let base = wg.x * LOG_VOXELS;
  var w = 0.0;
  var d = 0.0;
  for (var i = li; i < LOG_VOXELS; i += 256u) {
    let lk = look[base + i];
    d += lk.z * (1.0 - lk.y);
    w += prod[base + i].w;
  }
  water[li] = w;
  wood[li] = d;
  for (var s = 128u; s > 0u; s >>= 1u) {
    workgroupBarrier();
    if (li < s) {
      water[li] += water[li + s];
      wood[li] += wood[li + s];
    }
  }
  if (li == 0u) {
    totals[wg.x] = vec4<f32>(water[0], wood[0], 0.0, 0.0);
  }
}
