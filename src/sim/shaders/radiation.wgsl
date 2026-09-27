// Heat radiated by the hot gas, gathered into blocks (position = where it comes from,
// w = power in W) for the logs to absorb. Uses the same radiative loss as the gas cooling in
// forces.wgsl, so the energy the flames lose is what reaches the logs.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var scal: texture_3d<f32>;
@group(0) @binding(2) var<storage, read_write> radOut: array<vec4<f32>>;

const BLOCKS = vec3<u32>(4u, 3u, 2u);
const WG: u32 = 256u;

var<workgroup> acc: array<vec4<f32>, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let b = wid.x;
  let size = (P.dims + BLOCKS - 1u) / BLOCKS;
  let start = vec3<u32>(b % BLOCKS.x, (b / BLOCKS.x) % BLOCKS.y, b / (BLOCKS.x * BLOCKS.y)) * size;
  let ext = min(start + size, P.dims) - start;
  let n = ext.x * ext.y * ext.z;
  let ta = P.tAmb * 0.001;
  let ta4 = ta * ta * ta * ta;

  var sum = vec4<f32>(0.0);
  for (var k = li; k < n; k += WG) {
    let cell = start + vec3<u32>(k % ext.x, (k / ext.x) % ext.y, k / (ext.x * ext.y));
    let s = textureLoad(scal, cell, 0);
    let tk = s.x * 0.001;
    let w = P.cooling * (1.0 + 6.0 * max(s.w, 0.0)) * max(tk * tk * tk * tk - ta4, 0.0);
    sum += vec4<f32>((vec3<f32>(cell) + 0.5) * w, w);
  }
  acc[li] = sum;
  workgroupBarrier();
  for (var stride = WG / 2u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      acc[li] += acc[li + stride];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let total = acc[0];
    var centre = vec3<f32>(start) + vec3<f32>(ext) * 0.5;
    if (total.w > 1e-6) { centre = total.xyz / total.w; }
    // K/s summed over cells, times rho*cp of air and the cell volume, gives watts.
    radOut[b] = vec4<f32>(P.origin + centre * P.h, total.w * 1200.0 * P.h * P.h * P.h);
  }
}
