// Furnishings, for the scene shader (which has Surface, fbm and the rest): upholstery, wicker,
// books, a painting and its gilt frame, a clock face, painted walls, varnished wood, a cat's fur,
// leaves, glazed pottery, and rugs.

// Woven willow: stakes up the side, weavers passing in front of and behind them in turn
// (uv: fraction of the way round, height).
fn wicker(uv: vec2<f32>) -> Surface {
  let u = uv.x * 96.0;
  let v = uv.y / 0.011;
  let across = fract(v);
  let over = (i32(floor(u)) + i32(floor(v))) & 1;
  let bulge = sin(3.14159 * across);
  var col = vec3<f32>(0.5, 0.37, 0.21) * (0.55 + 0.45 * bulge) * select(0.82, 1.0, over == 0);
  col *= 0.8 + 0.3 * fbm(vec3<f32>(uv.x * 500.0, uv.y * 40.0, 1.0));
  col *= mix(0.3, 1.0, smoothstep(0.0, 0.14, across) * smoothstep(1.0, 0.86, across));
  return Surface(col, vec3<f32>(0.0), 0.06, 10.0);
}

// Upholstery: a close weave in the given colour, a little uneven.
fn fabric(p: vec3<f32>, colour: vec3<f32>) -> Surface {
  let weave = 0.5 + 0.5 * sin(p.x * 1100.0 + p.z * 700.0) * sin(p.y * 1100.0);
  let col = colour * (0.78 + 0.3 * fbm(p * 25.0)) * (0.93 + 0.07 * weave);
  return Surface(col, vec3<f32>(0.0), 0.02, 3.0);
}

// A book's cloth or leather binding (extra: a seed for its colour; its height, for the gilt
// bands on its spine, or 0 for none; uv.y: height up it).
fn bookCover(uv: vec2<f32>, extra: vec3<f32>, p: vec3<f32>) -> Surface {
  let h = hash31(vec3<i32>(i32(extra.x * 9973.0), 3, 7));
  var palette = array<vec3<f32>, 8>(
    vec3<f32>(0.36, 0.06, 0.05), vec3<f32>(0.07, 0.19, 0.11), vec3<f32>(0.07, 0.1, 0.24), vec3<f32>(0.3, 0.16, 0.07),
    vec3<f32>(0.55, 0.46, 0.32), vec3<f32>(0.1, 0.08, 0.07), vec3<f32>(0.45, 0.27, 0.07), vec3<f32>(0.22, 0.05, 0.12));
  var col = palette[u32(h * 8.0) % 8u] * (0.75 + 0.45 * fract(h * 13.7));
  col *= 0.85 + 0.2 * fbm(p * 90.0);
  var spec = 0.06;
  if (extra.z > 0.0) {
    let t = uv.y / extra.z;
    let band = smoothstep(0.012, 0.004, abs(t - 0.09)) + smoothstep(0.012, 0.004, abs(t - 0.9))
      + smoothstep(0.035, 0.025, abs(t - 0.66)) * step(0.45, fract(h * 7.3));
    let gilt = clamp(band, 0.0, 1.0);
    col = mix(col, vec3<f32>(0.6, 0.44, 0.16), gilt * 0.9);
    spec = mix(spec, 0.55, gilt);
  }
  return Surface(col, vec3<f32>(0.0), spec, 24.0);
}

// The edges of a book's pages.
fn pages(p: vec3<f32>) -> Surface {
  let col = vec3<f32>(0.8, 0.74, 0.6) * (0.88 + 0.12 * fbm(p * 200.0));
  return Surface(col, vec3<f32>(0.0), 0.02, 4.0);
}

