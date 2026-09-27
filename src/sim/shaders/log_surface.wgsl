// Log surfaces. One thread per surface-map texel (slice k along the log, angle t around it).
// Finds the surface radius, then balances the heat arriving there:
//   convection from the gas next to it,
//   radiation from the flames, the coal bed, the walls, the room and the other logs,
//   the surface's own glow, and heat from char burning with oxygen.
// Also collects the wood gas and steam the interior gives off and reports them as surface
// fluxes for the gas solver.

@group(0) @binding(0) var<uniform> LP: LogStep;
@group(0) @binding(1) var<storage, read> logs: array<LogGPU>;
@group(0) @binding(2) var<storage, read> state: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> prod: array<vec4<f32>>;
@group(0) @binding(4) var gas: texture_3d<f32>;
@group(0) @binding(5) var gasVel: texture_3d<f32>;
@group(0) @binding(6) var linSamp: sampler;
@group(0) @binding(7) var<storage, read> rad: array<vec4<f32>>;
@group(0) @binding(8) var geoOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(9) var fluxOut: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(10) var<storage, read_write> surf: array<vec4<f32>>;
@group(0) @binding(11) var bedMap: texture_2d<f32>;

fn voxelAt(log: u32, k: u32, i: vec2<i32>) -> vec4<f32> {
  if (any(i < vec2<i32>(0)) || any(i >= vec2<i32>(i32(LOG_NX)))) { return vec4<f32>(0.0); }
  return state[voxelIndex(log, u32(i.x), u32(i.y), k)];
}

fn prodAt(log: u32, k: u32, i: vec2<i32>) -> vec4<f32> {
  if (any(i < vec2<i32>(0)) || any(i >= vec2<i32>(i32(LOG_NX)))) { return vec4<f32>(0.0); }
  return prod[voxelIndex(log, u32(i.x), u32(i.y), k)];
}

// Bilinear footprint of cross-section point p (m) in the voxel grid.
fn footprint(p: vec2<f32>, L: LogGPU) -> vec4<f32> {
  let g = (p + L.e1.w) / voxelSize(L) - 0.5;
  return vec4<f32>(floor(g), g - floor(g));
}

fn sliceFill(log: u32, k: u32, p: vec2<f32>, L: LogGPU) -> f32 {
  let fp = footprint(p, L);
  let i0 = vec2<i32>(fp.xy);
  let f00 = voxelFill(voxelAt(log, k, i0), L);
  let f10 = voxelFill(voxelAt(log, k, i0 + vec2<i32>(1, 0)), L);
  let f01 = voxelFill(voxelAt(log, k, i0 + vec2<i32>(0, 1)), L);
  let f11 = voxelFill(voxelAt(log, k, i0 + vec2<i32>(1, 1)), L);
  return mix(mix(f00, f10, fp.z), mix(f01, f11, fp.z), fp.w);
}

// Bilinear voxel state weighted by how solid each voxel is, so empty voxels don't count and
// the staircase of a voxelised circle doesn't show up as stripes in the surface temperature.
// (The last wisps of a burnt-out voxel no longer change, so they don't count either: where a log
// has burnt right through, nothing is left to be hot.)
fn sliceState(log: u32, k: u32, p: vec2<f32>, L: LogGPU) -> vec4<f32> {
  let fp = footprint(p, L);
  let i0 = vec2<i32>(fp.xy);
  var acc = vec4<f32>(0.0);
  var wsum = 0.0;
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      let st = voxelAt(log, k, i0 + vec2<i32>(i, j));
      let w = mix(1.0 - fp.z, fp.z, f32(i)) * mix(1.0 - fp.w, fp.w, f32(j)) * clamp(voxelFill(st, L) - 0.02, 0.0, 1.0);
      acc += st * w;
      wsum += w;
    }
  }
  return acc / max(wsum, 1e-6);
}

