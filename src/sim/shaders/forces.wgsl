// Sources, combustion and body forces. Dispatched over velocity texels: each thread updates the
// three faces stored in its texel and, when it is a real cell, the scalars of that cell.
//
// Combustion model (per cell, per step):
//   wood gas + oxygen -> heat + soot, only where the gas is hot enough to ignite
//   soot + oxygen -> heat, only where it is very hot (this is what ends a flame)
//   everything radiates heat away, soot-laden gas much more so
//   wood gas that cools before it can burn condenses into white smoke
// Flames are visible because hot soot glows; see the renderer.
//
// The logs' surfaces (from the log model) give off wood gas, steam and CO and exchange heat
// with the gas next to them; so do the coals, where there are any (from the bed map). Burning
// firelighters and matches give off vapour that burns. Also writes, per cell, how fast the gas
// is expanding (thermal expansion, off by default), which the pressure solve turns into flow.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var velIn: texture_3d<f32>;
@group(0) @binding(2) var scalIn: texture_3d<f32>;
@group(0) @binding(3) var auxIn: texture_3d<f32>;
@group(0) @binding(4) var<storage, read> confine: array<vec4<f32>>;
@group(0) @binding(5) var<storage, read> solid: array<u32>;
@group(0) @binding(6) var<storage, read> logs: array<LogGPU>;
@group(0) @binding(7) var velOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(8) var scalOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(9) var auxOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(10) var<storage, read_write> expand: array<f32>;
@group(0) @binding(11) var geoMap: texture_2d_array<f32>;
@group(0) @binding(12) var fluxMap: texture_2d_array<f32>;
@group(0) @binding(13) var mapSamp: sampler;
@group(0) @binding(14) var bedMap: texture_2d<f32>;
@group(0) @binding(15) var clampSamp: sampler;

// Thickness (m) of the gas layer that surfaces feed, so the fire is the same size at any
// grid resolution (at least: a coarse grid cannot hold it in less than a cell or so).
override SURFACE_LAYER: f32 = 0.011;
// Soot made per wood gas burnt, as a share of the usual: on a coarse grid the flames are smeared
// thick and long, and glow for longer than a fine grid's thin sheets do.
override SOOT_SCALE: f32 = 1.0;
// How much more the gas radiates away than the cell-mean temperature says (see FireSim.ts).
override COOL_SCALE: f32 = 1.0;
const BED_LAYER: f32 = 0.008;
// Densities (kg/m3) of the gases the logs give off, at the temperatures they leave at.
const RHO_WOODGAS: f32 = 0.5;
const RHO_CO: f32 = 0.35;
const RHO_STEAM: f32 = 0.45;
// Share of steam that shows as white vapour.
const STEAM_SMOKE: f32 = 0.3;
// Share of the soot burnt off at a flame's tips that is left as smoke, and how fast smoke burns
// in hot air next to soot.
const SOOT_SMOKE: f32 = 0.15;
const SMOKE_BURN: f32 = 0.25;
// Share of the gas from wood too cool to flame that comes off as tar (white smoke).
const TAR: f32 = 0.6;
// CO: burns once hotter than wood gas, with 2.4 volumes of air rather than 4, giving about as
// much heat per volume.
const CO_IGNITE: f32 = 900.0;
const CO_STOICH: f32 = 2.4;
const CO_HEAT: f32 = 1.2;

fn noiseComp(p: vec3<f32>, a: u32) -> f32 {
  var o = vec3<f32>(0.0);
  if (a == 1u) { o = vec3<f32>(31.7, 11.3, 5.9); }
  if (a == 2u) { o = vec3<f32>(-7.1, 23.9, 47.3); }
  return valueNoise(p + o) * 2.0 - 1.0;
}

// ---- Faces ------------------------------------------------------------------------------------

