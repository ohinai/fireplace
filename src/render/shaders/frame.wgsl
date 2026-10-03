// Per-frame uniforms shared by all render shaders.
struct Frame {
  viewProj: mat4x4<f32>,
  invViewProj: mat4x4<f32>,
  camPos: vec3<f32>,
  time: f32,
  simOrigin: vec3<f32>,
  simH: f32,
  simDims: vec3<f32>,
  numLights: u32,
  resolution: vec2<f32>,
  exposure: f32,
  kEmit: f32,
  kAbs: f32,
  kBlue: f32,
  tIgnite: f32,
  debugView: u32,
  adaptMax: f32,     // the most the eye adapts to a dark scene (exposure multiplier)
  glowBoost: f32,    // K added to glowing surfaces for display
  bloom: f32,
  lightGain: f32,
  stepScale: f32,
  tAmb: f32,
  frameIdx: f32,
  adaptMin: f32,     // the least (a bright scene)
  kSmoke: f32,       // how visible white smoke is
  volBlend: f32,     // weight of this frame's fire over the previous frames' (1 = no history)
  haze: f32,         // heat haze strength (pixels of offset per unit of hot air)
  frameDt: f32,      // real seconds since the last frame
  opening: vec4<f32>, // fireplace opening: half width (0: a fire in the open), where its arch starts, its top (m); w = room bounce
  candles: array<vec4<f32>, 4>, // small flames: base (m), w = brightness (0 = out). The last is the match.
  lamps: array<vec4<f32>, 4>,   // two lamps: position (w = 0 shade, 1 lantern), colour (w = how brightly its shade glows)
  embers: array<vec4<f32>, 6>,  // three lights standing in for the coal bed: position, colour
  sky: vec4<f32>,       // light from the sky all round (rgb); w = how much of it shows (0..1, for the stars)
  sun: vec4<f32>,       // direction toward the moon, the sun or the window light; w = time of day (0 night, 1 dusk, 2 day)
  sunColour: vec4<f32>, // its light (rgb)
  bed: vec4<f32>,       // coal bed: x min, x max, z min, z max
  clock: vec4<f32>,     // x: seconds since midnight, local time (for a clock on the mantel)
  starsToWorld: array<vec4<f32>, 3>,  // rows of the rotation from star (J2000) directions to the world
  worldToGalaxy: array<vec4<f32>, 3>, // rows of the rotation from world directions to galactic ones
  moon: vec4<f32>,      // direction toward the moon; w: how much of its face is lit (0..1)
  moonSun: vec4<f32>,   // direction from the moon toward the sun (to shade its disc); w: its radius (rad)
  sunDir: vec4<f32>,    // direction toward the sun; w: its altitude (rad)
  skyLook: vec4<f32>,   // x: the faintest stars to show (magnitude), y: how bright the Milky Way is, z: moonlight on the sky
  grade: vec4<f32>,     // x: colour saturation (1 as it is); y: starlight (how much the stars are brought out, 0 as the eye sees them); z: 1 to draw the fire with a smooth filter (Ultra); w: fine detail for the flames (0..1, on a coarse grid)
  fades: array<vec4<f32>, 8>, // how see-through each thing that can turn so is, by its number (1 up): 0..1
  fire: vec4<f32>,      // x: 1 to sample the fire at fixed places rather than random ones (Low)
};