fn sliceProd(log: u32, k: u32, p: vec2<f32>, L: LogGPU) -> vec4<f32> {
  let fp = footprint(p, L);
  let i0 = vec2<i32>(fp.xy);
  let p00 = prodAt(log, k, i0);
  let p10 = prodAt(log, k, i0 + vec2<i32>(1, 0));
  let p01 = prodAt(log, k, i0 + vec2<i32>(0, 1));
  let p11 = prodAt(log, k, i0 + vec2<i32>(1, 1));
  return mix(mix(p00, p10, fp.z), mix(p01, p11, fp.z), fp.w);
}

fn nearestVoxel(p: vec2<f32>, L: LogGPU) -> vec2<i32> {
  return clamp(vec2<i32>(floor((p + L.e1.w) / voxelSize(L))), vec2<i32>(0), vec2<i32>(i32(LOG_NX) - 1));
}

// Temperature of log m's surface near world point p (for radiation between logs).
fn logSurfaceTemp(m: u32, M: LogGPU, p: vec3<f32>) -> f32 {
  let loc = logLocal(M, p);
  let k = u32(clamp(loc.s / M.axis.w * f32(LOG_NS), 0.0, f32(LOG_NS) - 1.0));
  let dir = vec2<f32>(cos(loc.theta), sin(loc.theta));
  let st = voxelAt(m, k, nearestVoxel(dir * max(loc.r - voxelSize(M), 0.0), M));
  return select(LP.wallTemp, st.x, voxelFill(st, M) > 0.05);
}

// Distance along a ray to a capsule, or -1 (after Inigo Quilez).
fn capsuleHit(ro: vec3<f32>, rd: vec3<f32>, pa: vec3<f32>, pb: vec3<f32>, r: f32) -> f32 {
  let ba = pb - pa;
  let oa = ro - pa;
  let baba = dot(ba, ba);
  let bard = dot(ba, rd);
  let baoa = dot(ba, oa);
  let rdoa = dot(rd, oa);
  let oaoa = dot(oa, oa);
  let a = baba - bard * bard;
  var b = baba * rdoa - baoa * bard;
  var c = baba * oaoa - baoa * baoa - r * r * baba;
  var h = b * b - a * c;
  if (h >= 0.0) {
    let t = (-b - sqrt(h)) / a;
    let y = baoa + t * bard;
    if (y > 0.0 && y < baba) { return t; }
    let oc = select(ro - pb, oa, y <= 0.0);
    b = dot(rd, oc);
    c = dot(oc, oc) - r * r;
    h = b * b - c;
    if (h > 0.0) { return -b - sqrt(h); }
  }
  return -1.0;
}

// Temperature the coal bed (or the bare hearth under it) radiates at, at point p on it: coals
// under a skin of ash radiate from the ash's cooler surface.
fn bedTempAt(p: vec3<f32>) -> f32 {
  let uv = vec2<f32>((p.x - LP.bedRect.x) / (LP.bedRect.y - LP.bedRect.x), (p.z - LP.bedRect.z) / (LP.bedRect.w - LP.bedRect.z));
  let bed = textureSampleLevel(bedMap, linSamp, uv, 0.0);
  return bed.x * (1.0 - ASH_COOLS * bed.w);
}

