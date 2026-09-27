// Logs, shaped and coloured by the log model. The surface map gives every point its radius
// (so logs shrink and burn through), temperature, char and ash; the cut ends show the voxels
// inside, with the char ring creeping inward.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> bb: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read> logs: array<LogGPU>;
@group(0) @binding(4) var geoMap: texture_2d_array<f32>;
@group(0) @binding(5) var fluxMap: texture_2d_array<f32>;
@group(0) @binding(6) var mapSamp: sampler;
@group(0) @binding(7) var<storage, read> look: array<vec4<f32>>;
@group(0) @binding(8) var<storage, read> prod: array<vec4<f32>>; // w: moisture content

struct VOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) wpos: vec3<f32>,
  @location(1) nrm: vec3<f32>,
  @location(2) uv: vec2<f32>,  // surface-map coordinates: along, around
  @location(3) cap: f32,       // 0 on the side, -1 / +1 on the cut ends
  @location(4) @interpolate(flat) log: u32,
};

fn radiusAt(log: u32, uv: vec2<f32>) -> f32 {
  return textureSampleLevel(geoMap, mapSamp, uv, i32(log), 0.0).x;
}

// Template vertex: x = along (0..1), y = around (0..1), z = 0 side / 1 end A / 2 end B,
// w = fraction of the radius (ends).
@vertex
fn vs(@location(0) tpl: vec4<f32>, @builtin(instance_index) inst: u32) -> VOut {
  var o: VOut;
  o.log = inst;
  let L = logs[inst];
  if (L.a.w < 0.5) {
    o.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0); // outside the view volume: nothing drawn
    return o;
  }
  let theta = tpl.y * TAU;
  let radial = L.e1.xyz * cos(theta) + L.e2.xyz * sin(theta);
  let tangent = -L.e1.xyz * sin(theta) + L.e2.xyz * cos(theta);
  var uv = tpl.xy;
  var s = 0.0;
  var radius = 0.0;
  var n = radial;
  if (tpl.z < 0.5) {
    s = tpl.x * L.axis.w;
    radius = radiusAt(inst, uv);
    let du = 1.0 / f32(LOG_NS);
    let dv = 1.0 / f32(MAP_NT);
    let dRds = (radiusAt(inst, uv + vec2<f32>(du, 0.0)) - radiusAt(inst, uv - vec2<f32>(du, 0.0))) / (2.0 * du * L.axis.w);
    let dRdt = (radiusAt(inst, uv + vec2<f32>(0.0, dv)) - radiusAt(inst, uv - vec2<f32>(0.0, dv))) / (2.0 * dv * TAU);
    n = normalize(radial - dRds * L.axis.xyz - dRdt / max(radius, 1e-3) * tangent);
    o.cap = 0.0;
  } else {
    let endB = tpl.z > 1.5;
    uv.x = select(0.5 / f32(LOG_NS), 1.0 - 0.5 / f32(LOG_NS), endB);
    s = select(0.0, L.axis.w, endB);
    radius = radiusAt(inst, uv) * tpl.w;
    n = L.axis.xyz * select(-1.0, 1.0, endB);
    o.cap = select(-1.0, 1.0, endB);
  }
  var wpos = L.a.xyz + L.axis.xyz * s + radial * radius;
  // A crooked stick (desert wood) wanders either side of its straight line, kinked here and
  // there. Only its picture: the model burns it straight, which is near enough for a stick.
  let crook = L.spin.w;
  if (crook > 0.0) {
    let u = s + L.vel.w;
    let seed = L.look.w;
    let bendA = sin(u * 13.0 + seed * 5.0) * 0.6 + sin(u * 29.0 + seed * 11.0) * 0.4;
    let bendB = sin(u * 17.0 + seed * 3.0) * 0.6 + sin(u * 37.0 + seed * 7.0) * 0.4;
    wpos += (L.e1.xyz * bendA + L.e2.xyz * bendB) * crook * 0.011;
  }
  o.clip = F.viewProj * vec4<f32>(wpos, 1.0);
  o.wpos = wpos;
  o.nrm = n;
  o.uv = uv;
  return o;
}

// A point in the log's own frame (m): patterns stay put on the wood as it rolls and moves, and
// line up across a break.
fn woodPoint(L: LogGPU, p: vec3<f32>) -> vec3<f32> {
  let rel = p - L.a.xyz;
  return vec3<f32>(dot(rel, L.axis.xyz) + L.vel.w, dot(rel, L.e1.xyz), dot(rel, L.e2.xyz));
}

