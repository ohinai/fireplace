// Shared definitions for the fire solver. Every solver shader binds `P` at group 0, binding 0.
//
// Grid coordinates are in cells: cell (i, j, k) spans [i, i+1] x [j, j+1] x [k, k+1] and has its
// centre at (i + 0.5, j + 0.5, k + 0.5). x runs left to right, y upward, z from the back wall
// (z = 0) toward the fireplace opening.
//
// Velocity lives on a staggered (MAC) grid, packed into one texture of (dims + 1) texels:
//   texel (i, j, k).x = u on the x-face at (i, j + .5, k + .5)
//   texel (i, j, k).y = v on the y-face at (i + .5, j, k + .5)
//   texel (i, j, k).z = w on the z-face at (i + .5, j + .5, k)
// i.e. each texel holds the velocities through the three "min" faces of cell (i, j, k).
// Components beyond the last face along the other axes are padding (copies of the nearest face).
// Velocities are in m/s.
//
// Scalar field channels (at cell centres): x = temperature (K), y = fuel gas, z = oxygen, w = soot.
// Aux field channels: x = white smoke (tar droplets and condensed steam), y = CO (from glowing
// char and coals; it burns separately from wood gas: see forces.wgsl), zw unused.
//
// In a fireplace the grid fills the firebox: walls all round, room air coming in through the
// opening, the flue pulling gas out at the top. Round a campfire the grid is a box of open air
// standing on the ground: air comes and goes freely through its sides and top.

// A small flame the solver adds itself: a burning firelighter, or a match.
struct Burner {
  pos: vec4<f32>, // xyz centre (cells), w radius (cells)
  src: vec4<f32>, // x fuel it gives off and z fuel burnt on the spot (volume fraction per second at its centre); y its temperature (K)
};

struct SimParams {
  dims: vec3<u32>,
  frame: u32,
  origin: vec3<f32>,
  h: f32,
  dt: f32,
  time: f32,
  tAmb: f32,
  buoyancy: f32,
  vorticity: f32,
  damping: f32,
  burnRate: f32,
  tIgnite: f32,
  heatRelease: f32,
  stoich: f32,
  sootYield: f32,
  sootBurn: f32,
  cooling: f32,
  archApex: f32,        // top of the fireplace opening (cells above the hearth)
  flueSpeed: f32,
  turbulence: f32,
  smokeYield: f32,      // how readily cooled, unburnt wood gas condenses into white smoke
  smokeDecay: f32,      // how fast smoke thins out (1/s)
  emberTemp: f32,       // coal bed temperature (K)
  emberFuel: f32,       // CO given off by the coal bed (cell volumes per second)
  blowPos: vec4<f32>,   // xyz cells, w radius in cells
  blowVel: vec4<f32>,   // xyz m/s, w strength
  ember: vec4<f32>,     // ember bed extent in cells: xmin, xmax, zmin, zmax
  walls: vec4<f32>,     // centre x, half width at back, half width at opening, z of opening (cells)
  throat: vec4<f32>,    // flue opening in the top face (cells): x min, x max, z min, z max
  emberHeight: f32,
  archSpring: f32,      // where the opening's straight sides end and its arch begins (cells)
  expansion: f32,
  archHalfWidth: f32,   // half the opening's width (cells)
  enclosure: u32,       // 0: a fireplace; 1: a fire in the open air
  ringHeight: f32,      // stones round a campfire: height of the ring (cells)
  gravity: f32,         // m/s2
  pad1: f32,
  ring: vec4<f32>,      // centre x, centre z, inner and outer radius of the ring (cells)
  burners: array<Burner, 4>,
};

const SOLID_NONE: u32 = 0u;
const SOLID_WALL: u32 = 1u;
const SOLID_LOG: u32 = 16u; // plus the log's index