fn faceForce(t: vec3<i32>, a: u32, v0: f32) -> f32 {
  let ca = t - axisI(a);
  var T = 0.0;
  var conf = 0.0;
  var n = 0.0;
  if (inGrid(ca)) {
    T += textureLoad(scalIn, ca, 0).x;
    conf += confine[cellIndex(ca)][a];
    n += 1.0;
  }
  if (inGrid(t)) {
    T += textureLoad(scalIn, t, 0).x;
    conf += confine[cellIndex(t)][a];
    n += 1.0;
  }
  T /= n;
  conf /= n;

  let dt = P.dt;
  let p = facePos(t, a);
  var v = v0;

  // Buoyancy: hot gas is lighter than the room air around it (density ~ 1/T). (Without
  // gravity, nothing rises: a flame in orbit is a round, dim ball, fed only by diffusion.)
  if (a == 1u) {
    v += P.buoyancy * P.gravity * (T - P.tAmb) / T * dt;
  }
  v += conf * dt;

  // Rising turbulence in hot gas: flicker finer than the grid can develop on its own.
  let hot = smoothstep(450.0, 1100.0, T);
  let q = p * P.h * 22.0 + vec3<f32>(0.0, -P.time * 1.5, P.time * 0.3);
  v += P.turbulence * hot * noiseComp(q, a) * dt;

  // Blowing on the fire (pointer drag).
  if (P.blowVel.w > 0.0) {
    let d = p - P.blowPos.xyz;
    let w = exp(-dot(d, d) / (P.blowPos.w * P.blowPos.w)) * P.blowVel.w;
    v = mix(v, P.blowVel[a], clamp(w * 0.35, 0.0, 1.0));
  }

  v = v / (1.0 + P.damping * dt);
  return clamp(v, -8.0, 8.0);
}

// ---- Cells ------------------------------------------------------------------------------------

// Solids copy the average of their fluid neighbours, so interpolation near a surface neither
// gains nor loses anything. Heat and gas from surfaces are added explicitly.
fn solidAverage(tex: texture_3d<f32>, c: vec3<i32>, fallback: vec4<f32>) -> vec4<f32> {
  var acc = vec4<f32>(0.0);
  var count = 0.0;
  for (var a = 0u; a < 3u; a++) {
    for (var sgn = -1; sgn <= 1; sgn += 2) {
      let n = c + axisI(a) * sgn;
      if (inGrid(n) && solid[cellIndex(n)] == SOLID_NONE) {
        acc += textureLoad(tex, n, 0);
        count += 1.0;
      }
    }
  }
  return select(fallback, acc / max(count, 1.0), count > 0.0);
}