// An oil painting (uv 0..1 across it): a lake among hills at the end of the day, in dabs of paint
// under yellowed varnish.
fn painting(uv: vec2<f32>, seed: f32) -> Surface {
  let s = seed * 17.0;
  let stroke = fbm(vec3<f32>(uv.x * 70.0, uv.y * 28.0, s)) - 0.5;
  let q = uv + vec2<f32>(stroke * 0.012, stroke * 0.006);
  var col = mix(vec3<f32>(0.86, 0.6, 0.32), vec3<f32>(0.26, 0.33, 0.48), smoothstep(0.45, 0.98, q.y));
  let cloud = smoothstep(0.55, 0.75, fbm(vec3<f32>(q.x * 4.0, q.y * 10.0, s + 2.0)));
  col = mix(col, vec3<f32>(0.93, 0.78, 0.58), cloud * smoothstep(0.55, 0.85, q.y) * 0.7);
  let far = 0.52 + 0.07 * fbm(vec3<f32>(q.x * 3.0, s, 1.0)) - 0.04 * sin(q.x * 5.0 + s);
  col = mix(col, vec3<f32>(0.36, 0.4, 0.47), smoothstep(far + 0.004, far - 0.004, q.y));
  let near = 0.4 + 0.09 * fbm(vec3<f32>(q.x * 5.0, s + 4.0, 2.0));
  col = mix(col, vec3<f32>(0.27, 0.31, 0.15) * (0.75 + 0.45 * fbm(vec3<f32>(q * 30.0, s))), smoothstep(near + 0.004, near - 0.004, q.y));
  let lake = smoothstep(0.27, 0.25, q.y) * smoothstep(0.08, 0.12, q.y) * smoothstep(0.12, 0.3, q.x) * smoothstep(0.95, 0.78, q.x);
  col = mix(col, vec3<f32>(0.62, 0.52, 0.42), lake * 0.85);
  let trees = smoothstep(0.52, 0.6, fbm(vec3<f32>(q.x * 12.0, q.y * 6.0, s + 7.0)) + 0.35 * smoothstep(0.3, 0.0, q.y) - 0.4 * smoothstep(0.2, 0.5, q.y));
  col = mix(col, vec3<f32>(0.1, 0.13, 0.07), trees);
  let rim = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  col *= vec3<f32>(1.0, 0.92, 0.76) * (0.8 + 0.2 * smoothstep(0.0, 0.15, rim)) * (0.85 + 0.3 * stroke);
  return Surface(col * 0.85, vec3<f32>(0.0), 0.18, 30.0);
}

// Gilt: gold leaf, burnished, rubbed through to the red bole here and there.
fn gilt(p: vec3<f32>) -> Surface {
  let rub = smoothstep(0.66, 0.8, fbm(p * 40.0));
  let col = mix(vec3<f32>(0.72, 0.52, 0.2), vec3<f32>(0.4, 0.16, 0.08), rub * 0.5) * (0.9 + 0.1 * fbm(p * 90.0));
  return Surface(col, vec3<f32>(0.0), mix(0.9, 0.3, rub), 60.0);
}

// A clock's enamelled dial (uv -1..1 across it), telling the real time.
fn clockFace(uv: vec2<f32>) -> Surface {
  let r = length(uv);
  let a = atan2(uv.x, uv.y); // clockwise from twelve
  var col = vec3<f32>(0.86, 0.82, 0.72) * (0.95 + 0.05 * valueNoise(vec3<f32>(uv * 30.0, 1.0)));
  let hourGap = abs(fract(a / (6.2832 / 12.0) + 0.5) - 0.5) * (6.2832 / 12.0) * r;
  let minuteGap = abs(fract(a / (6.2832 / 60.0) + 0.5) - 0.5) * (6.2832 / 60.0) * r;
  var ink = smoothstep(0.035, 0.02, hourGap) * step(0.68, r) * step(r, 0.88);
  ink = max(ink, smoothstep(0.012, 0.005, minuteGap) * step(0.82, r) * step(r, 0.88));
  ink = max(ink, smoothstep(0.012, 0.0, abs(r - 0.9)));
  let secs = F.clock.x;
  let hand = fn_hand(uv, fract(secs / 43200.0) * 6.2832, 0.5, 0.055);
  let minute = fn_hand(uv, fract(secs / 3600.0) * 6.2832, 0.78, 0.035);
  ink = max(ink, max(hand, minute));
  ink = max(ink, smoothstep(0.07, 0.05, r));
  col = mix(col, vec3<f32>(0.03, 0.025, 0.02), ink);
  return Surface(col, vec3<f32>(0.0), 0.5, 60.0);
}