// What lies beyond the edge of the grid.
const BND_WALL: u32 = 0u; // hearth (or ground), sides, back wall, above the opening, smoke shelf
const BND_OPEN: u32 = 1u; // the fireplace opening, or open air: still air at ambient pressure
const BND_FLUE: u32 = 2u; // the throat: the chimney pulls gas out at a set speed

// Face states.
const FACE_FREE: u32 = 0u;
const FACE_BLOCKED: u32 = 1u;
const FACE_FLUE: u32 = 2u;

fn cellIndex(c: vec3<i32>) -> u32 {
  return u32(c.x) + P.dims.x * (u32(c.y) + P.dims.y * u32(c.z));
}

fn inGrid(c: vec3<i32>) -> bool {
  return all(c >= vec3<i32>(0)) && all(c < vec3<i32>(P.dims));
}

fn axisI(a: u32) -> vec3<i32> {
  return vec3<i32>(select(0, 1, a == 0u), select(0, 1, a == 1u), select(0, 1, a == 2u));
}

fn axisF(a: u32) -> vec3<f32> {
  return vec3<f32>(axisI(a));
}

// Top of the fireplace opening (cells) above x (cells across): straight sides up to the
// springing line, then an arch (flat, for a lintel).
fn openingTop(x: f32) -> f32 {
  let u = (x - P.walls.x) / P.archHalfWidth;
  if (abs(u) >= 1.0) { return 0.0; }
  return P.archSpring + (P.archApex - P.archSpring) * sqrt(1.0 - u * u);
}

// Kind of region at out-of-grid cell c.
fn boundaryKind(c: vec3<i32>) -> u32 {
  if (P.enclosure == 1u) {
    return select(BND_OPEN, BND_WALL, c.y < 0);
  }
  let d = vec3<i32>(P.dims);
  let x = vec3<f32>(c) + 0.5;
  if (c.y >= d.y) {
    if (x.x > P.throat.x && x.x < P.throat.y && x.z > P.throat.z && x.z < P.throat.w) { return BND_FLUE; }
    return BND_WALL;
  }
  if (c.z >= d.z && c.y >= 0 && x.y < openingTop(x.x) && c.x >= 0 && c.x < d.x) { return BND_OPEN; }
  return BND_WALL;
}

// True when a (traced) position lies in the room in front of the opening (or, in the open, in
// the air outside the grid).
fn fromRoom(x: vec3<f32>) -> bool {
  if (P.enclosure == 1u) {
    return x.y > 0.0 && (any(x < vec3<f32>(0.0)) || any(x > vec3<f32>(P.dims)));
  }
  return x.z > f32(P.dims.z) && x.y > 0.0 && x.y < openingTop(x.x);
}

// Whether texel t holds a real face for component a (rather than padding).
fn faceValid(t: vec3<i32>, a: u32) -> bool {
  var m = vec3<i32>(P.dims) - 1;
  m[a] = i32(P.dims[a]);
  return all(t <= m);
}

// Nearest real face for component a.
fn clampFace(t: vec3<i32>, a: u32) -> vec3<i32> {
  var m = vec3<i32>(P.dims) - 1;
  m[a] = i32(P.dims[a]);
  return min(t, m);
}

// Position (cells) of the component-a face stored at texel t.
fn facePos(t: vec3<i32>, a: u32) -> vec3<f32> {
  return vec3<f32>(t) + 0.5 - 0.5 * axisF(a);
}

fn ambient() -> vec4<f32> {
  return vec4<f32>(P.tAmb, 0.0, 1.0, 0.0);
}

fn cellWorld(p: vec3<f32>) -> vec3<f32> {
  return P.origin + p * P.h;
}

fn pcg3d(v0: vec3<u32>) -> vec3<u32> {
  var v = v0 * 1664525u + 1013904223u;
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  v ^= v >> vec3<u32>(16u);
  v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
  return v;
}

fn hash31(p: vec3<i32>) -> f32 {
  return f32(pcg3d(bitcast<vec3<u32>>(p)).x) * (1.0 / 4294967296.0);
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
