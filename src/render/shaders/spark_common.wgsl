// A spark: a speck of glowing char. 32 bytes.
struct Spark {
  pos: vec3<f32>,
  life: f32, // seconds left; <= 0 means unused
  vel: vec3<f32>,
  temp: f32, // K
};