// A clock hand at angle a (clockwise from twelve): how much of it covers uv.
fn fn_hand(uv: vec2<f32>, a: f32, len: f32, width: f32) -> f32 {
  let dir = vec2<f32>(sin(a), cos(a));
  let along = dot(uv, dir);
  let across = abs(dot(uv, vec2<f32>(dir.y, -dir.x)));
  let taper = width * (1.0 - 0.7 * clamp(along / len, 0.0, 1.0));
  return smoothstep(0.01, 0.0, across - taper) * step(-0.12, along) * step(along, len);
}

// Matt emulsion on plaster (extra: its colour).
fn paint(p: vec3<f32>, colour: vec3<f32>) -> Surface {
  return Surface(colour * (0.92 + 0.1 * fbm(p * 6.0) + 0.03 * valueNoise(p * 300.0)), vec3<f32>(0.0), 0.02, 5.0);
}

// Varnished wood (extra: its colour): grain, and a soft sheen.
fn finish(p: vec3<f32>, colour: vec3<f32>) -> Surface {
  let grain = fbm(vec3<f32>(p.x * 5.0 + p.z * 3.0, p.y * 60.0, p.z * 20.0 + p.x * 12.0));
  let col = colour * (0.7 + 0.5 * grain);
  return Surface(col, vec3<f32>(0.0), 0.3, 40.0);
}

