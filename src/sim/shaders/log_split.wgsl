// A log breaking in two: each piece gets its share of the slices along the log, stretched over
// its own voxel grid. The source log was copied to `srcState` / `srcProd` beforehand.

struct SplitParams {
  dstSlot: u32,
  begin: f32, // first slice of the source that goes into this piece
  end: f32,   // end of its slices (exclusive)
  pad: f32,
};

@group(0) @binding(0) var<uniform> SP: SplitParams;
@group(0) @binding(1) var<storage, read> srcState: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> srcProd: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> state: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> prod: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= LOG_NX || gid.y >= LOG_NX || gid.z >= LOG_NS) { return; }
  let s = SP.begin + (f32(gid.z) + 0.5) * (SP.end - SP.begin) / f32(LOG_NS) - 0.5;
  let lo = clamp(floor(s), SP.begin, SP.end - 1.0);
  let hi = min(lo + 1.0, SP.end - 1.0);
  let f = clamp(s - lo, 0.0, 1.0);
  let i0 = gid.x + LOG_NX * (gid.y + LOG_NX * u32(lo));
  let i1 = gid.x + LOG_NX * (gid.y + LOG_NX * u32(hi));
  let dst = voxelIndex(SP.dstSlot, gid.x, gid.y, gid.z);
  state[dst] = mix(srcState[i0], srcState[i1], f);
  prod[dst] = mix(srcProd[i0], srcProd[i1], f);
}
