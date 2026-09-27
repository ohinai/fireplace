// Helpers for render shaders. Shaders that include this must bind `F: Frame` and
// `bb: array<vec4<f32>>` (the blackbody table).

const BB_LAST: u32 = 511u;

// Linear sRGB radiance of a blackbody, normalised to luminance 1 at 1500 K.
fn blackbody(T: f32) -> vec3<f32> {
  let x = clamp((T - 400.0) / 2000.0, 0.0, 1.0) * f32(BB_LAST);
  let i = u32(x);
  let j = min(i + 1u, BB_LAST);
  return mix(bb[i].rgb, bb[j].rgb, x - f32(i));
}

// Glowing surfaces as the eye sees them: the true blackbody colour, with brightness
// compressed (luminance^0.6) so dull-red char and coals stay visible beside bright flames.
// The eye adapts to see embers glowing; a camera exposed for the flames would not.
fn glow(T: f32) -> vec3<f32> {
  let c = blackbody(T);
  let lum = max(dot(c, vec3<f32>(0.2126, 0.7152, 0.0722)), 1e-9);
  return c * pow(lum, -0.4);
}

// Light emitted per metre by the gas: glowing soot, plus the faint blue of burning gas.
fn flameEmission(s: vec4<f32>) -> vec3<f32> {
  let T = s.x;
  let soot = max(s.w, 0.0);
  let react = max(s.y, 0.0) * clamp(s.z, 0.0, 1.0) * smoothstep(F.tIgnite - 60.0, F.tIgnite + 60.0, T);
  return F.kEmit * soot * blackbody(T) + F.kBlue * react * vec3<f32>(0.2, 0.45, 1.0);
}

fn pcg3d(v0: vec3<u32>) -> vec3<u32> {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3<u32>(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

fn hash33(p: vec3<i32>) -> vec3<f32> {
  return vec3<f32>(pcg3d(bitcast<vec3<u32>>(p))) * (1.0 / 4294967296.0);
}

fn hash31(p: vec3<i32>) -> f32 {
  return hash33(p).x;
}

fn valueNoise(p: vec3<f32>) -> f32 {
  let i = vec3<i32>(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = hash31(i);
  let n100 = hash31(i + vec3<i32>(1, 0, 0));
  let n010 = hash31(i + vec3<i32>(0, 1, 0));
  let n110 = hash31(i + vec3<i32>(1, 1, 0));
  let n001 = hash31(i + vec3<i32>(0, 0, 1));
  let n101 = hash31(i + vec3<i32>(1, 0, 1));
  let n011 = hash31(i + vec3<i32>(0, 1, 1));
  let n111 = hash31(i + vec3<i32>(1, 1, 1));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z);
}

fn fbm(p0: vec3<f32>) -> f32 {
  var p = p0;
  var a = 0.5;
  var s = 0.0;
  for (var i = 0; i < 4; i++) {
    s += a * valueNoise(p);
    p = p * 2.03 + vec3<f32>(1.7, 9.2, 3.1);
    a *= 0.5;
  }
  return s / 0.9375;
}

// Cellular noise: x = distance to the nearest cell point, y = to the second nearest,
// z = a random value identifying the nearest cell.
fn voronoi(p: vec3<f32>) -> vec3<f32> {
  let n = vec3<i32>(floor(p));
  let f = fract(p);
  var d1 = 8.0;
  var d2 = 8.0;
  var id = 0.0;
  for (var k = -1; k <= 1; k++) {
    for (var j = -1; j <= 1; j++) {
      for (var i = -1; i <= 1; i++) {
        let g = vec3<i32>(i, j, k);
        let h = hash33(n + g);
        let r = vec3<f32>(g) + h - f;
        let d = dot(r, r);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          id = h.z;
        } else if (d < d2) {
          d2 = d;
        }
      }
    }
  }
  return vec3<f32>(sqrt(d1), sqrt(d2), id);
}