// A brown tabby's coat (extra: where on the cat the point is, part by part: see cat.ts; N: the
// surface's normal). Black markings on warm, ticked grey-brown fur: narrow "mackerel" stripes
// down its flanks from a dark saddle, bars round its legs, rings round its tail and a black tip;
// on its face the "M" over its brow, lines back across its cheeks, pale lids round its shut
// eyes, a pale muzzle and chin, and a brick-pink nose; its ears dark behind and pink inside.
fn catFur(e: vec3<f32>, N: vec3<f32>) -> Surface {
  let part = floor((e.x + 5.0) / 10.0);
  let q = e - vec3<f32>(part * 10.0, 0.0, 0.0);
  let black = vec3<f32>(0.014, 0.011, 0.008);
  let pale = vec3<f32>(0.55, 0.47, 0.36);
  let warm = vec3<f32>(0.27, 0.16, 0.075);
  // Ticked fur: each hair banded light and dark, so the ground between the stripes is flecked.
  var col = vec3<f32>(0.2, 0.145, 0.085) * (0.7 + 0.6 * valueNoise(q * 900.0));
  var dark = 0.0; // the tabby markings
  var light = 0.0; // pale fur
  var ink = 0.0; // the finest dark lines, over everything (its shut eyes)
  if (part < 0.5) {
    // Body (the cat's frame): stripes down its flanks, leaning back a little as they go down,
    // wavering and broken into dashes; along its back a dark saddle they run up into, the ground
    // colour only glinting through; warmer low on its flanks, paler under.
    let phase = (q.z + 0.3 * (0.14 - q.y)) * 290.0 + fbm(q * 13.0) * 9.0 + fbm(q * 45.0) * 2.5;
    let broken = smoothstep(0.3, 0.62, fbm(q * vec3<f32>(40.0, 60.0, 25.0) + 3.0));
    dark = smoothstep(0.1, 0.8, sin(phase)) * broken;
    dark = max(dark, smoothstep(0.45, 0.88, N.y) * (0.7 + 0.3 * fbm(q * 50.0)));
    dark *= smoothstep(0.012, 0.045, q.y) * (0.8 + 0.25 * valueNoise(q * 800.0));
    col = mix(col, warm, smoothstep(0.075, 0.03, q.y) * 0.65);
    light = smoothstep(0.028, 0.006, q.y) * 0.45;
  } else if (part < 1.5) {
    // Head (its own frame: x to its left, y up through its crown, z out along its nose).
    let ax = abs(q.x);
    col = mix(col, warm, smoothstep(0.018, 0.034, ax) * smoothstep(0.012, -0.01, q.y) * 0.6);
    // Thin lines back over its crown from the brow (the "M" where they meet it), the crown
    // behind them darker.
    let brow = smoothstep(0.011, 0.02, q.y) * smoothstep(0.032, 0.014, ax);
    dark = smoothstep(0.72, 0.97, cos(q.x * 760.0 + fbm(q * 45.0) * 2.5)) * brow * 0.85;
    dark = max(dark, smoothstep(0.0, -0.035, q.z) * smoothstep(0.0, 0.03, q.y) * 0.6);
    // Two lines back across each cheek from the outer corner of the eye.
    let back = 0.036 - q.z;
    let cheek = smoothstep(0.022, 0.03, ax) * smoothstep(0.05, 0.02, back);
    let l1 = smoothstep(0.0024, 0.001, abs(q.y - (0.005 - 0.3 * back)));
    let l2 = smoothstep(0.0022, 0.0009, abs(q.y - (-0.007 - 0.22 * back)));
    dark = max(dark, max(l1, l2) * cheek);
    // A pale muzzle, chin and throat.
    light = smoothstep(0.03, 0.042, q.z) * smoothstep(0.001, -0.009, q.y) * 0.85;
    light = max(light, smoothstep(-0.016, -0.026, q.y) * smoothstep(0.0, 0.02, q.z) * 0.95);
    // Shut eyes: the line of the lids, drooping at the corners, in pale fur.
    let ex = ax - 0.0205;
    let lid = 0.0085 - 10.0 * ex * ex;
    let eye = smoothstep(0.0115, 0.0085, abs(ex)) * smoothstep(0.02, 0.028, q.z);
    let d = abs(q.y - lid);
    let rim = smoothstep(0.005, 0.003, d) * eye;
    light = max(light, rim * 0.8);
    dark *= 1.0 - rim;
    ink = smoothstep(0.0014, 0.0005, d) * eye;
  } else if (part < 2.5) {
    // Legs (the cat's frame): dark bars round them; black behind the hock.
    col = warm * (0.8 + 0.4 * valueNoise(q * 900.0));
    dark = smoothstep(0.3, 0.9, sin((q.z - 0.6 * q.y) * 330.0 + fbm(q * 30.0) * 3.0)) * 0.85;
    dark = max(dark, smoothstep(-0.185, -0.205, q.z));
  } else if (part < 3.5) {
    // Tail (x: how far along it): rings, and a black tip.
    dark = smoothstep(0.2, 0.85, sin(q.x * 200.0 + fbm(q * 30.0) * 1.5));
    dark = max(dark, smoothstep(0.3, 0.34, q.x));
  } else if (part < 4.5) {
    // Ear (x: across it; y: up it; z: +1 in front): dark behind; pale pink inside, with pale
    // hairs from its edges and its base.
    let inside = smoothstep(-0.4, 0.4, q.z);
    col = mix(vec3<f32>(0.075, 0.058, 0.045), vec3<f32>(0.5, 0.35, 0.3), inside);
    light = inside * max(smoothstep(0.5, 0.95, abs(q.x)), smoothstep(0.35, 0.0, q.y)) * 0.6;
  } else if (part < 5.5) {
    // Nose (the head's frame): brick pink and moist, darker round its edge.
    let r = length((q.xy - vec2<f32>(0.0, -0.0015)) / vec2<f32>(0.0062, 0.0042));
    let nose = mix(vec3<f32>(0.5, 0.27, 0.22), vec3<f32>(0.14, 0.07, 0.06), smoothstep(0.7, 1.0, r));
    return Surface(nose * (0.9 + 0.15 * fbm(q * 900.0)), vec3<f32>(0.0), 0.3, 30.0);
  } else {
    // Paws (x across, y up, z toward the toes): warm and pale, faintly barred behind; the hind
    // one dark.
    col = mix(warm * 1.1, pale, 0.25) * (0.85 + 0.3 * valueNoise(q * 900.0));
    dark = smoothstep(0.3, 0.9, sin(q.z * 280.0 + 1.0)) * 0.4 * smoothstep(0.004, -0.008, q.z);
    if (part > 6.5) {
      dark = max(dark, 0.7);
    }
  }
  col = mix(col, black, dark);
  col = mix(col, pale, light);
  col = mix(col, black, ink);
  // Fine hairs.
  col *= 0.82 + 0.3 * fbm(q * 480.0);
  return Surface(col, vec3<f32>(0.0), 0.04, 6.0);
}

