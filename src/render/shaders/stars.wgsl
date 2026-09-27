// The stars and planets, as points of light on the dome of the sky, and the lines of the
// constellations. Stars come from the catalogue as J2000 directions; F.starsToWorld turns them
// into the sky over the scene at the moment shown. Near the horizon they are lifted a little by
// refraction, dimmed by the thicker air, and twinkle more; the faintest ones fade out as the sky
// brightens (moonlight, dusk). Planets shine steadily.

@group(0) @binding(0) var<uniform> F: Frame;

fn starsToWorld(v: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(dot(F.starsToWorld[0].xyz, v), dot(F.starsToWorld[1].xyz, v), dot(F.starsToWorld[2].xyz, v));
}

// Where the line of sight along d meets the dome of the sky (centred on the origin).
fn onDome(d: vec3<f32>) -> vec3<f32> {
  let R = F.skyLook.w * 0.995;
  let o = F.camPos;
  let b = dot(o, d);
  let c = dot(o, o) - R * R;
  return o + d * (-b + sqrt(max(b * b - c, 0.0)));
}

// Refraction (radians) lifting something at true altitude alt: half a degree at the horizon.
fn refraction(alt: f32) -> f32 {
  let h = max(degrees(alt), -1.0);
  return radians(1.02 / tan(radians(h + 10.3 / (h + 5.11))) / 60.0) * clamp((degrees(alt) + 5.0) / 4.0, 0.0, 1.0);
}

// Three random numbers for a star (its twinkle).
fn starHash(i: u32) -> vec3<f32> {
  var v = vec3<u32>(i, 7u, 11u) * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3<u32>(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return vec3<f32>(v) * (1.0 / 4294967296.0);
}

struct StarOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) corner: vec2<f32>,
  @location(1) colour: vec3<f32>,
};

const STAR_GAIN: f32 = 5.0;

@vertex
fn vsStar(@builtin(vertex_index) vi: u32, @builtin(instance_index) inst: u32, @location(0) star: vec4<f32>, @location(1) look: vec4<f32>) -> StarOut {
  var o: StarOut;
  o.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0); // (off screen unless it shows)
  var d = normalize(starsToWorld(star.xyz));
  if (look.w > 0.5) { d = normalize(star.xyz); } // planets come in world directions, refraction and all
  var alt = asin(clamp(d.y, -1.0, 1.0));
  if (look.w < 0.5) {
    let raised = alt + refraction(alt);
    let level = normalize(vec3<f32>(d.x, 0.0, d.z) + vec3<f32>(1e-6, 0.0, 0.0));
    d = level * cos(raised) + vec3<f32>(0.0, sin(raised), 0.0);
    alt = raised;
  }
  if (alt < -0.005) { return o; }
  // More air to look through low down: dimmer (0.2 magnitudes an airmass).
  let airmass = 1.0 / (sin(max(alt, 0.0)) + 0.15 * pow(degrees(max(alt, 0.0)) + 3.885, -1.253));
  let mag = star.w + 0.2 * (min(airmass, 40.0) - 1.0);
  // Starlight brings out fainter stars than the eye would see (more so by moonlight, which hides
  // most of them), and lifts the faint ones toward the bright (as a long exposure would).
  let boost = F.grade.y;
  let faintest = F.skyLook.x + boost * (0.9 + 0.6 * F.skyLook.z);
  let seen = smoothstep(faintest + 0.3, faintest - 0.7, mag);
  if (seen <= 0.0) { return o; }
  let shown = 1.0 + (mag - 1.0) * (1.0 - 0.2 * boost);
  let h = starHash(inst);
  var twinkle = 1.0;
  if (look.w < 0.5) {
    let low = 1.0 - smoothstep(0.1, 0.9, alt);
    twinkle = 1.0 + (0.12 + 0.4 * low) * sin(F.time * (4.0 + 9.0 * h.x) + h.y * 40.0) * sin(F.time * (1.3 + 2.0 * h.z) + h.x * 20.0);
  }
  // Bright stars spread over a few pixels (and bloom); faint ones are a single soft point.
  let px = 1.45 + 0.45 * max(2.5 - mag, 0.0);
  let flux = pow(10.0, -0.4 * shown);
  o.colour = look.rgb * STAR_GAIN * (1.0 + 0.5 * boost) * flux / (px * px) * twinkle * seen;
  var corners = array<vec2<f32>, 6>(vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, -1.0), vec2<f32>(1.0, 1.0), vec2<f32>(-1.0, 1.0));
  let corner = corners[vi % 6u];
  let c = F.viewProj * vec4<f32>(onDome(d), 1.0);
  o.clip = vec4<f32>(c.xy + corner * px * 2.0 / F.resolution * c.w, c.z, c.w);
  o.corner = corner;
  return o;
}

@fragment
fn fsStar(in: StarOut) -> @location(0) vec4<f32> {
  let r2 = dot(in.corner, in.corner);
  if (r2 > 1.0) { discard; }
  return vec4<f32>(in.colour * exp(-3.5 * r2), 0.0);
}

// The constellations: faint lines between their stars (J2000 directions).

struct LineOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) fade: f32,
};

@vertex
fn vsLine(@location(0) star: vec4<f32>) -> LineOut {
  var o: LineOut;
  let d = normalize(starsToWorld(star.xyz));
  o.clip = F.viewProj * vec4<f32>(onDome(d), 1.0);
  o.fade = smoothstep(-0.02, 0.1, d.y);
  return o;
}

@fragment
fn fsLine(in: LineOut) -> @location(0) vec4<f32> {
  return vec4<f32>(vec3<f32>(0.018, 0.026, 0.045) * in.fade * clamp(F.skyLook.x - 1.5, 0.0, 1.0), 0.0);
}
