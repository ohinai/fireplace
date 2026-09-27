// Log interiors: one thread per voxel. Heat conducts between neighbours (faster along the
// grain) and enters or leaves through exposed faces using the surface pass's flux. Then:
//   water boils off at 100 C, holding the temperature there until the wood is dry,
//   wood breaks down into char and wood gas once it passes ~500 K,
//   char at the surface burns away, leaving a little ash.

@group(0) @binding(0) var<uniform> LP: LogStep;
@group(0) @binding(1) var<storage, read> logs: array<LogGPU>;
@group(0) @binding(2) var<storage, read> stateIn: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> stateOut: array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> prod: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> surf: array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> look: array<vec4<f32>>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= LOG_NX || gid.y >= LOG_NX || gid.z >= LOG_NS * MAX_LOGS) { return; }
  let log = gid.z / LOG_NS;
  let k = gid.z % LOG_NS;
  let L = logs[log];
  let idx = voxelIndex(log, gid.x, gid.y, k);
  let st = stateIn[idx];
  if (L.a.w < 0.5) {
    stateOut[idx] = st;
    return;
  }
  var ash = prod[idx].z;
  let fill = voxelFill(st, L);
  if (fill < 0.02) {
    stateOut[idx] = st;
    prod[idx] = vec4<f32>(0.0, 0.0, ash, 0.0);
    look[idx] = vec4<f32>(st.x, 1.0, fill, ash);
    return;
  }

  let dx = voxelSize(L);
  let ds = L.axis.w / f32(LOG_NS);
  let dt = LP.dt;
  var T = st.x;
  var M = st.y;
  var W = st.z;
  var C = st.w;
  let cap = heatCapacity(st);
  let k0 = conductivity(st, L);

  // Which surface-map column this voxel belongs to.
  let x = (f32(gid.x) + 0.5) * dx - L.e1.w;
  let y = (f32(gid.y) + 0.5) * dx - L.e1.w;
  let t = min(u32(fract(atan2(y, x) / TAU) * f32(MAP_NT)), MAP_NT - 1u);
  let col = surf[(log * LOG_NS + k) * MAP_NT + t]; // net flux, its slope, char burn, surface T

  var sumG = 0.0;
  var sumGT = 0.0;
  var exposure = 0.0; // exposed face area per volume (1/m)
  let base = vec3<i32>(vec3<u32>(gid.x, gid.y, k));
  for (var n = 0u; n < 6u; n++) {
    let ax = n / 2u;
    var o = vec3<i32>(0);
    o[ax] = select(-1, 1, (n & 1u) == 1u);
    let q = base + o;
    let h = select(dx, ds, ax == 2u);
    var nst = vec4<f32>(0.0);
    var nf = 0.0;
    if (all(q >= vec3<i32>(0)) && q.x < i32(LOG_NX) && q.y < i32(LOG_NX) && q.z < i32(LOG_NS)) {
      nst = stateIn[voxelIndex(log, u32(q.x), u32(q.y), u32(q.z))];
      nf = voxelFill(nst, L);
    }
    if (nf < 0.5) {
      exposure += 1.0 / h;
    } else {
      let kn = conductivity(nst, L);
      let gk = 2.0 * k0 * kn / (k0 + kn) * select(1.0, GRAIN, ax == 2u) / (h * h);
      sumG += gk;
      sumGT += gk * nst.x;
    }
  }

  // Implicit in this voxel's temperature, so a nearly burnt-out voxel (tiny heat capacity)
  // cannot overshoot. Surface flux is linearised: q(T) = qNet - slope * (T - Ts).
  let a = cap / dt;
  T = (a * T + sumGT + exposure * (col.x + col.y * col.w)) / (a + sumG + exposure * col.y);
  // That line is only good near the surface's temperature: a sliver about to burn through (it
  // holds almost no heat) running much hotter than that would glow away far more than it says.
  // Once more, with the glow's slope taken as the secant out to the sliver's own temperature.
  if (exposure > 0.0 && fill < 0.3 && T > col.w + 50.0) {
    let s = col.w;
    let glow = 0.95 * SIGMA * (T * T * T + T * T * s + T * s * s - 3.0 * s * s * s);
    let slope = col.y + glow;
    T = (a * st.x + sumGT + exposure * (col.x + slope * col.w)) / (a + sumG + exposure * slope);
  }
  T = clamp(T, 250.0, 2200.0);

  // Drying: heat above 100 C goes into boiling water off first.
  var steam = 0.0;
  if (M > 0.0 && T > 373.15) {
    let c = heatCapacity(vec4<f32>(T, M, W, C));
    let evap = min(M, (T - 373.15) * c / LATENT);
    M -= evap;
    T -= evap * LATENT / c;
    steam = evap / dt;
  }

  // Pyrolysis: wood -> char + wood gas.
  var volatiles = 0.0;
  if (W > 0.0 && T > 450.0) {
    let rate = PYRO_A * exp(-PYRO_E_R / T);
    let dW = W * (1.0 - exp(-rate * dt));
    W -= dW;
    C += L.wood.y * dW;
    T -= PYRO_HEAT * dW / heatCapacity(vec4<f32>(T, M, W, C));
    volatiles = (1.0 - L.wood.y) * dW / dt;
  }

  // Char burning at exposed faces (its heat is already in the surface flux).
  if (exposure > 0.0 && col.z > 0.0 && C > 0.0) {
    let burnt = min(C, col.z * exposure * dt);
    C -= burnt;
    ash += ASH_FRACTION * burnt;
  }

  let next = vec4<f32>(T, M, W, C);
  stateOut[idx] = next;
  // (w: the moisture content, water per dry wood, for the moisture view)
  prod[idx] = vec4<f32>(volatiles, steam, ash, M / L.wood.x);
  look[idx] = vec4<f32>(T, voxelChar(next, L), voxelFill(next, L), ash);
}
