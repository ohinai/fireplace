// Light for surfaces. Needs `F: Frame`, `bb` (blackbody table) and
// `lights: array<vec4<f32>>` (pairs of position, intensity from lights.wgsl).

const PI: f32 = 3.14159265;
const CANDLE_TEMP: f32 = 1850.0;

// Top of the fireplace opening above x (0 beside it): straight sides, then an arch.
fn openingTop(x: f32) -> f32 {
  let u = x / F.opening.x;
  if (abs(u) >= 1.0) { return 0.0; }
  return F.opening.y + (F.opening.z - F.opening.y) * sqrt(1.0 - u * u);
}

// Light passes between the firebox and the room only through the opening. (The fire lights the
// firebox and the wall face around the opening fully, as before; round a campfire nothing is in
// the way.)
fn throughOpening(p: vec3<f32>, lp: vec3<f32>) -> f32 {
  if (F.opening.x <= 0.0) { return 1.0; }
  let lightInside = lp.z < 0.0;
  // (A millimetre's leeway: the wall face round the opening lies in the plane z = 0, and where a
  // point on it is worked out from the depth buffer (relight.wgsl) it can land a hair either side.)
  if (lightInside && p.z <= 0.001) { return 1.0; }
  if (!lightInside && p.z > -0.01) { return 1.0; }
  let c = mix(p, lp, p.z / (p.z - lp.z));
  let inside = min(F.opening.x - abs(c.x), min(c.y, openingTop(c.x) - c.y));
  return smoothstep(-0.01, 0.03, inside);
}

struct Lit {
  diffuse: vec3<f32>,
  specular: vec3<f32>,
};

fn addLight(acc: ptr<function, Lit>, p: vec3<f32>, N: vec3<f32>, V: vec3<f32>, gloss: f32, lp: vec3<f32>, intensity: vec3<f32>) {
  let toLight = lp - p;
  let d2 = dot(toLight, toLight) + 0.004;
  let L = toLight * inverseSqrt(d2);
  let ndl = dot(N, L);
  if (ndl <= 0.0) { return; }
  let E = intensity * (ndl * throughOpening(p, lp) / d2);
  (*acc).diffuse += E;
  let H = normalize(L + V);
  (*acc).specular += E * pow(max(dot(N, H), 0.0), gloss) * (gloss + 8.0) / 8.0;
}

// How a lamp's light spreads (dir: from the lamp toward the lit point). A fabric shade sends
// pools of light up and down out of its open ends and glows softly through its sides; a
// lantern's glass lets light out all round except up into its cap and down into its base.
fn lampProfile(kind: f32, dir: vec3<f32>) -> f32 {
  if (kind < 0.5) {
    return 0.12 + 0.88 * smoothstep(0.5, 0.72, abs(dir.y));
  }
  return (1.0 - 0.85 * smoothstep(0.5, 0.85, dir.y)) * (1.0 - 0.7 * smoothstep(0.75, 0.95, -dir.y));
}

// Where the fire's light is bounced round the room from (roughly the middle of the fire).
fn fireCentre() -> vec3<f32> {
  if (F.opening.x <= 0.0) { return vec3<f32>(0.5 * (F.bed.x + F.bed.y), 0.3, 0.5 * (F.bed.z + F.bed.w)); }
  return vec3<f32>(0.0, 0.3, -0.1);
}

// Light from outside: the sky all round (more from above) and the moon, the sun or a window
// from one side. Inside the firebox only a little of it gets in.
fn outsideLight(p: vec3<f32>, N: vec3<f32>) -> vec3<f32> {
  let hemi = F.sky.rgb * (0.55 + 0.45 * N.y);
  let direct = F.sunColour.rgb * max(dot(N, F.sun.xyz), 0.0);
  var cavity = 1.0;
  // (Behind the plane of the opening by a millimetre: the wall face round it, in that plane, is
  // outside however its position is worked out; see throughOpening.)
  if (F.opening.x > 0.0 && p.z < -0.001 && abs(p.x) < 0.5 && p.y < 0.9) {
    cavity = mix(0.06, 0.6, smoothstep(-0.4, 0.0, p.z));
  }
  return (hemi + direct) * cavity;
}