// A glossy leaf (uv: across -1..1, along 0..1): paler midrib and veins.
fn leafSurface(uv: vec2<f32>, colour: vec3<f32>) -> Surface {
  let rib = smoothstep(0.07, 0.0, abs(uv.x));
  let vein = smoothstep(0.08, 0.0, abs(fract((uv.y - abs(uv.x) * 0.3) * 8.0) - 0.5) - 0.42) * smoothstep(0.05, 0.25, abs(uv.x));
  var col = colour * (0.8 + 0.3 * fbm(vec3<f32>(uv * 18.0, 3.0)));
  col = mix(col, colour * 1.9 + vec3<f32>(0.05, 0.05, 0.0), max(rib * 0.7, vein * 0.3));
  return Surface(col, vec3<f32>(0.0), 0.35, 30.0);
}

// Glazed pottery (extra: its colour).
fn ceramic(p: vec3<f32>, colour: vec3<f32>) -> Surface {
  return Surface(colour * (0.9 + 0.12 * fbm(p * 40.0)), vec3<f32>(0.0), 0.5, 70.0);
}

// A Talavera plate (uv -1..1 across it), painted by hand on a white tin glaze: a cobalt flower
// with a yellow eye, a ring of leaves in blue and green with yellow dots between, a yellow
// ring, and a blue rim with white dots.
fn talaveraPlate(uv: vec2<f32>) -> Surface {
  let glaze = vec3<f32>(0.9, 0.87, 0.78);
  let cobalt = vec3<f32>(0.05, 0.11, 0.45);
  let yellow = vec3<f32>(0.88, 0.58, 0.1);
  let green = vec3<f32>(0.1, 0.34, 0.16);
  let wob = (valueNoise(vec3<f32>(uv * 25.0, 4.0)) - 0.5) * 0.03;
  let r = length(uv) + wob;
  let a = atan2(uv.y, uv.x);
  let turn = a / 6.2832 * 12.0;
  var col = glaze;
  if (r < 0.3 + 0.12 * cos(a * 8.0)) { col = cobalt; }
  if (r < 0.12) { col = yellow; }
  if (r < 0.05) { col = cobalt; }
  if (abs(r - 0.5) < 0.025) { col = cobalt; }
  let la = fract(turn) - 0.5;
  let lr = (r - 0.665) / 0.1;
  if (r > 0.55 && r < 0.78 && abs(la) * 2.2 + lr * lr * 0.9 < 0.5) {
    col = select(green, cobalt, (i32(floor(turn + 12.0)) & 1) == 0);
  }
  if (length(vec2<f32>(fract(turn + 0.5) - 0.5, (r - 0.665) * 3.0)) < 0.09) { col = yellow; }
  if (abs(r - 0.83) < 0.03) { col = yellow; }
  if (r > 0.88) {
    col = cobalt;
    if (length(vec2<f32>(fract(turn * 2.0) - 0.5, (r - 0.94) * 8.0)) < 0.22) { col = glaze; }
  }
  return Surface(col * (0.95 + 0.05 * valueNoise(vec3<f32>(uv * 60.0, 1.0))), vec3<f32>(0.0), 0.6, 90.0);
}

// A dried chile: deep glossy red, wrinkled.
fn chile(p: vec3<f32>) -> Surface {
  let col = vec3<f32>(0.42, 0.04, 0.03) * (0.65 + 0.55 * fbm(p * 140.0));
  return Surface(col, vec3<f32>(0.0), 0.45, 40.0);
}

// ---- Rugs ------------------------------------------------------------------------------------

