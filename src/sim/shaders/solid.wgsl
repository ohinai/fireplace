// Marks cells occupied by logs (using each log's current, burnt-away shape; the mark says which
// log), by the splayed firebox side walls, or by the stones round a campfire.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var<storage, read> logs: array<LogGPU>;
@group(0) @binding(2) var geoMap: texture_2d_array<f32>;
@group(0) @binding(3) var mapSamp: sampler;
@group(0) @binding(4) var<storage, read_write> solid: array<u32>;

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (any(gid >= P.dims)) { return; }
  let p = vec3<f32>(gid) + 0.5;
  var s = SOLID_NONE;

  if (P.enclosure == 0u) {
    let t = clamp(p.z / P.walls.w, 0.0, 1.0);
    let halfWidth = mix(P.walls.y, P.walls.z, t);
    if (abs(p.x - P.walls.x) > halfWidth) { s = SOLID_WALL; }
  } else {
    // The ring of stones, as a low wall with a rounded top.
    let d = length(p.xz - P.ring.xy);
    let u = (d - 0.5 * (P.ring.z + P.ring.w)) / (0.5 * (P.ring.w - P.ring.z));
    if (abs(u) < 1.0 && p.y < P.ringHeight * sqrt(1.0 - u * u)) { s = SOLID_WALL; }
  }

  let wp = cellWorld(p);
  for (var k = 0u; k < MAX_LOGS; k++) {
    let L = logs[k];
    if (L.a.w < 0.5) { continue; }
    let loc = logLocal(L, wp);
    if (loc.s < 0.0 || loc.s > L.axis.w || loc.r > L.e1.w) { continue; }
    let radius = textureSampleLevel(geoMap, mapSamp, logMapUV(L, loc.s, loc.theta), i32(k), 0.0).x;
    if (loc.r < radius) { s = SOLID_LOG + k; }
  }
  solid[cellIndex(vec3<i32>(gid))] = s;
}
