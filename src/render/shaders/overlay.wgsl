// Science overlays, drawn over the finished picture: the box the air is worked out in; a slice
// through the fire showing the grid of its cells, which of them the air takes to be solid (wood,
// and the walls or stones), and arrows for the flow of the air across it.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> O: Overlay;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var vel: texture_3d<f32>;

struct Overlay {
  origin: vec3<f32>, // the grid's corner (m)
  h: f32,            // its cell size (m)
  dims: vec3<u32>,   // its size in cells
  axis: u32,         // the slice: 0 across x and y (at a depth in z); 1 across z and y (at an x)
  slice: u32,        // which layer of cells it cuts
  every: u32,        // grid lines, and arrows, every this many cells
  scale: f32,        // an arrow's length (m) per square root of m/s
  pad: f32,
};

const SOLID_LOG: u32 = 16u; // (as in the solver: walls below this, logs from it up)

struct LineOut {
  @builtin(position) clip: vec4<f32>,
  @location(0) colour: vec4<f32>,
};

// The slice's size in cells: across, and up.
fn sliceSize() -> vec2<u32> {
  return select(vec2<u32>(O.dims.z, O.dims.y), vec2<u32>(O.dims.x, O.dims.y), O.axis == 0u);
}

// The grid cell at column a, row b of the slice.
fn sliceCell(a: u32, b: u32) -> vec3<u32> {
  return select(vec3<u32>(O.slice, b, a), vec3<u32>(a, b, O.slice), O.axis == 0u);
}

// A point on the slice (across, up, in cells), in the middle of the layer it cuts (m).
fn slicePoint(a: f32, b: f32) -> vec3<f32> {
  let mid = f32(O.slice) + 0.5;
  let c = select(vec3<f32>(mid, b, a), vec3<f32>(a, b, mid), O.axis == 0u);
  return O.origin + c * O.h;
}

fn offScreen() -> LineOut {
  var o: LineOut;
  o.clip = vec4<f32>(0.0, 0.0, 2.0, 1.0);
  o.colour = vec4<f32>(0.0);
  return o;
}

fn placed(p: vec3<f32>, colour: vec4<f32>) -> LineOut {
  var o: LineOut;
  o.clip = F.viewProj * vec4<f32>(p, 1.0);
  o.colour = colour;
  return o;
}

// The box the air is worked out in: its twelve edges.
@vertex
fn vsBox(@builtin(vertex_index) vi: u32) -> LineOut {
  var ends = array<vec3<f32>, 24>(
    vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 1.0), vec3<f32>(1.0, 1.0, 1.0),
    vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(1.0, 1.0, 0.0),
    vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(0.0, 1.0, 1.0), vec3<f32>(1.0, 0.0, 1.0), vec3<f32>(1.0, 1.0, 1.0),
    vec3<f32>(0.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(1.0, 0.0, 1.0),
    vec3<f32>(0.0, 1.0, 0.0), vec3<f32>(0.0, 1.0, 1.0), vec3<f32>(1.0, 1.0, 0.0), vec3<f32>(1.0, 1.0, 1.0));
  return placed(O.origin + ends[vi] * vec3<f32>(O.dims) * O.h, vec4<f32>(0.75, 0.85, 1.0, 0.55));
}

// The slice's grid: lines across it (one every so many rows), then lines up it.
@vertex
fn vsGrid(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  let n = sliceSize();
  let rows = n.y / O.every + 1u;
  var a = vec2<f32>(0.0, f32(n.x));
  var b = vec2<f32>(f32(min(ii * O.every, n.y)));
  if (ii >= rows) {
    a = vec2<f32>(f32(min((ii - rows) * O.every, n.x)));
    b = vec2<f32>(0.0, f32(n.y));
  }
  let k = f32(vi);
  return placed(slicePoint(mix(a.x, a.y, k), mix(b.x, b.y, k)), vec4<f32>(0.75, 0.85, 1.0, 0.22));
}