// A kilim: a madder-red field under a lattice of stepped diamonds, ring inside ring in navy,
// orange and cream, dotted with small squares; a border of little diamonds between cream
// guard stripes. Woven, so every edge steps a few threads at a time. (size: the rug in m.)
fn kilim(uv: vec2<f32>, size: vec2<f32>) -> vec3<f32> {
  let red = vec3<f32>(0.46, 0.06, 0.05);
  let navy = vec3<f32>(0.05, 0.06, 0.15);
  let cream = vec3<f32>(0.8, 0.7, 0.5);
  let orange = vec3<f32>(0.76, 0.33, 0.07);
  let black = vec3<f32>(0.03, 0.025, 0.025);
  let cell = 0.012;
  let W = floor(size / cell);
  let P = floor(uv * size / cell);
  let edge = min(min(P.x, W.x - 1.0 - P.x), min(P.y, W.y - 1.0 - P.y));
  // Dye lots: the red is never quite even.
  let abrash = 0.88 + 0.14 * fbm(vec3<f32>(0.0, uv.y * size.y * 3.0, 5.0));
  if (edge < 2.0) { return black; }
  if (edge < 4.0) { return cream; }
  if (edge < 13.0) {
    // The border: small diamonds along it, on navy.
    let along = select(P.x, P.y, min(P.x, W.x - 1.0 - P.x) <= min(P.y, W.y - 1.0 - P.y));
    let a = abs((along % 12.0) - 5.5);
    let b = abs(edge - 8.5);
    let d = a + b;
    if (d < 2.0) { return cream; }
    if (d < 4.0) { return orange; }
    if (d < 5.0) { return red * abrash; }
    return navy;
  }
  if (edge < 15.0) { return cream; }
  // The field: a lattice of diamonds (the nearest centre of two interleaved grids).
  let F = P - 15.0;
  let D = vec2<f32>(20.0, 28.0);
  let ga = F - (floor(F / (2.0 * D)) * 2.0 * D + D);
  let gb = F - (floor((F + D) / (2.0 * D)) * 2.0 * D);
  let da = abs(ga.x) / D.x + abs(ga.y) / D.y;
  let db = abs(gb.x) / D.x + abs(gb.y) / D.y;
  let d = min(da, db);
  let ring = floor(d * 7.0);
  let dots = ((i32(P.x) + i32(P.y)) & 1) == 0;
  if (ring < 1.0) { return select(orange, cream, d < 0.07); }
  if (ring < 2.0) { return navy; }
  if (ring < 3.0) { return select(orange, cream, dots); }
  if (ring < 4.0) { return red * abrash; }
  if (ring < 5.0) { return navy; }
  if (ring < 6.0) { return select(red * abrash, cream, dots && (i32(P.x) % 4 == 0)); }
  return select(orange, cream, (i32(P.x + P.y) % 3) == 0);
}

// A Persian carpet: a deep red field scattered with small flowers round a lobed medallion,
// navy corners, a border of rosettes between ivory guard stripes.
fn persian(uv: vec2<f32>, size: vec2<f32>) -> vec3<f32> {
  let red = vec3<f32>(0.4, 0.05, 0.05);
  let navy = vec3<f32>(0.04, 0.06, 0.16);
  let ivory = vec3<f32>(0.78, 0.7, 0.52);
  let gold = vec3<f32>(0.7, 0.5, 0.15);
  let p = uv * size;
  let edge = min(min(p.x, size.x - p.x), min(p.y, size.y - p.y));
  if (edge < 0.02) { return navy * 0.6; }
  if (edge < 0.035) { return ivory; }
  if (edge < 0.15) {
    let along = select(p.x, p.y, min(p.x, size.x - p.x) <= min(p.y, size.y - p.y));
    let c = vec2<f32>((fract(along / 0.12) - 0.5) * 0.12, edge - 0.0925);
    let r = length(c);
    let petals = 0.035 + 0.012 * cos(atan2(c.y, c.x) * 6.0);
    if (r < 0.012) { return gold; }
    if (r < petals) { return red; }
    return navy;
  }
  if (edge < 0.165) { return ivory; }
  let c = p - size * 0.5;
  let a = atan2(c.y, c.x);
  let m = length(c / vec2<f32>(0.9, 1.25) * size.x) / size.x;
  let lobes = 0.2 + 0.03 * cos(a * 8.0);
  if (m < lobes * 0.35) { return gold; }
  if (m < lobes * 0.65) { return ivory * 0.9; }
  if (m < lobes) { return navy; }
  if (m < lobes + 0.012) { return ivory; }
  // Corners, and small flowers on the field.
  let k = abs(c) - (size * 0.5 - 0.165);
  if (length(k / vec2<f32>(0.35, 0.45)) < 0.9 && k.x > -0.35 && k.y > -0.45) { return navy; }
  let f = (fract(p / 0.09) - 0.5) * 0.09;
  let fr = length(f);
  if (fr < 0.008) { return gold; }
  if (fr < 0.016 + 0.005 * cos(atan2(f.y, f.x) * 5.0)) { return ivory * 0.85; }
  return red;
}

