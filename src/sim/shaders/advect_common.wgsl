// Bindings and helpers shared by both halves of the MacCormack advection step.

@group(0) @binding(0) var<uniform> P: SimParams;
@group(0) @binding(1) var linSamp: sampler;
@group(0) @binding(2) var velIn: texture_3d<f32>;
@group(0) @binding(3) var scalIn: texture_3d<f32>;
@group(0) @binding(4) var auxIn: texture_3d<f32>;

fn velTexSize() -> vec3<f32> {
  return vec3<f32>(P.dims + vec3<u32>(1u));
}

// Component a of a staggered velocity texture at position x (cells).
fn sampleComp(tex: texture_3d<f32>, x: vec3<f32>, a: u32) -> f32 {
  return textureSampleLevel(tex, linSamp, (x + 0.5 * axisF(a)) / velTexSize(), 0.0)[a];
}

fn sampleVel(x: vec3<f32>) -> vec3<f32> {
  return vec3<f32>(sampleComp(velIn, x, 0u), sampleComp(velIn, x, 1u), sampleComp(velIn, x, 2u));
}

// Longest stretch (cells) of each step of a trace: one that would go further is taken in several
// steps (up to eight). 0: in one step, however far.
override TRACE_CELLS: f32 = 0.0;

// Second-order (midpoint) trace through the velocity field. s = dt / h; negative traces forward.
// On the finest grid it is taken in short steps (TRACE_CELLS): a swirl a few cells across turns a
// long way there in one step of the fire, and a single long step would skip it (its midpoint would
// land in the still air beside the swirl, and leave the swirl where it was, neither carried nor
// worn down, for the confinement and the flicker to spin up without end).
fn trace(x0: vec3<f32>, s: f32) -> vec3<f32> {
  var v = sampleVel(x0);
  var n = 1.0;
  if (TRACE_CELLS > 0.0) {
    n = clamp(ceil(length(v) * abs(s) / TRACE_CELLS), 1.0, 8.0);
  }
  let ds = s / n;
  var x = x0;
  for (var i = 0.0; i < n; i += 1.0) {
    if (i > 0.0) { v = sampleVel(x); }
    x -= ds * sampleVel(x - 0.5 * ds * v);
  }
  return x;
}

fn sampleScal(tex: texture_3d<f32>, x: vec3<f32>) -> vec4<f32> {
  return textureSampleLevel(tex, linSamp, x / vec3<f32>(P.dims), 0.0);
}
