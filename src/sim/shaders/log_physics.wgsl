// Burning-wood physics shared by the log passes. Units: SI (m, s, kg, K, W).
// Voxel state is (T, moisture, wood, char): temperature and the mass per volume of water,
// unburnt dry wood and charcoal.

struct LogStep {
  dt: f32,         // log time step (s); larger than real time when burning is sped up
  roomTemp: f32,
  wallTemp: f32,   // firebox walls, which warm up over the evening (round a campfire: stones, ground)
  skyTemp: f32,    // what the open sky radiates like (campfire)
  bedTop: f32,     // height of the coal bed (m)
  flameGain: f32,  // scales flame radiation reaching the logs
  radBlocks: u32,
  enclosure: u32,  // 0: a fireplace; 1: in the open air
  bedRect: vec4<f32>, // coal bed extent: x min, x max, z min, z max (its temperatures: the bed map)
  firebox: vec4<f32>, // front half width, back half width, depth, height
  opening: vec4<f32>, // fireplace opening: half width, top, where its arch starts
  simOrigin: vec3<f32>,
  simH: f32,
  simDims: vec3<f32>,
  cooling: f32,    // the gas's radiative cooling rate (as in the solver), for flames right by a surface
};

const SIGMA: f32 = 5.670e-8;     // Stefan-Boltzmann
const LATENT: f32 = 2.26e6;      // J/kg to boil water
const WATER_CP: f32 = 4186.0;
// Wood -> char + wood gas, single-step Arrhenius (fastest around 650-750 K when heated at a
// few kelvin per second).
const PYRO_A: f32 = 2.0e8;       // 1/s
const PYRO_E_R: f32 = 15035.0;   // activation energy / gas constant (K)
const PYRO_HEAT: f32 = 2.0e5;    // J/kg absorbed
// Glowing char: surface reaction, limited by chemistry when cool and by oxygen reaching the
// surface when hot. Moving air brings more oxygen (why blowing on embers makes them glow).
const CHAR_A: f32 = 3.0e3;       // kg/m2/s
const CHAR_E_R: f32 = 10000.0;   // K
const CHAR_DIFF: f32 = 0.002;    // kg/m2/s in still air
const CHAR_HEAT: f32 = 1.2e7;    // J/kg released at the surface (burning partly to CO)
const CO_PER_CHAR: f32 = 1.17;   // kg of CO given off per kg of char burned
const ASH_FRACTION: f32 = 0.03;  // kg of ash left per kg of char burned
const GRAIN: f32 = 2.0;          // heat conducts faster along the grain
const WOODGAS_HEAT: f32 = 1.5e7; // J/kg released when wood gas burns
const FLAME_FEEDBACK: f32 = 0.33; // share of that a flame sends back into the wood it burns off
const FLAME_FEEDBACK_MAX: f32 = 40000.0; // W/m2: the most a wood flame this size sends back
const FLAME_TEMP: f32 = 1350.0;  // K
const SMALL_FLAME: f32 = 0.6;    // how much of that a lone flamelet sends back (no flame beside it yet)
const FLAME_FLUX_MAX: f32 = 120000.0; // W/m2: the most flames radiate onto wood in their midst
// Ash on glowing char (or coals): keeps air from it (it burns slower) and radiates from its
// cooler surface. (Must match CoalBed.ts.)
const ASH_SLOWS: f32 = 0.55;
const ASH_COOLS: f32 = 0.18;

fn heatCapacity(st: vec4<f32>) -> f32 {
  let cw = clamp(1100.0 + 3.0 * (st.x - 273.0), 1100.0, 2500.0);
  let cc = clamp(700.0 + 0.9 * (st.x - 273.0), 700.0, 1800.0);
  return st.z * cw + st.w * cc + st.y * WATER_CP + 30.0;
}

fn conductivity(st: vec4<f32>, L: LogGPU) -> f32 {
  let wf = st.z / L.wood.x;
  let cf = st.w / (L.wood.y * L.wood.x) * CHAR_SHRINK;
  let kw = 0.14 + 0.0005 * st.y;                     // wet wood conducts better
  let kc = 0.08 + 5.0e-11 * st.x * st.x * st.x;      // radiation across char pores when hot
  return (wf * kw + cf * kc) / max(wf + cf, 1e-4);
}
