// Eye adaptation: measures the average brightness of the frame (from the smallest bloom
// level) and eases the exposure toward it over a couple of seconds, within limits. When a fire
// burns down to embers the view slowly brightens, the way eyes adjust to a darkening room.
// adapt[0] = exposure multiplier, adapt[1] = measured log-average luminance.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var src: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> adapt: array<f32>;

// Average luminance at which no adjustment is made (a healthy fire).
const KEY: f32 = 0.006;

var<workgroup> acc: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li: u32) {
  let dims = textureDimensions(src);
  let n = dims.x * dims.y;
  var s = 0.0;
  for (var i = li; i < n; i += 256u) {
    let c = textureLoad(src, vec2<u32>(i % dims.x, i / dims.x), 0).rgb;
    s += log(max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-6));
  }
  acc[li] = s;
  workgroupBarrier();
  for (var stride = 128u; stride > 0u; stride = stride >> 1u) {
    if (li < stride) {
      acc[li] += acc[li + stride];
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let average = exp(acc[0] / f32(n));
    let wanted = clamp(sqrt(KEY / max(average, 1e-6)), F.adaptMin, F.adaptMax);
    let prev = adapt[0];
    let k = 1.0 - exp(-F.frameDt / 2.5);
    adapt[0] = select(mix(prev, wanted, k), wanted, prev <= 0.0);
    adapt[1] = average;
  }
}
