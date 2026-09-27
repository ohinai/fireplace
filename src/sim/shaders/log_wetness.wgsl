// Makes the logs on the fire wetter or drier (Science), in place: the water left in each log is
// scaled by that log's factor, so whatever the fire has dried out (the char, the dried rim) stays
// dry and the rest takes the new moisture.

@group(0) @binding(0) var<uniform> factors: array<vec4<f32>, MAX_LOGS / 4u>; // one for each log slot
@group(0) @binding(1) var<storage, read_write> state: array<vec4<f32>>; // T, water, wood, char

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= MAX_LOGS * LOG_VOXELS) { return; }
  let slot = i / LOG_VOXELS;
  state[i].y *= factors[slot / 4u][slot % 4u];
}
