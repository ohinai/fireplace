// Smooths the stair-stepped edges of the finished picture (anti-aliasing): FXAA, after Timothy
// Lottes. Where the brightness changes sharply, it works out which way the edge runs, follows it
// both ways to its ends, and blends each pixel across it by how far it is from the nearer end (a
// long, shallow step gets a long, gentle ramp); a lone pixel unlike all round it is softened too.
// It reads the tonemapped picture, as the eye sees it.

@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;

// Too little contrast to count as an edge: below this share of the brightest neighbour, or this
// much in all (so the dark room's faint grain and the dither are left alone).
const EDGE_THRESHOLD: f32 = 0.125;
const EDGE_THRESHOLD_MIN: f32 = 0.0312;
const SUBPIXEL: f32 = 0.75; // how much a lone pixel is softened
// How far each step of the search along an edge goes (pixels): short at first, then longer.
const STEPS = array<f32, 10>(1.0, 1.0, 1.0, 1.0, 1.5, 2.0, 2.0, 2.0, 4.0, 8.0);

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

fn luma(c: vec3<f32>) -> f32 {
  return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

fn lumaAt(uv: vec2<f32>) -> f32 {
  return luma(textureSampleLevel(src, samp, uv, 0.0).rgb);
}

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> @location(0) vec4<f32> {
  let px = 1.0 / vec2<f32>(textureDimensions(src));
  let uv = pos.xy * px;
  let centre = textureSampleLevel(src, samp, uv, 0.0);
  let m = luma(centre.rgb);
  let n = lumaAt(uv + vec2<f32>(0.0, -px.y));
  let s = lumaAt(uv + vec2<f32>(0.0, px.y));
  let e = lumaAt(uv + vec2<f32>(px.x, 0.0));
  let w = lumaAt(uv + vec2<f32>(-px.x, 0.0));
  let lo = min(m, min(min(n, s), min(e, w)));
  let hi = max(m, max(max(n, s), max(e, w)));
  let range = hi - lo;
  if (range < max(EDGE_THRESHOLD_MIN, hi * EDGE_THRESHOLD)) {
    return centre;
  }
  let nw = lumaAt(uv + vec2<f32>(-px.x, -px.y));
  let ne = lumaAt(uv + vec2<f32>(px.x, -px.y));
  let sw = lumaAt(uv + vec2<f32>(-px.x, px.y));
  let se = lumaAt(uv + vec2<f32>(px.x, px.y));

  // A lone pixel: how unlike its surroundings it is.
  let around = (2.0 * (n + s + e + w) + nw + ne + sw + se) / 12.0;
  let lone = smoothstep(0.0, 1.0, clamp(abs(around - m) / range, 0.0, 1.0));
  let subpixel = lone * lone * SUBPIXEL;

  // Which way the edge runs: along x (the brightness changes most going up and down) or along y.
  let changeUpDown = abs(nw + sw - 2.0 * w) + 2.0 * abs(n + s - 2.0 * m) + abs(ne + se - 2.0 * e);
  let changeAcross = abs(nw + ne - 2.0 * n) + 2.0 * abs(w + e - 2.0 * m) + abs(sw + se - 2.0 * s);
  let alongX = changeUpDown >= changeAcross;
  // Which side of this pixel the edge is on: the neighbour it differs from most.
  let before = select(w, n, alongX);
  let after = select(e, s, alongX);
  let gradBefore = abs(before - m);
  let gradAfter = abs(after - m);
  var stepAcross = select(px.x, px.y, alongX);
  var otherSide = after;
  var gradient = gradAfter;
  if (gradBefore >= gradAfter) {
    stepAcross = -stepAcross;
    otherSide = before;
    gradient = gradBefore;
  }
  // Follow the edge (half a pixel over, on it) both ways until its brightness changes.
  var onEdge = uv;
  if (alongX) { onEdge.y += 0.5 * stepAcross; } else { onEdge.x += 0.5 * stepAcross; }
  let edgeLuma = 0.5 * (m + otherSide);
  let enough = 0.25 * gradient;
  let along = select(vec2<f32>(0.0, px.y), vec2<f32>(px.x, 0.0), alongX);
  var uvA = onEdge + along;
  var uvB = onEdge - along;
  var dA = lumaAt(uvA) - edgeLuma;
  var dB = lumaAt(uvB) - edgeLuma;
  var doneA = abs(dA) >= enough;
  var doneB = abs(dB) >= enough;
  for (var i = 0; i < 10; i++) {
    if (doneA && doneB) { break; }
    if (!doneA) {
      uvA += along * STEPS[i];
      dA = lumaAt(uvA) - edgeLuma;
      doneA = abs(dA) >= enough;
    }
    if (!doneB) {
      uvB -= along * STEPS[i];
      dB = lumaAt(uvB) - edgeLuma;
      doneB = abs(dB) >= enough;
    }
  }
  let distA = select(uvA.y - uv.y, uvA.x - uv.x, alongX);
  let distB = select(uv.y - uvB.y, uv.x - uvB.x, alongX);
  let nearerA = distA < distB;
  let dist = min(distA, distB);
  let span = distA + distB;
  // Blend only on the side of the step this pixel is on (where the end found turns the right way).
  let darker = m < edgeLuma;
  let endTurn = select(dB, dA, nearerA) < 0.0;
  let edgeBlend = select(0.0, 0.5 - dist / span, endTurn != darker);
  let blend = max(edgeBlend, subpixel);
  var at = uv;
  if (alongX) { at.y += blend * stepAcross; } else { at.x += blend * stepAcross; }
  return vec4<f32>(textureSampleLevel(src, samp, at, 0.0).rgb, 1.0);
}
