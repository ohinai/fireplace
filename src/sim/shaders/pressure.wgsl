// One red-black SOR sweep of the pressure Poisson equation. Two pipelines are built from this
// shader, one per colour. Pressure is kept between frames, which warm-starts the solve.
// Walls, logs and the flue are Neumann boundaries; the fireplace opening is p = 0.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var<storage, read> div: array<f32>;
@group(0) @binding(2) var<storage, read> solid: array<u32>;
@group(0) @binding(3) var<storage, read_write> pressure: array<f32>;

override PARITY: u32 = 0u;
override OMEGA: f32 = 1.85;
// A very weak pull toward ambient pressure. Pockets of air sealed off between logs have no
// open boundary to anchor them; without this their pressure drifts without limit and blows
// out as jets. Elsewhere it changes nothing visible.
const LEAK: f32 = 0.02;

var<private> sum: f32;
var<private> count: f32;

fn visit(n: vec3<i32>) {
  if (!inGrid(n)) {
    if (boundaryKind(n) == BND_OPEN) {
      count += 1.0;
    }
    return;
  }
  let j = cellIndex(n);
  if (solid[j] == SOLID_NONE) {
    sum += pressure[j];
    count += 1.0;
  }
}

@compute @workgroup_size(8, 4, 4)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let y = gid.y;
  let z = gid.z;
  let x = gid.x * 2u + ((y + z + PARITY) & 1u);
  if (x >= P.dims.x || y >= P.dims.y || z >= P.dims.z) { return; }
  let c = vec3<i32>(i32(x), i32(y), i32(z));
  let i = cellIndex(c);
  if (solid[i] != SOLID_NONE) { return; }

  sum = 0.0;
  count = 0.0;
  visit(c - vec3<i32>(1, 0, 0));
  visit(c + vec3<i32>(1, 0, 0));
  visit(c - vec3<i32>(0, 1, 0));
  visit(c + vec3<i32>(0, 1, 0));
  visit(c - vec3<i32>(0, 0, 1));
  visit(c + vec3<i32>(0, 0, 1));
  pressure[i] = mix(pressure[i], (sum - div[i]) / (count + LEAK), OMEGA);
}
