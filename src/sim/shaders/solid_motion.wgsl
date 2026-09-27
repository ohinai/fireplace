// Velocity a blocked face moves at: the surface of a log (logs fall, roll and get carried
// about, pushing the air aside) or nothing for walls. Needs `solid` and `logs` bindings.

fn solidFaceVelocity(t: vec3<i32>, a: u32) -> f32 {
  let ca = t - axisI(a);
  var id = SOLID_NONE;
  if (inGrid(ca)) { id = max(id, solid[cellIndex(ca)]); }
  if (inGrid(t)) { id = max(id, solid[cellIndex(t)]); }
  if (id < SOLID_LOG) { return 0.0; }
  let v = logVelocity(logs[id - SOLID_LOG], cellWorld(facePos(t, a)));
  return clamp(v[a], -4.0, 4.0);
}
