// Turns the glowing gas into a handful of point lights for the room. The grid is split into
// blocks; each block becomes one light at its emission-weighted centre with its total output.
// Layout: lights[2i] = position (w = 1 once written), lights[2i + 1] = intensity (rgb).

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var scal: texture_3d<f32>;
@group(0) @binding(2) var<storage, read> bb: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> lights: array<vec4<f32>>;

const BLOCKS = vec3<u32>(4u, 3u, 2u);
const WG: u32 = 256u;

var<workgroup> sPos: array<vec4<f32>, 256>;
var<workgroup> sCol: array<vec4<f32>, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_index) li: u32) {
  let b = wid.x;
  let dims = vec3<u32>(F.simDims);
  let blockSize = (dims + BLOCKS - 1u) / BLOCKS;
  let bc = vec3<u32>(b % BLOCKS.x, (b / BLOCKS.x) % BLOCKS.y, b / (BLOCKS.x * BLOCKS.y));
  let start = bc * blockSize;
  let ext = min(start + blockSize, dims) - start;
  let n = ext.x * ext.y * ext.z;

  var accPos = vec4<f32>(0.0);
  var accCol = vec3<f32>(0.0);
  for (var k = li; k < n; k += WG) {
    let cell = start + vec3<u32>(k % ext.x, (k / ext.x) % ext.y, k / (ext.x * ext.y));
    let e = flameEmission(textureLoad(scal, cell, 0));
    let w = dot(e, vec3<f32>(0.2126, 0.7152, 0.0722));
    accPos += vec4<f32>((vec3<f32>(cell) + 0.5) * w, w);
    accCol += e;
  }
  sPos[li] = accPos;
  sCol[li] = vec4<f32>(accCol, 0.0);
  workgroupBarrier();

  for (var stride = WG / 2u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      sPos[li] += sPos[li + stride];
      sCol[li] += sCol[li + stride];
    }
    workgroupBarrier();
  }

  if (li == 0u) {
    let total = sPos[0];
    var centre = vec3<f32>(start) + vec3<f32>(ext) * 0.5;
    if (total.w > 1e-6) { centre = total.xyz / total.w; }
    let pos = F.simOrigin + centre * F.simH;
    let intensity = sCol[0].rgb * (F.simH * F.simH * F.simH) * F.lightGain;
    // Light a little smoothed over time, the way the eye integrates flicker.
    let prevPos = lights[2u * b];
    let prevCol = lights[2u * b + 1u];
    let a = select(0.4, 1.0, prevPos.w == 0.0);
    lights[2u * b] = vec4<f32>(mix(prevPos.xyz, pos, a), 1.0);
    lights[2u * b + 1u] = vec4<f32>(mix(prevCol.rgb, intensity, a), 0.0);
  }
}
