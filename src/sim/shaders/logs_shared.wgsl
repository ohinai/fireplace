// Logs: shared by the solver, the log model and the renderer. Needs no bindings.
//
// Each log has a local frame: `axis` runs from end A to end B, and (e1, e2) span its cross
// section. Position along the log is s in [0, length]; around it, theta = atan2(y, x) with
// x = along e1 and y = along e2.
//
// Log interior: a voxel grid of LOG_NX x LOG_NX cells across (covering [-half, half]^2, with
// half = e1.w) and LOG_NS slices along the log.
//
// Surface map: LOG_NS x MAP_NT texels per log (u along the log, v around it), one layer per
// log, holding the surface radius and what the surface is doing.

const MAX_LOGS: u32 = 24u;
const LOG_NX: u32 = 24u;
const LOG_NS: u32 = 48u;
const MAP_NT: u32 = 32u;
const LOG_VOXELS: u32 = 27648u; // LOG_NX * LOG_NX * LOG_NS
const TAU: f32 = 6.2831853;

struct LogGPU {
  a: vec4<f32>,    // end A (world, m); w = 1 while the log exists
  axis: vec4<f32>, // unit axis from A to B; w = length (m)
  e1: vec4<f32>,   // unit cross-section axis; w = half size of the voxel box (m)
  e2: vec4<f32>,   // unit cross-section axis (axis x e1); w = original radius (m)
  wood: vec4<f32>, // dry density (kg/m3), char yield, initial moisture (kg/m3), current mean radius (m)
  look: vec4<f32>, // bark colour (rgb), random seed
  vel: vec4<f32>,  // velocity of the middle of the log (m/s); w = where end A was on the whole log (m)
  spin: vec4<f32>, // angular velocity (rad/s)
};

struct LogLocal {
  s: f32,
  x: f32,
  y: f32,
  r: f32,
  theta: f32,
};

fn logLocal(L: LogGPU, p: vec3<f32>) -> LogLocal {
  let rel = p - L.a.xyz;
  let x = dot(rel, L.e1.xyz);
  let y = dot(rel, L.e2.xyz);
  return LogLocal(dot(rel, L.axis.xyz), x, y, length(vec2<f32>(x, y)), atan2(y, x));
}

fn logWorld(L: LogGPU, s: f32, x: f32, y: f32) -> vec3<f32> {
  return L.a.xyz + L.axis.xyz * s + L.e1.xyz * x + L.e2.xyz * y;
}

// Velocity of the log's wood at world point p (logs roll, fall and get carried about).
fn logVelocity(L: LogGPU, p: vec3<f32>) -> vec3<f32> {
  return L.vel.xyz + cross(L.spin.xyz, p - (L.a.xyz + L.axis.xyz * (0.5 * L.axis.w)));
}

// Surface-map coordinates: u along the log, v around it.
fn logMapUV(L: LogGPU, s: f32, theta: f32) -> vec2<f32> {
  return vec2<f32>(clamp(s / L.axis.w, 0.0, 1.0), fract(theta / TAU));
}

fn voxelIndex(log: u32, i: u32, j: u32, k: u32) -> u32 {
  return log * LOG_VOXELS + i + LOG_NX * (j + LOG_NX * k);
}

fn voxelSize(L: LogGPU) -> f32 {
  return 2.0 * L.e1.w / f32(LOG_NX);
}

// Char takes up less room than the wood it came from.
const CHAR_SHRINK: f32 = 0.8;

// How much of a voxel is still solid (1 = untouched wood). State is (T, moisture, wood, char).
fn voxelFill(st: vec4<f32>, L: LogGPU) -> f32 {
  return st.z / L.wood.x + st.w / (L.wood.y * L.wood.x) * CHAR_SHRINK;
}

// Fraction of what is left that is char (0 = wood, 1 = charcoal).
fn voxelChar(st: vec4<f32>, L: LogGPU) -> f32 {
  let w = st.z / L.wood.x;
  let c = st.w / (L.wood.y * L.wood.x) * CHAR_SHRINK;
  return c / max(w + c, 1e-4);
}
