// Lights the part of the scene that stands still, from what was kept of it (scene.wgsl's fsKeep):
// frame to frame only the light on it changes (the flames, the coals, candles and lamps), so only
// the lighting is worked out afresh. It puts back the kept depth too, for everything drawn after.

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> bb: array<vec4<f32>>;
@group(0) @binding(2) var<storage, read> lights: array<vec4<f32>>;
@group(0) @binding(3) var keptAlbedo: texture_2d<f32>; // w: spec
@group(0) @binding(4) var keptNormal: texture_2d<f32>; // w: gloss
@group(0) @binding(5) var keptEmission: texture_2d<f32>; // w: 1 if unlit
@group(0) @binding(6) var keptDepth: texture_depth_2d;

@vertex
fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4<f32> {
  let p = vec2<f32>(f32((vi << 1u) & 2u), f32(vi & 2u));
  return vec4<f32>(p * 2.0 - 1.0, 0.0, 1.0);
}

struct Relit {
  @location(0) colour: vec4<f32>,
  @builtin(frag_depth) depth: f32,
};

@fragment
fn fs(@builtin(position) pos: vec4<f32>) -> Relit {
  let pix = vec2<i32>(pos.xy);
  var out: Relit;
  out.depth = textureLoad(keptDepth, pix, 0);
  out.colour = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  if (out.depth >= 1.0) { return out; }
  let e = textureLoad(keptEmission, pix, 0);
  if (e.w > 0.5) {
    out.colour = vec4<f32>(e.rgb, 1.0);
    return out;
  }
  let a = textureLoad(keptAlbedo, pix, 0);
  let n = textureLoad(keptNormal, pix, 0);
  let ndc = vec2<f32>(pos.x / F.resolution.x * 2.0 - 1.0, 1.0 - pos.y / F.resolution.y * 2.0);
  let w = F.invViewProj * vec4<f32>(ndc, out.depth, 1.0);
  out.colour = vec4<f32>(seen(w.xyz / w.w, n.xyz, a.rgb, a.w, n.w, e.rgb), 1.0);
  return out;
}