// The cells of the slice the air takes to be solid: wood (orange), walls and stones (grey).
@vertex
fn vsSolid(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  let n = sliceSize();
  let a = ii % n.x;
  let b = ii / n.x;
  if (b >= n.y) { return offScreen(); }
  let c = sliceCell(a, b);
  let s = solid[c.x + O.dims.x * (c.y + O.dims.y * c.z)];
  if (s == 0u) { return offScreen(); }
  var corners = array<vec2<f32>, 6>(vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0), vec2<f32>(0.0, 1.0));
  let k = corners[vi];
  let colour = select(vec4<f32>(0.62, 0.64, 0.68, 0.3), vec4<f32>(1.0, 0.56, 0.2, 0.42), s >= SOLID_LOG);
  return placed(slicePoint(f32(a) + k.x, f32(b) + k.y), colour);
}

// Blue for still air, through green and yellow, to red at 3 m/s and more.
fn speedColour(x: f32) -> vec3<f32> {
  let c = clamp(x, 0.0, 1.0);
  return clamp(vec3<f32>(1.8 * c - 0.35, 1.3 - abs(2.2 * c - 1.1), 1.2 - 2.0 * c), vec3<f32>(0.0), vec3<f32>(1.0));
}

// A stroke from a to b, `width` pixels wide: vertex k (0..5) of the two triangles that make it.
fn stroke(a: vec3<f32>, b: vec3<f32>, k: u32, width: f32) -> vec4<f32> {
  let ca = F.viewProj * vec4<f32>(a, 1.0);
  let cb = F.viewProj * vec4<f32>(b, 1.0);
  let px = F.resolution * 0.5;
  var d = cb.xy / cb.w * px - ca.xy / ca.w * px;
  let l = length(d);
  d = select(vec2<f32>(1.0, 0.0), d / l, l > 1e-4);
  let side = vec2<f32>(-d.y, d.x) * width / F.resolution;
  var ends = array<f32, 6>(0.0, 1.0, 1.0, 0.0, 1.0, 0.0);
  var sides = array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0);
  let c = select(ca, cb, ends[k] > 0.5);
  return vec4<f32>(c.xy + side * sides[k] * c.w, c.z, c.w);
}

// The air's flow across the slice: an arrow in the middle of every so many cells, longer the
// faster the air (as the square root of its speed, up to a little more than the gap between
// arrows), with a head of two short strokes. (The flow straight through the slice does not show.)
@vertex
fn vsFlow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> LineOut {
  let n = sliceSize();
  let cols = n.x / O.every;
  let a = (ii % cols) * O.every + O.every / 2u;
  let b = (ii / cols) * O.every + O.every / 2u;
  if (a >= n.x || b >= n.y) { return offScreen(); }
  let c = sliceCell(a, b);
  if (solid[c.x + O.dims.x * (c.y + O.dims.y * c.z)] != 0u) { return offScreen(); }
  // (Each component sits on the cell's faces: the middle's is the average of the two.)
  let ci = vec3<i32>(c);
  let v0 = textureLoad(vel, ci, 0).xyz;
  let u = 0.5 * (v0.x + textureLoad(vel, ci + vec3<i32>(1, 0, 0), 0).x);
  let v = 0.5 * (v0.y + textureLoad(vel, ci + vec3<i32>(0, 1, 0), 0).y);
  let w = 0.5 * (v0.z + textureLoad(vel, ci + vec3<i32>(0, 0, 1), 0).z);
  let flow = select(vec3<f32>(0.0, v, w), vec3<f32>(u, v, 0.0), O.axis == 0u);
  let speed = length(flow);
  if (speed < 0.02) { return offScreen(); }
  let len = min(sqrt(speed) * O.scale, f32(O.every) * O.h * 1.3);
  let dir = flow / speed;
  let mid = slicePoint(f32(a) + 0.5, f32(b) + 0.5);
  let tail = mid - dir * len * 0.5;
  let tip = mid + dir * len * 0.5;
  let across = cross(select(vec3<f32>(1.0, 0.0, 0.0), vec3<f32>(0.0, 0.0, 1.0), O.axis == 0u), dir);
  let barb = tip - dir * len * 0.34;
  let seg = vi / 6u;
  var start = tail;
  var end = tip;
  if (seg == 1u) { start = tip; end = barb + across * len * 0.18; }
  if (seg == 2u) { start = tip; end = barb - across * len * 0.18; }
  var o: LineOut;
  o.clip = stroke(start, end, vi % 6u, 1.7);
  o.colour = vec4<f32>(speedColour(speed / 3.0), 0.95);
  return o;
}

@fragment
fn fsOverlay(in: LineOut) -> @location(0) vec4<f32> {
  return in.colour;
}