// A Bedouin weaving (sadu): long bands of red, black, white and orange, the middle band full of
// teeth and diamonds.
fn sadu(uv: vec2<f32>, size: vec2<f32>) -> vec3<f32> {
  let red = vec3<f32>(0.5, 0.07, 0.05);
  let black = vec3<f32>(0.03, 0.025, 0.025);
  let white = vec3<f32>(0.8, 0.74, 0.6);
  let orange = vec3<f32>(0.75, 0.35, 0.08);
  let cell = 0.012;
  let P = floor(uv * size / cell);
  let W = floor(size / cell);
  let x = min(P.x, W.x - 1.0 - P.x); // bands run along the rug
  if (x < 3.0) { return black; }
  if (x < 6.0) { return select(red, white, (i32(P.y) & 1) == 0); }
  if (x < 10.0) { return red; }
  if (x < 12.0) { return white; }
  if (x < 20.0) {
    // Teeth: triangles pointing in.
    let t = P.y % 8.0;
    let h = x - 12.0;
    return select(black, orange, h < 8.0 - abs(t - 4.0) * 2.0);
  }
  if (x < 22.0) { return white; }
  // The middle: diamonds with a dot in each, on black and red.
  let mid = floor(W.x * 0.5);
  let a = abs(P.x - mid);
  let b = abs((P.y % 20.0) - 9.5);
  let d = a / max(mid - 22.0, 1.0) * 10.0 + b;
  if (d < 2.0) { return orange; }
  if (d < 5.0) { return white; }
  if (d < 8.0) { return red; }
  return black;
}

// Woven bands, as on Bedouin cushions, bolsters and mattresses: broad madder red between narrow
// stripes of black and white, a checked stripe, and a band of little orange diamonds on black.
// (The bands run along uv.y, mirrored about the middle.)
fn bands(uv: vec2<f32>, size: vec2<f32>) -> vec3<f32> {
  let red = vec3<f32>(0.5, 0.07, 0.05);
  let black = vec3<f32>(0.03, 0.025, 0.025);
  let white = vec3<f32>(0.8, 0.74, 0.6);
  let orange = vec3<f32>(0.75, 0.35, 0.08);
  let cell = 0.01;
  let P = floor(uv * size / cell);
  let W = floor(size.x / cell);
  let x = u32(max(min(P.x, W - 1.0 - P.x), 0.0)) % 24u;
  if (x < 2u) { return black; }
  if (x < 3u) { return white; }
  if (x < 9u) { return red; }
  if (x < 10u) { return black; }
  if (x < 12u) { return select(white, black, (i32(P.y) & 1) == 0); }
  if (x < 13u) { return black; }
  if (x < 19u) {
    let a = abs(f32(x) - 15.5);
    let b = abs((P.y % 6.0) - 2.5);
    return select(black, orange, a + b < 2.6);
  }
  if (x < 20u) { return black; }
  if (x < 21u) { return white; }
  return red;
}

// A rug (uv 0..1 across it; extra: which pattern, its width and length in m). Beyond each end
// its fringe: threads with the floor showing between them (discarded by the caller). Cushions,
// bolsters and the tent's trimmings are woven the same way.
fn rugColour(uv: vec2<f32>, extra: vec3<f32>) -> vec3<f32> {
  let size = vec2<f32>(max(extra.y, 0.1), max(extra.z, 0.1));
  let kind = u32(extra.x + 0.5);
  var col: vec3<f32>;
  switch (kind) {
    case 1u: { col = kilim(uv, size); }
    case 2u: { col = persian(uv, size); }
    case 3u: { col = sadu(uv, size); }
    case 4u: { col = bands(uv, size); }
    default: { col = kilim(uv, size); }
  }
  // Wool: a little uneven, and worn paler where people walk.
  let wool = 0.82 + 0.2 * valueNoise(vec3<f32>(uv * size * 300.0, 2.0)) + 0.08 * fbm(vec3<f32>(uv * size * 8.0, 1.0));
  return col * wool;
}

// Whether the fringe at uv (beyond the rug's end) has a thread there.
fn fringeThread(uv: vec2<f32>, extra: vec3<f32>) -> bool {
  let width = max(extra.y, 0.1);
  let t = uv.x * width / 0.006;
  let beyond = select(-uv.y, uv.y - 1.0, uv.y > 1.0) * max(extra.z, 0.1);
  let len = 0.035 + 0.015 * hash31(vec3<i32>(i32(t), select(0, 1, uv.y > 1.0), 9));
  return fract(t) < 0.55 && beyond < len;
}