// Temperature of whatever a ray from a log's surface sees first.
fn seenTemp(o: vec3<f32>, d: vec3<f32>, own: u32) -> f32 {
  var best = 1e6;
  var temp = LP.wallTemp;
  let fw = LP.firebox.x;
  let bw = LP.firebox.y;
  let depth = LP.firebox.z;
  let height = LP.firebox.w;

  if (d.y < -1e-4) {
    let tb = (LP.bedTop - o.y) / d.y;
    let hb = o + d * tb;
    if (tb > 0.0 && hb.x > LP.bedRect.x && hb.x < LP.bedRect.y && hb.z > LP.bedRect.z && hb.z < LP.bedRect.w) {
      best = tb;
      temp = bedTempAt(hb);
    } else {
      let tf = -o.y / d.y;
      if (tf > 0.0) { best = tf; }
    }
  }
  if (LP.enclosure == 1u) {
    // In the open, whatever is not below is the night: dark trees round about, cold sky above.
    if (d.y >= -1e-4) { temp = mix(LP.roomTemp, LP.skyTemp, smoothstep(0.0, 0.6, d.y)); }
    for (var m = 0u; m < MAX_LOGS; m++) {
      let M = logs[m];
      if (m == own || M.a.w < 0.5) { continue; }
      let th = capsuleHit(o, d, M.a.xyz, M.a.xyz + M.axis.xyz * M.axis.w, max(M.wood.w, 0.004));
      if (th > 0.0 && th < best) {
        best = th;
        temp = logSurfaceTemp(m, M, o + d * th);
      }
    }
    return temp;
  }
  if (d.y > 1e-4) {
    let tc = (height - o.y) / d.y;
    if (tc > 0.0 && tc < best) { best = tc; temp = LP.wallTemp; }
  }
  if (d.z < -1e-4) {
    let tw = (-depth - o.z) / d.z;
    if (tw > 0.0 && tw < best) { best = tw; temp = LP.wallTemp; }
  }
  let nl = normalize(vec3<f32>(depth, 0.0, fw - bw));
  let nr = vec3<f32>(-nl.x, 0.0, nl.z);
  let dl = dot(d, nl);
  if (dl < -1e-4) {
    let tl = dot(vec3<f32>(-fw, 0.0, 0.0) - o, nl) / dl;
    if (tl > 0.0 && tl < best) { best = tl; temp = LP.wallTemp; }
  }
  let dr = dot(d, nr);
  if (dr < -1e-4) {
    let tr = dot(vec3<f32>(fw, 0.0, 0.0) - o, nr) / dr;
    if (tr > 0.0 && tr < best) { best = tr; temp = LP.wallTemp; }
  }
  if (d.z > 1e-4) {
    let tz = -o.z / d.z;
    if (tz > 0.0 && tz < best) {
      let hp = o + d * tz;
      best = tz;
      // Through the opening (straight sides, then an arch) it sees the cool room.
      let u = hp.x / LP.opening.x;
      let top = select(0.0, LP.opening.z + (LP.opening.y - LP.opening.z) * sqrt(max(1.0 - u * u, 0.0)), abs(u) < 1.0);
      temp = select(LP.wallTemp, LP.roomTemp, hp.y < top);
    }
  }
  for (var m = 0u; m < MAX_LOGS; m++) {
    let M = logs[m];
    if (m == own || M.a.w < 0.5) { continue; }
    let th = capsuleHit(o, d, M.a.xyz, M.a.xyz + M.axis.xyz * M.axis.w, max(M.wood.w, 0.004));
    if (th > 0.0 && th < best) {
      best = th;
      temp = logSurfaceTemp(m, M, o + d * th);
    }
  }
  return temp;
}

fn gasSample(p: vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(gas, linSamp, (p - LP.simOrigin) / (LP.simDims * LP.simH), 0.0);
}

fn gasSpeed(p: vec3<f32>) -> f32 {
  let x = (p - LP.simOrigin) / LP.simH;
  let inv = 1.0 / (LP.simDims + 1.0);
  let v = vec3<f32>(
    textureSampleLevel(gasVel, linSamp, (x + vec3<f32>(0.5, 0.0, 0.0)) * inv, 0.0).x,
    textureSampleLevel(gasVel, linSamp, (x + vec3<f32>(0.0, 0.5, 0.0)) * inv, 0.0).y,
    textureSampleLevel(gasVel, linSamp, (x + vec3<f32>(0.0, 0.0, 0.5)) * inv, 0.0).z);
  return length(v);
}