fn barkColour(L: LogGPU, m: vec2<f32>, p: vec3<f32>) -> vec3<f32> {
  // m: position on the bark in metres (along, around).
  let ridge = fbm(vec3<f32>(m.x * 6.0, m.y * 60.0, L.look.w) + (fbm(p * 25.0) - 0.5) * 1.5);
  let furrow = smoothstep(0.35, 0.6, ridge);
  let base = L.look.rgb * (0.7 + 0.5 * fbm(p * 40.0));
  let ridged = mix(base * 0.25, base, furrow);
  // Pale papery bark (birch) instead has dark marks running around the trunk.
  let pale = smoothstep(0.4, 0.55, L.look.g);
  let marks = smoothstep(0.72, 0.88, fbm(vec3<f32>(m.x * 90.0, m.y * 7.0, L.look.w * 3.0)));
  return mix(ridged, base * (1.0 - 0.85 * marks), pale);
}

fn charColour(cellId: f32) -> vec3<f32> {
  return vec3<f32>(0.022, 0.02, 0.019) * (0.7 + 0.6 * cellId);
}

// The moisture view: wood from bone dry to sodden (water per dry wood, 0 to 50% and over), in
// the colours of its key on screen; char holds no water and shows dark.
fn moistureColour(mc: f32, charred: f32, facing: f32) -> vec3<f32> {
  var stops = array<vec3<f32>, 6>(
    vec3<f32>(0.941, 0.863, 0.659), vec3<f32>(0.851, 0.698, 0.353), vec3<f32>(0.435, 0.682, 0.416),
    vec3<f32>(0.227, 0.608, 0.71), vec3<f32>(0.184, 0.388, 0.769), vec3<f32>(0.294, 0.165, 0.604));
  let x = clamp(mc * 10.0, 0.0, 4.999);
  let i = u32(x);
  let c = pow(mix(stops[i], stops[i + 1u], x - f32(i)), vec3<f32>(2.2));
  return mix(c, vec3<f32>(0.02), charred) * 0.55 * (0.45 + 0.55 * facing);
}

