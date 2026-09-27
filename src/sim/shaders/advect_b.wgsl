// MacCormack step 2: advect the step-1 result backward, use the round-trip error to correct
// it, then clamp to the source neighbourhood so the correction cannot create new extrema.

@group(0) @binding(5) var velHat: texture_3d<f32>;
@group(0) @binding(6) var scalHat: texture_3d<f32>;
@group(0) @binding(7) var auxHat: texture_3d<f32>;
@group(0) @binding(8) var velOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(9) var scalOut: texture_storage_3d<rgba16float, write>;
@group(0) @binding(10) var auxOut: texture_storage_3d<rgba16float, write>;

fn correctFace(t: vec3<i32>, a: u32, s: f32) -> f32 {
  let f = clampFace(t, a);
  let x0 = facePos(f, a);
  let xb = trace(x0, s);
  let hat = textureLoad(velHat, f, 0)[a];
  if (fromRoom(xb)) { return hat; }
  let xf = trace(x0, -s);
  let v = hat + 0.5 * (textureLoad(velIn, f, 0)[a] - sampleComp(velHat, xf, a));

  let maxT = vec3<i32>(P.dims);
  let b0 = clamp(vec3<i32>(floor(xb + 0.5 * axisF(a) - 0.5)), vec3<i32>(0), maxT);
  let b1 = min(b0 + 1, maxT);
  var lo = 1e30;
  var hi = -1e30;
  for (var k = 0u; k < 8u; k++) {
    let q = vec3<i32>(
      select(b0.x, b1.x, (k & 1u) != 0u),
      select(b0.y, b1.y, (k & 2u) != 0u),
      select(b0.z, b1.z, (k & 4u) != 0u));
    let c = textureLoad(velIn, q, 0)[a];
    lo = min(lo, c);
    hi = max(hi, c);
  }
  return clamp(v, lo, hi);
}

fn correctCell(t: vec3<i32>, xb: vec3<f32>, xf: vec3<f32>, cur: texture_3d<f32>, hat: texture_3d<f32>) -> vec4<f32> {
  let sc = textureLoad(hat, t, 0) + 0.5 * (textureLoad(cur, t, 0) - sampleScal(hat, xf));
  let maxC = vec3<i32>(P.dims) - 1;
  let b0 = clamp(vec3<i32>(floor(xb - 0.5)), vec3<i32>(0), maxC);
  let b1 = min(b0 + 1, maxC);
  var lo = vec4<f32>(1e30);
  var hi = vec4<f32>(-1e30);
  for (var k = 0u; k < 8u; k++) {
    let q = vec3<i32>(
      select(b0.x, b1.x, (k & 1u) != 0u),
      select(b0.y, b1.y, (k & 2u) != 0u),
      select(b0.z, b1.z, (k & 4u) != 0u));
    let c = textureLoad(cur, q, 0);
    lo = min(lo, c);
    hi = max(hi, c);
  }
  return clamp(sc, lo, hi);
}

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid > P.dims)) { return; }
  let t = vec3<i32>(gid);
  let s = P.dt / P.h;

  var vel = vec4<f32>(0.0);
  for (var a = 0u; a < 3u; a++) {
    vel[a] = correctFace(t, a, s);
  }
  textureStore(velOut, t, vel);

  if (!all(gid < P.dims)) { return; }
  let x0 = vec3<f32>(gid) + 0.5;
  let xb = trace(x0, s);
  let xf = trace(x0, -s);
  if (fromRoom(xb) || fromRoom(xf)) {
    textureStore(scalOut, t, textureLoad(scalHat, t, 0));
    textureStore(auxOut, t, textureLoad(auxHat, t, 0));
    return;
  }
  textureStore(scalOut, t, correctCell(t, xb, xf, scalIn, scalHat));
  textureStore(auxOut, t, correctCell(t, xb, xf, auxIn, auxHat));
}