fn updateCell(c: vec3<i32>) {
  let i = cellIndex(c);
  if (solid[i] != SOLID_NONE) {
    textureStore(scalOut, c, solidAverage(scalIn, c, ambient()));
    textureStore(auxOut, c, solidAverage(auxIn, c, vec4<f32>(0.0)));
    expand[i] = 0.0;
    return;
  }

  let p = vec3<f32>(c) + 0.5;
  let wp = cellWorld(p);
  let dt = P.dt;
  let s = textureLoad(scalIn, c, 0);
  var T = s.x;
  let T0 = T;
  var fuel = max(s.y, 0.0);
  var ox = clamp(s.z, 0.0, 1.0);
  var soot = max(s.w, 0.0);
  let a = textureLoad(auxIn, c, 0);
  var smoke = max(a.x, 0.0);
  var co = max(a.y, 0.0);

  // Log surfaces: wood gas from the wood, CO from the glowing char, steam from drying wood, and
  // heat exchanged with the surface by convection.
  for (var k = 0u; k < MAX_LOGS; k++) {
    let L = logs[k];
    if (L.a.w < 0.5) { continue; }
    let loc = logLocal(L, wp);
    if (loc.s < 0.0 || loc.s > L.axis.w || loc.r > L.e1.w + SURFACE_LAYER) { continue; }
    let uv = logMapUV(L, loc.s, loc.theta);
    let geo = textureSampleLevel(geoMap, mapSamp, uv, i32(k), 0.0);
    let d = loc.r - geo.x;
    if (d < 0.0 || d > SURFACE_LAYER || geo.x <= 0.0) { continue; }
    let w = 2.0 * (1.0 - d / SURFACE_LAYER) / SURFACE_LAYER; // integrates to 1 across the layer
    let flux = textureSampleLevel(fluxMap, mapSamp, uv, i32(k), 0.0);
    let fuelIn = max(flux.x, 0.0) / RHO_WOODGAS * w;
    let coIn = max(flux.z, 0.0) / RHO_CO * w;
    let steamIn = max(flux.y, 0.0) / RHO_STEAM * w;
    let total = fuelIn + coIn + steamIn;
    let added = min(total * dt, 0.5);
    let share = added / max(total, 1e-9);
    fuel = min(fuel + fuelIn * share, 1.0);
    // Wood pyrolysing too cool to flame (a log just put on, a smouldering end) gives off much of
    // its gas as tar, which condenses into white smoke as soon as it meets the air; flaming
    // wood, hotter, sends out gas that burns clean. (The tar still counts as fuel: what reaches
    // a flame burns there all the same. The smoke shows where it went.)
    smoke += fuelIn * share * TAR * smoothstep(760.0, 560.0, geo.y);
    co = min(co + coIn * share, 1.0);
    ox *= 1.0 - added; // new gas pushes air out of the cell
    // Oxygen the glowing char takes straight from the air (0.57 kg O2 per kg CO it makes).
    let o2Density = 0.23 * 1.2 * P.tAmb / max(T, P.tAmb);
    ox = max(ox - max(flux.z, 0.0) * 0.57 / o2Density * w * dt, 0.0);
    smoke += steamIn * share * STEAM_SMOKE;
    T = mix(T, geo.y, added);
    let rhoCp = 1200.0 * P.tAmb / max(T, P.tAmb);
    T += (geo.y - T) * (1.0 - exp(-15.0 * w / rhoCp * dt));
  }

  // Coal bed: where there are hot coals they heat the air just above them and give off CO.
  let bedLayer = BED_LAYER / P.h;
  if (p.x > P.ember.x && p.x < P.ember.y && p.z > P.ember.z && p.z < P.ember.w && p.y < P.emberHeight + bedLayer) {
    let uv = vec2<f32>((p.x - P.ember.x) / (P.ember.y - P.ember.x), (p.z - P.ember.z) / (P.ember.w - P.ember.z));
    let bed = textureSampleLevel(bedMap, clampSamp, uv, 0.0); // T, CO, depth, ash
    let w = 1.0 - clamp((p.y - P.emberHeight) / bedLayer, 0.0, 1.0);
    let glow = 0.75 + 0.5 * valueNoise(wp * 25.0 + vec3<f32>(0.0, P.time * 0.2, 0.0));
    let cover = smoothstep(0.003, 0.22, bed.z); // (a full bed has depth 1)
    let hot = bed.x * (1.0 - 0.15 * bed.w) * glow; // under ash the coals warm the air less
    T = mix(T, max(T, hot), clamp(w * 2.5 * dt * cover, 0.0, 1.0));
    let added = min(bed.y * w * glow * dt, 1.0);
    co = min(co + added, 1.0);
    ox *= 1.0 - added;
  }

  // Firelighters and matches. Some of the vapour burns right where it comes off the burning
  // surface: heat (up to flame temperature) and glowing soot, using up the air there. The rest
  // rises as vapour, hot enough to burn, and burns in the flame above.
  for (var b = 0u; b < 4u; b++) {
    let B = P.burners[b];
    if (B.src.x <= 0.0) { continue; }
    let q = (p - B.pos.xyz) / B.pos.w;
    let d2 = dot(q, q);
    if (d2 >= 1.0) { continue; }
    let w = 1.0 - d2;
    let burnt = min(B.src.z * w * dt, ox / P.stoich);
    let dT = min(burnt * P.heatRelease, max(1550.0 - T, 0.0));
    T += dT;
    ox -= dT / P.heatRelease * P.stoich;
    soot += dT / P.heatRelease * P.sootYield;
    let added = min(B.src.x * w * dt, 0.5);
    fuel = min(fuel + added, 1.0);
    ox *= 1.0 - added;
    T = max(T, mix(T, B.src.y, w));
  }

  // Combustion of wood gas: a sooty, yellow flame.
  let ignite = smoothstep(P.tIgnite - 60.0, P.tIgnite + 60.0, T);
  var burn = P.burnRate * fuel * ox * ignite * dt;
  burn = min(burn, min(fuel, ox / P.stoich));
  fuel -= burn;
  ox -= burn * P.stoich;
  T += burn * P.heatRelease;
  soot += burn * P.sootYield * SOOT_SCALE;

  // CO from glowing char and coals burns only where it is hotter, needs less air, and makes no
  // soot: the faint blue flames that flicker over embers once the wood gas is spent.
  let igniteCO = smoothstep(CO_IGNITE - 80.0, CO_IGNITE + 80.0, T);
  var burnCO = P.burnRate * co * ox * igniteCO * dt;
  burnCO = min(burnCO, min(co, ox / CO_STOICH));
  co -= burnCO;
  ox -= burnCO * CO_STOICH;
  T += burnCO * P.heatRelease * CO_HEAT;

  let hotAir = ox * smoothstep(800.0, 1300.0, T);
  let sootOx = min(soot, P.sootBurn * soot * hotAir * dt);
  soot -= sootOx;
  T += sootOx * 200.0;
  // Smoke carried back through hot air burns off too, but slower than soot; and a little of the
  // soot a flame burns off is left as smoke (fine ash and tar that never quite burn): the thin
  // haze that rises off the flames of any wood fire into the chimney.
  smoke -= min(smoke, SMOKE_BURN * P.sootBurn * smoke * hotAir * dt);
  smoke += SOOT_SMOKE * sootOx;

  // Wood gas that cools before it finds the flame condenses into white smoke.
  let condense = fuel * P.smokeYield * smoothstep(650.0, 450.0, T) * dt;
  fuel -= condense;
  smoke += condense;

  let tk = T * 0.001;
  let ta = P.tAmb * 0.001;
  T -= P.cooling * COOL_SCALE * (1.0 + 6.0 * soot) * (tk * tk * tk * tk - ta * ta * ta * ta) * dt;
  T = clamp(T, P.tAmb, 2300.0);
  soot = soot / (1.0 + 0.1 * dt);
  smoke = smoke / (1.0 + P.smokeDecay * dt);

  // Gas at constant pressure expands in proportion to its temperature: dV/V = dT/T. (The
  // volume of gas the wood releases is left out: it is tiny next to the chimney's draw, and
  // released into crevices between logs it only pressurises pockets of trapped air.)
  let dilation = P.expansion * (T - T0) / (0.5 * (T + T0) * dt);
  expand[i] = dilation * P.h;

  textureStore(scalOut, c, vec4<f32>(T, fuel, ox, soot));
  textureStore(auxOut, c, vec4<f32>(smoke, co, 0.0, 0.0));
}

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid > P.dims)) { return; }
  let t = vec3<i32>(gid);

  let vin = textureLoad(velIn, t, 0);
  var vel = vec4<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    if (!faceValid(t, a)) { continue; }
    let kind = faceKind(t, a);
    if (kind == FACE_FLUE) {
      vel[a] = P.flueSpeed;
    } else if (kind == FACE_FREE) {
      vel[a] = faceForce(t, a, vin[a]);
    } else {
      vel[a] = solidFaceVelocity(t, a);
    }
  }
  textureStore(velOut, t, vel);

  if (all(gid < P.dims)) {
    updateCell(t);
  }
}
