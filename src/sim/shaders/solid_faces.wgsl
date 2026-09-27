// Face classification; needs a `solid: array<u32>` binding.

fn isSolid(c: vec3<i32>) -> bool {
  return solid[cellIndex(c)] != SOLID_NONE;
}

// State of the component-a face stored at texel t, between cells t - e_a and t.
fn faceKind(t: vec3<i32>, a: u32) -> u32 {
  let ca = t - axisI(a);
  let aIn = inGrid(ca);
  let bIn = inGrid(t);
  if (aIn && bIn) {
    return select(FACE_FREE, FACE_BLOCKED, isSolid(ca) || isSolid(t));
  }
  let inside = select(ca, t, bIn);
  if (!inGrid(inside) || isSolid(inside)) { return FACE_BLOCKED; }
  let k = boundaryKind(select(t, ca, bIn));
  if (k == BND_OPEN) { return FACE_FREE; }
  if (k == BND_FLUE) { return FACE_FLUE; }
  return FACE_BLOCKED;
}