@fragment
fn fs(in: VOut) -> @location(0) vec4<f32> {
  let L = logs[in.log];
  let N = normalize(in.nrm);
  let p = in.wpos;
  let q = woodPoint(L, p);
  var albedo: vec3<f32>;
  var emission = vec3<f32>(0.0);

  if (in.cap == 0.0) {
    let geo = textureSampleLevel(geoMap, mapSamp, in.uv, i32(in.log), 0.0); // radius, T, char, ash
    let moisture = textureSampleLevel(fluxMap, mapSamp, in.uv, i32(in.log), 0.0).w;
    let Ts = geo.y;
    let m = vec2<f32>(in.uv.x * L.axis.w + L.vel.w, in.uv.y * TAU * L.e2.w);

    // Heat toasts the bark brown, then black, before it chars. Damp wood looks darker.
    var col = barkColour(L, m, q);
    let toast = smoothstep(420.0, 650.0, Ts + (fbm(q * 30.0) - 0.5) * 120.0);
    col = mix(col, vec3<f32>(0.09, 0.055, 0.035), toast);
    col *= 1.0 - 0.25 * clamp(moisture, 0.0, 1.0);

    // Char splits into blocks ("alligatoring"); some cracks open wide enough to glow.
    let cells = voronoi(vec3<f32>(m.x * 34.0, m.y * 44.0, L.look.w) + (fbm(q * 30.0) - 0.5) * 0.6);
    let crack = 1.0 - smoothstep(0.015, 0.07, cells.y - cells.x);
    // Char spreads in ragged patches rather than following the surface map's grid.
    let ragged = (fbm(vec3<f32>(m.x * 40.0, m.y * 40.0, L.look.w)) - 0.5) * 0.9;
    let charMix = smoothstep(0.25, 0.55, geo.z + ragged);
    if (F.debugView == 8u) {
      // Moisture view: how wet the wood is just under the surface (flux.w is the share of its
      // water still there).
      return vec4<f32>(moistureColour(moisture * L.wood.z / L.wood.x, charMix, abs(dot(N, normalize(F.camPos - p)))), 1.0);
    }
    col = mix(col, charColour(cells.z), charMix);
    // Burning char grows a grey-white skin of ash, thickest on the block faces; once the flames
    // are gone it covers most of the embers, the glow showing through its cracks.
    let ash = clamp(geo.w * (1.0 - crack) * (0.6 + 0.8 * fbm(q * 60.0)), 0.0, 0.92) * charMix;
    albedo = mix(col, vec3<f32>(0.58, 0.56, 0.53) * (0.85 + 0.25 * fbm(q * 90.0)), ash);

    // Glowing char breathes: brighter and dimmer by turns as the air round it stirs.
    let flicker = 50.0 * (fbm(q * 11.0 + F.time * 0.04) - 0.5);
    let breathe = 70.0 * (fbm(vec3<f32>(q.x * 4.0, q.y * 4.0 + F.time * 0.21, q.z * 4.0 - F.time * 0.13)) - 0.5);
    let open = crack * smoothstep(0.3, 0.7, fbm(q * 18.0) + 0.3 * smoothstep(900.0, 1200.0, Ts));
    let tGlow = Ts + F.glowBoost + flicker + breathe + mix(-40.0, 60.0, open);
    let g = glow(tGlow - 50.0 * ash);
    // Ash on glowing char, lit by the glow round it, looks pale grey.
    let ashLit = vec3<f32>(0.62, 0.55, 0.48) * dot(g, vec3<f32>(0.2126, 0.7152, 0.0722)) * 0.3 * ash;
    emission = (g * (1.0 - 0.8 * ash) + ashLit) * charMix;
    if (F.debugView == 2u) {
      // Fuel view: wood gas coming off the surface (green), CO from glowing char (blue).
      let fl = textureSampleLevel(fluxMap, mapSamp, in.uv, i32(in.log), 0.0);
      return vec4<f32>(0.0, clamp(fl.x * 150.0, 0.0, 1.0), clamp(fl.z * 150.0, 0.0, 1.0), 1.0);
    }
    if (F.debugView == 1u) {
      // Temperature view: surface temperature from 300 K (black) to 1500 K (white).
      let x = clamp((Ts - 300.0) / 1200.0, 0.0, 1.0);
      return vec4<f32>(clamp(vec3<f32>(x * 3.0, x * 3.0 - 1.0, x * 3.0 - 2.0), vec3<f32>(0.0), vec3<f32>(1.0)) * 0.5, 1.0);
    }
  } else {
    // Cut end: sample the voxels of the end slice (bilinear).
    let k = select(0u, LOG_NS - 1u, in.cap > 0.0);
    let loc = logLocal(L, p);
    let g = (vec2<f32>(loc.x, loc.y) + L.e1.w) / voxelSize(L) - 0.5;
    let i0 = clamp(vec2<i32>(floor(g)), vec2<i32>(0), vec2<i32>(i32(LOG_NX) - 2));
    let f = clamp(g - vec2<f32>(i0), vec2<f32>(0.0), vec2<f32>(1.0));
    let v00 = look[voxelIndex(in.log, u32(i0.x), u32(i0.y), k)];
    let v10 = look[voxelIndex(in.log, u32(i0.x + 1), u32(i0.y), k)];
    let v01 = look[voxelIndex(in.log, u32(i0.x), u32(i0.y + 1), k)];
    let v11 = look[voxelIndex(in.log, u32(i0.x + 1), u32(i0.y + 1), k)];
    let v = mix(mix(v00, v10, f.x), mix(v01, v11, f.x), f.y); // T, char, fill, ash

    // Growth rings, darker heartwood, browned by heat, then char with a glowing front.
    let rings = 0.5 + 0.5 * sin(loc.r * 420.0 + fbm(q * 30.0) * 4.0);
    let heart = smoothstep(0.75, 0.3, loc.r / L.e2.w);
    var wood = mix(vec3<f32>(0.66, 0.52, 0.34), vec3<f32>(0.5, 0.36, 0.22), heart) * (0.8 + 0.25 * rings);
    wood = mix(wood, wood * vec3<f32>(0.45, 0.33, 0.24), smoothstep(430.0, 620.0, v.x));
    let charMix = smoothstep(0.2, 0.7, v.y);
    if (F.debugView == 8u) {
      // Moisture view: the cut end shows how wet the wood is inside (dry rim, wetter core).
      let w00 = prod[voxelIndex(in.log, u32(i0.x), u32(i0.y), k)].w;
      let w10 = prod[voxelIndex(in.log, u32(i0.x + 1), u32(i0.y), k)].w;
      let w01 = prod[voxelIndex(in.log, u32(i0.x), u32(i0.y + 1), k)].w;
      let w11 = prod[voxelIndex(in.log, u32(i0.x + 1), u32(i0.y + 1), k)].w;
      return vec4<f32>(moistureColour(mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y), charMix, abs(dot(N, normalize(F.camPos - p)))), 1.0);
    }
    let cells = voronoi(q * 60.0);
    albedo = mix(wood, charColour(cells.z), charMix);
    albedo = mix(albedo, vec3<f32>(0.5, 0.49, 0.47), clamp(v.w * 0.5, 0.0, 0.8) * charMix);
    emission = glow(v.x + F.glowBoost - 20.0) * charMix;
  }
  if (F.debugView == 7u) {
    return vec4<f32>(albedo * 0.5 + emission, 1.0); // unlit materials
  }
  return vec4<f32>(shade(p, N, albedo, 0.03, 10.0, emission), 1.0);
}