// Outgoing light from a surface: the flames' lights, the coals, candles and lamps, light
// bounced around the room, light from outside, and the surface's own glow.
fn shade(p: vec3<f32>, N: vec3<f32>, albedo: vec3<f32>, spec: f32, gloss: f32, emission: vec3<f32>) -> vec3<f32> {
  let V = normalize(F.camPos - p);
  var lit = Lit(vec3<f32>(0.0), vec3<f32>(0.0));
  var total = vec3<f32>(0.0);
  for (var i = 0u; i < F.numLights; i++) {
    let intensity = lights[2u * i + 1u].rgb;
    total += intensity;
    addLight(&lit, p, N, V, gloss, lights[2u * i].xyz, intensity);
  }
  for (var i = 0u; i < 3u; i++) {
    let ember = F.embers[2u * i + 1u].rgb;
    if (ember.r + ember.g + ember.b <= 0.0) { continue; }
    addLight(&lit, p, N, V, gloss, F.embers[2u * i].xyz, ember);
    total += ember;
  }
  for (var i = 0u; i < 4u; i++) {
    let c = F.candles[i];
    if (c.w <= 0.0) { continue; }
    let candle = blackbody(CANDLE_TEMP) * c.w;
    addLight(&lit, p, N, V, gloss, c.xyz + vec3<f32>(0.0, 0.015, 0.0), candle);
    total += candle;
  }

  // Inside the firebox direct light dominates; out in the room, light bounced off the floor,
  // walls and ceiling is what shows the fireplace surround (more in a pale room), fading with
  // distance from the fire, though far less than the fire's own light does: it comes from
  // the whole room. The lamps' light is bounced round the room too. (Round a campfire there
  // is little to bounce it: it fades as fast as the fire's light.)
  let open = F.opening.x <= 0.0;
  let inRoom = select(smoothstep(-0.05, 0.05, p.z), 1.0, open);
  let fromFire = p - fireCentre();
  let spread = select(7.0, 2.5, open);
  let near = 1.0 / (1.0 + dot(fromFire, fromFire) / spread);
  var bounce = total * mix(0.05, 0.15 * F.opening.w * near, inRoom);
  for (var i = 0u; i < 2u; i++) {
    let lp = F.lamps[2u * i];
    let lc = F.lamps[2u * i + 1u].rgb;
    if (lc.r + lc.g + lc.b <= 0.0) { continue; }
    let dir = normalize(p - lp.xyz);
    addLight(&lit, p, N, V, gloss, lp.xyz, lc * lampProfile(lp.w, dir));
    let fromLamp = p - lp.xyz;
    bounce += lc * mix(0.02, 0.15 * F.opening.w, inRoom) / (1.0 + dot(fromLamp, fromLamp) / spread);
  }
  return albedo / PI * (lit.diffuse + bounce) + albedo * outsideLight(p, N) + spec * lit.specular / PI + emission;
}

// The sky's own light in direction d, without the Moon's disc or the Milky Way: a dark night sky,
// brighter and bluer by moonlight; the last light low where the Sun has set at dusk; blue by day.
// (It is also what far-off hills and mountains fade toward.)
fn skyGradient(d: vec3<f32>) -> vec3<f32> {
  let up = max(d.y, 0.0);
  let tod = F.sun.w;
  let sunDir = F.sunDir.xyz;
  var col: vec3<f32>;
  if (tod < 0.5) {
    col = mix(vec3<f32>(0.0016, 0.0022, 0.0042), vec3<f32>(0.0005, 0.0008, 0.0019), pow(up, 0.5));
    // Airglow: a faint green-grey band low down on a dark night.
    col += vec3<f32>(0.0004, 0.0007, 0.0004) * smoothstep(0.3, 0.0, up) * (1.0 - F.skyLook.z);
  } else if (tod < 1.5) {
    let toward = pow(max(dot(normalize(vec3<f32>(d.x, 0.0, d.z)), normalize(vec3<f32>(sunDir.x, 0.0, sunDir.z) + vec3<f32>(1e-5, 0.0, 0.0))), 0.0), 3.0);
    let horizon = mix(vec3<f32>(0.012, 0.014, 0.028), vec3<f32>(0.06, 0.028, 0.012), toward);
    col = mix(horizon, vec3<f32>(0.004, 0.008, 0.026), pow(up, 0.45));
  } else {
    col = mix(vec3<f32>(0.26, 0.3, 0.34), vec3<f32>(0.07, 0.13, 0.3), pow(up, 0.6));
    col += vec3<f32>(1.0, 0.9, 0.7) * 0.4 * pow(max(dot(d, sunDir), 0.0), 64.0);
  }
  // By moonlight the whole sky is lighter and bluer, most of all round the Moon. (Less so with
  // the starlight brought out: a deeper sky for the stars to show against.)
  let glow = F.skyLook.z * (1.0 - 0.3 * F.grade.y);
  col += glow * (vec3<f32>(0.0035, 0.0055, 0.011) * (0.7 + 0.3 * up) + vec3<f32>(0.005, 0.007, 0.011) * pow(max(dot(d, F.moon.xyz), 0.0), 6.0));
  return col;
}

// A surface as the eye sees it: lit, and out in the open, faded into the sky with distance (the
// far hills and the mountain).
fn seen(p: vec3<f32>, N: vec3<f32>, albedo: vec3<f32>, spec: f32, gloss: f32, emission: vec3<f32>) -> vec3<f32> {
  var colour = shade(p, N, albedo, spec, gloss, emission);
  if (F.opening.x <= 0.0) {
    let away = p - F.camPos;
    let haze = 1.0 - exp(-max(length(away) - 20.0, 0.0) / 380.0);
    colour = mix(colour, skyGradient(normalize(away)), haze);
  }
  return colour;
}
