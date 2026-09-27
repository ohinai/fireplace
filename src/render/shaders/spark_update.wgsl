// Sparks: specks of glowing char thrown off hot wood (and in bursts when a log lands or the
// coals are blown on). They are carried by the simulated air, fall once they slow, and cool
// until they wink out.

struct SparkParams {
  dt: f32,
  rate: f32,          // sparks per second thrown off hot char, on average
  count: u32,         // number of spark slots
  frame: u32,
  burst: vec4<f32>,   // xyz centre, w radius
  burstVel: vec4<f32>, // xyz mean velocity, w random speed
  burstRange: vec4<u32>, // x first slot, y how many
  simOrigin: vec3<f32>,
  simH: f32,
  simDims: vec3<f32>,
  pad0: f32,
  boxMin: vec4<f32>,  // sparks leaving this box are gone (up the chimney, or high into the night); w: gravity (m/s2)
  boxMax: vec4<f32>,
};

@group(0) @binding(0) var<uniform> S: SparkParams;
@group(0) @binding(1) var<storage, read_write> sparks: array<Spark>;
@group(0) @binding(2) var<storage, read> logs: array<LogGPU>;
@group(0) @binding(3) var geoMap: texture_2d_array<f32>;
@group(0) @binding(4) var mapSamp: sampler;
@group(0) @binding(5) var gasVel: texture_3d<f32>;
@group(0) @binding(6) var linSamp: sampler;

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

fn rand(i: u32, k: u32) -> f32 {
  return f32(pcg(i * 9781u + k * 6271u + S.frame * 26699u)) * (1.0 / 4294967296.0);
}

fn randDir(i: u32, k: u32) -> vec3<f32> {
  let z = rand(i, k) * 2.0 - 1.0;
  let a = rand(i, k + 1u) * TAU;
  let r = sqrt(1.0 - z * z);
  return vec3<f32>(r * cos(a), z, r * sin(a));
}

fn airVelocity(p: vec3<f32>) -> vec3<f32> {
  let x = (p - S.simOrigin) / S.simH;
  if (any(x < vec3<f32>(0.0)) || any(x > S.simDims)) { return vec3<f32>(0.0, 0.6, 0.0); }
  let inv = 1.0 / (S.simDims + 1.0);
  return vec3<f32>(
    textureSampleLevel(gasVel, linSamp, (x + vec3<f32>(0.5, 0.0, 0.0)) * inv, 0.0).x,
    textureSampleLevel(gasVel, linSamp, (x + vec3<f32>(0.0, 0.5, 0.0)) * inv, 0.0).y,
    textureSampleLevel(gasVel, linSamp, (x + vec3<f32>(0.0, 0.0, 0.5)) * inv, 0.0).z);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= S.count) { return; }
  var sp = sparks[i];

  let inBurst = (i + S.count - S.burstRange.x) % S.count < S.burstRange.y;
  if (inBurst) {
    let d = randDir(i, 1u);
    sp.pos = S.burst.xyz + d * S.burst.w * rand(i, 3u);
    sp.vel = S.burstVel.xyz + vec3<f32>(d.x, abs(d.y), d.z) * S.burstVel.w * (0.3 + rand(i, 4u));
    sp.temp = 1050.0 + 300.0 * rand(i, 5u);
    sp.life = 0.6 + 2.0 * rand(i, 6u);
  } else if (sp.life <= 0.0 && rand(i, 7u) < S.rate * S.dt / f32(S.count) * f32(MAX_LOGS) / 12.0) {
    // Thrown off a random spot on a random log, if that spot is glowing char. (The rate was set
    // when there were twelve slots for logs: as many tries per slot now as then.)
    let k = min(u32(rand(i, 8u) * f32(MAX_LOGS)), MAX_LOGS - 1u);
    let L = logs[k];
    if (L.a.w > 0.5) {
      let uv = vec2<f32>(rand(i, 9u), rand(i, 10u));
      let geo = textureSampleLevel(geoMap, mapSamp, uv, i32(k), 0.0);
      if (geo.y > 850.0 && geo.z > 0.5 && geo.x > 0.0) {
        let theta = uv.y * TAU;
        let dir = L.e1.xyz * cos(theta) + L.e2.xyz * sin(theta);
        sp.pos = L.a.xyz + L.axis.xyz * (uv.x * L.axis.w) + dir * (geo.x + 0.002);
        sp.vel = dir * (0.3 + 0.9 * rand(i, 11u)) + vec3<f32>(0.0, 0.4, 0.0);
        sp.temp = geo.y + 150.0 + 150.0 * rand(i, 12u);
        sp.life = 0.8 + 2.2 * rand(i, 13u);
      }
    }
  }

  if (sp.life > 0.0) {
    let dt = S.dt;
    // Light flakes of char: dragged along by the air, pulled down a little by gravity.
    sp.vel += (airVelocity(sp.pos) - sp.vel) * (1.0 - exp(-dt / 0.15)) + vec3<f32>(0.0, -2.5 * S.boxMin.w / 9.81, 0.0) * dt;
    sp.pos += sp.vel * dt;
    sp.temp -= (sp.temp - 450.0) * 0.8 * dt;
    sp.life -= dt;
    let outOfBox = any(sp.pos < S.boxMin.xyz) || any(sp.pos > S.boxMax.xyz);
    if (outOfBox || sp.temp < 760.0) { sp.life = 0.0; }
  }
  sparks[i] = sp;
}