fn hash2(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2<f32>(1.0, 0.0)), u.x), mix(hash2(i + vec2<f32>(0.0, 1.0)), hash2(i + vec2<f32>(1.0, 1.0)), u.x), u.y);
}

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let k = gid.x;
  let t = gid.y;
  let log = gid.z;
  if (k >= LOG_NS || t >= MAP_NT || log >= MAX_LOGS) { return; }
  let L = logs[log];
  let col = (log * LOG_NS + k) * MAP_NT + t;
  let texel = vec2<i32>(i32(k), i32(t));
  if (L.a.w < 0.5) {
    textureStore(geoOut, texel, i32(log), vec4<f32>(0.0));
    textureStore(fluxOut, texel, i32(log), vec4<f32>(0.0));
    surf[col] = vec4<f32>(0.0);
    return;
  }

  let dx = voxelSize(L);
  let ds = L.axis.w / f32(LOG_NS);
  let s = (f32(k) + 0.5) * ds;
  let theta = (f32(t) + 0.5) * TAU / f32(MAP_NT);
  let dir = vec2<f32>(cos(theta), sin(theta));

  // Surface radius: march inward until the log is more than half solid.
  var radius = 0.0;
  var prevR = L.e1.w;
  var prevF = sliceFill(log, k, dir * prevR, L);
  var r = prevR - dx * 0.34;
  loop {
    if (r <= 0.0) { break; }
    let f = sliceFill(log, k, dir * r, L);
    if (f >= 0.5) {
      radius = mix(prevR, r, clamp((0.5 - prevF) / max(f - prevF, 1e-4), 0.0, 1.0));
      break;
    }
    prevR = r;
    prevF = f;
    r -= dx * 0.34;
  }

  // The wood just under the surface stands for the surface.
  let st = sliceState(log, k, dir * max(radius - 0.6 * dx, 0.0), L);
  let Ts = max(st.x, 250.0);
  let charFrac = voxelChar(st, L);

  let p = logWorld(L, s, dir.x * radius, dir.y * radius);
  let n = normalize(L.e1.xyz * dir.x + L.e2.xyz * dir.y);
  let probe = p + n * (0.7 * LP.simH + 0.002);
  let g = gasSample(probe);
  let speed = gasSpeed(probe);
  let ox = clamp(g.z, 0.0, 1.0);

  // Radiation arriving: everything around (12 cosine-weighted rays) plus the flames.
  let helper = select(vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), abs(n.y) > 0.9);
  let ta = normalize(cross(n, helper));
  let tb = cross(n, ta);
  // The same ray pattern for every column, so neighbours agree.
  var surround = 0.0;
  for (var i = 0u; i < 12u; i++) {
    let rr = sqrt((f32(i) + 0.5) / 12.0);
    let phi = f32(i) * 2.39996;
    let d = normalize(ta * (rr * cos(phi)) + tb * (rr * sin(phi)) + n * sqrt(1.0 - rr * rr));
    let seen = seenTemp(p + n * 0.003, d, log);
    surround += SIGMA * seen * seen * seen * seen;
  }
  surround /= 12.0;
  // Each block stands for the flames spread through it (4 x 3 x 2 of them over the gas grid, as
  // in radiation.wgsl): from close by it is a glowing cloud, not a point, so its light is
  // spread over about half its size. (The flame right by the surface comes next.)
  let block = LP.simDims * LP.simH / vec3<f32>(4.0, 3.0, 2.0);
  let spread = 0.5 * min(block.x, min(block.y, block.z));
  var flames = 0.0;
  for (var b = 0u; b < LP.radBlocks; b++) {
    let blk = rad[b];
    let l = blk.xyz - p;
    let d2 = dot(l, l) + spread * spread;
    flames += blk.w * max(dot(n, l) * inverseSqrt(d2), 0.0) / (12.566 * d2);
  }
  // Flame right by the surface: the gas within a few centimetres radiates half its heat onto
  // it (the same emission that cools the gas in the solver). This is what heats wood that sits
  // in a flame, and what carries a fire along a log; the blocks above are too coarse for it.
  let roomK = LP.roomTemp * 0.001;
  var flameNear = 0.0; // the hottest gas in the first few centimetres out from the wood
  for (var j = 0u; j < 4u; j++) {
    let q = gasSample(p + n * (0.005 + 0.01 * f32(j)));
    let tk = q.x * 0.001;
    flames += 0.5 * 0.01 * LP.cooling * (1.0 + 6.0 * max(q.w, 0.0)) * max(tk * tk * tk * tk - roomK * roomK * roomK * roomK, 0.0) * 1200.0;
    flameNear = max(flameNear, q.x);
  }
  // Flames are not black: even wood sitting right in a big fire gets no more than this.
  flames = min(flames * LP.flameGain, FLAME_FLUX_MAX);

  // Glowing char burns with the oxygen that reaches it; less through a skin of its own ash,
  // which is why embers glow on for so long.
  let ash = clamp(prodAt(log, k, nearestVoxel(dir * max(radius - 0.5 * dx, 0.0), L)).z / 2.5, 0.0, 1.0);
  var charBurn = 0.0;
  if (st.w > 2.0 && ox > 0.005 && Ts > 500.0) {
    let kin = CHAR_A * exp(-CHAR_E_R / Ts);
    let dif = CHAR_DIFF * ox * (1.0 + 1.5 * speed) * (1.0 - ASH_SLOWS * ash);
    charBurn = min(kin * dif / (kin + dif), st.w * dx / max(LP.dt, 1e-3));
  }

  // Gas the interior of this wedge gives off (it finds its way out through the char to this
  // patch of surface), and steam from drying. Cracks let it out in patches.
  var gasOut = vec2<f32>(0.0);
  for (var j = 0u; j < 12u; j++) {
    let rj = (f32(j) + 0.5) / 12.0 * radius;
    gasOut += sliceProd(log, k, dir * rj, L).xy * rj;
  }
  gasOut *= radius / 12.0 / max(radius, dx);
  let crack = 0.35 + 1.3 * noise2(vec2<f32>((s + L.vel.w) * 28.0, theta * L.e2.w * 28.0) + L.look.w * 17.0);
  let moisture = st.y / max(L.wood.z, 1e-3);

  // This patch's own flame: its wood gas burns in a sheet just off the surface, thinner than the
  // gas grid can show, and sends part of its heat back into the wood. That is what keeps a
  // flaming log alight and carries flame along it. It burns only once lit (hot gas or flame
  // beside it) and where there is air.
  // Its heat reaches the wood from a flame at ~1350 K: less as the surface itself gets that hot,
  // and never more than a small flame gives (tens of kW/m2). A flamelet only millimetres thick,
  // on a patch just catching with no real flame by it yet, loses most of its heat to the air
  // round it; once there is flame beside the wood it sends back its full share. So flames creep
  // along a log, rather than racing, until the fire has built up round it.
  let air = clamp(gasSample(p + n * 0.015).z, 0.0, 1.0);
  let alight = smoothstep(600.0, 850.0, max(g.x, Ts - 50.0)) * smoothstep(0.02, 0.12, air);
  let thick = mix(SMALL_FLAME, 1.0, smoothstep(800.0, 1100.0, flameNear));
  let flameHeat = min(FLAME_FEEDBACK * gasOut.x * crack * WOODGAS_HEAT, FLAME_FEEDBACK_MAX) * alight * thick;
  let feedback = flameHeat * clamp((FLAME_TEMP - Ts) / 800.0, 0.0, 1.0);

  // Convection: stronger in moving gas, and on thin sticks (the boundary layer round a small
  // cylinder is thinner: h goes as 1 / sqrt(diameter)), which is why kindling catches so fast.
  let hc = (8.0 + 12.0 * pow(speed, 0.6)) * sqrt(0.05 / max(L.wood.w, 0.006));
  let eps = mix(0.85, 0.95, charFrac);
  let qNet = hc * (g.x - Ts) + eps * (surround + flames) - eps * SIGMA * Ts * Ts * Ts * Ts + charBurn * CHAR_HEAT + feedback;
  // How fast that falls as the surface heats up; lets the voxel update stay stable.
  let slope = hc + 4.0 * eps * SIGMA * Ts * Ts * Ts + select(0.0, flameHeat / 800.0, Ts > FLAME_TEMP - 800.0 && Ts < FLAME_TEMP);
  surf[col] = vec4<f32>(qNet, slope, charBurn, Ts);

  textureStore(geoOut, texel, i32(log), vec4<f32>(radius, Ts, charFrac, ash));
  textureStore(fluxOut, texel, i32(log), vec4<f32>(gasOut.x * crack, gasOut.y, charBurn * CO_PER_CHAR, moisture));
}
