import frameSrc from './shaders/frame.wgsl?raw';
import commonSrc from './shaders/common.wgsl?raw';
import lightingSrc from './shaders/lighting.wgsl?raw';
import lightsSrc from './shaders/lights.wgsl?raw';
import lightFieldSrc from './shaders/lightfield.wgsl?raw';
import volumeSrc from './shaders/volume.wgsl?raw';
import flameNoiseSrc from './shaders/flame_noise.wgsl?raw';
import flameCoordsSrc from './shaders/flame_coords.wgsl?raw';
import relightSrc from './shaders/relight.wgsl?raw';
import fxaaSrc from './shaders/fxaa.wgsl?raw';
import sceneSrc from './shaders/scene.wgsl?raw';
import furnishingsSrc from './shaders/furnishings.wgsl?raw';
import starsSrc from './shaders/stars.wgsl?raw';
import logsSrc from './shaders/logs.wgsl?raw';
import postSrc from './shaders/post.wgsl?raw';
import compositeSrc from './shaders/composite.wgsl?raw';
import combineSrc from './shaders/combine.wgsl?raw';
import adaptSrc from './shaders/adapt.wgsl?raw';
import overlaySrc from './shaders/overlay.wgsl?raw';
import logsSharedSrc from '../sim/shaders/logs_shared.wgsl?raw';
import { Sparks } from './Sparks';
import { Steam } from './Steam';

import { buildBlackbodyTable } from '../blackbody';
import { AMBIENT_TEMP, type Detail, type Params } from '../config';
import { cross, normalize, sub, type Vec3 } from '../math';
import { fireCentre } from '../rooms';
import type { FireSim } from '../sim/FireSim';
import type { LighterView, LogSystem } from '../sim/LogSystem';
import type { Camera } from '../camera';
import { buildLogTemplate, buildScene, Clearings, MAX_CLEARINGS, splitScene, VERTEX_FLOATS } from './geometry';
import { buildPropsMesh } from './toolMesh';
import type { Mat3, Place } from '../sky/astro';
import { CONSTELLATION_LINES, CONSTELLATION_NAMES } from '../sky/constellations';
import { SkyClock, type NightSky } from '../sky/night';
import { STAR_SATURATION, starColour, type StarCatalogue } from '../sky/stars';
import type { ToolView } from '../tools';
import type { CritterView } from '../critters';

const HDR_FORMAT: GPUTextureFormat = 'rgba16float';
const HEAT_FORMAT: GPUTextureFormat = 'rg16float';
const DEPTH_FORMAT: GPUTextureFormat = 'depth32float';
const KEPT_FORMAT: GPUTextureFormat = 'rgba16float'; // what the still scene is made of (see keep())
// (Normals in full floats: a glossy highlight (glazed tiles, brass) turns a half float's error in
// the normal into a few levels' difference in the picture.)
const KEPT_NORMAL_FORMAT: GPUTextureFormat = 'rgba32float';
/**
 * What the still scene's materials read from the frame's uniforms (as [first, end) float offsets
 * in writeFrame's layout), and by how much each may drift before they are worked out again: the
 * opening, the light and sky outside, the sky's turning, the Moon and the Sun (a little looser:
 * the sky turns a quarter of a degree a minute, and a step every quarter of a minute or so does not
 * show), the starlight, and the furniture's fading.
 */
const KEPT_WATCH: [number, number, number][] = [
  [64, 68, 2e-4],
  [124, 140, 2e-4],
  [144, 184, 1e-3],
  [185, 186, 2e-4],
  [188, 188 + MAX_CLEARINGS + 1, 2e-4],
];
const FRAME_SIZE = 896;
const LIGHT_BLOCKS = 4 * 3 * 2;
const BLOOM_LEVELS = 6;
const LIGHT_FIELD_DIVISOR = 3;
const PROP_VERTICES = 32768;
// Texels across the tileable noise that the flames' fine detail is drawn from (see volume.wgsl).
const FLAME_NOISE_SIZE = 64;
// How long (s of the fire's time) each of the two layers of that detail is carried along with the
// gas before it is renewed (as DETAIL_CYCLE in volume.wgsl; the layers take turns, half a cycle apart).
const FLAME_DETAIL_CYCLE = 0.3;
const CANDLE_BRIGHTNESS = 1.2e-4; // light from a candle flame (in the units of the fire's lights)
const MATCH_BRIGHTNESS = 1.5e-4;
// How brightly a lamp's shade (or a lantern's glass) glows, for the light it gives.
const SHADE_GLOW = 32;
const GLASS_GLOW = 40;

export type TimeOfDay = 'night' | 'dusk' | 'day';

/**
 * Science overlays: the grid the air is worked out on (a slice of it through the fire, with the
 * cells it takes to be solid), and arrows for the air's flow across that slice. `slice` moves the
 * slice from one side of the box (-1) through the fire (0) to the other (1).
 */
export interface Overlay {
  grid: boolean;
  flow: boolean;
  slice: number;
}

/** The room's own lights: lamps (dimmer, 0..1), candles lit or not, and the time of day outside. */
export interface Lighting {
  lamps: number;
  candles: boolean;
  time: TimeOfDay;
}

interface Outside {
  sky: Vec3; // light from the sky all round
  stars: number; // how much of the starry sky shows (0..1)
  sun: Vec3; // direction toward the moon, the sun or the window
  sunColour: Vec3;
}

// Light from outside, indoors: it comes in through windows (off to the right, in front of the
// fireplace). (Out in the open it is the real sky's: see SkyClock.)
const WINDOW = normalize([0.6, 0.45, 0.66]);
const OUTSIDE: Record<TimeOfDay, Outside> = {
  night: { sky: [0.005, 0.006, 0.01], stars: 0, sun: WINDOW, sunColour: [0, 0, 0] },
  dusk: { sky: [0.012, 0.016, 0.032], stars: 0, sun: WINDOW, sunColour: [0.012, 0.015, 0.028] },
  day: { sky: [0.045, 0.045, 0.048], stars: 0, sun: WINDOW, sunColour: [0.07, 0.066, 0.058] },
};
const TIMES: TimeOfDay[] = ['night', 'dusk', 'day'];
// The naked-eye planets, for their colours (in the order the sky gives them).
const PLANET_COLOURS: Record<string, Vec3> = {
  Mercury: [0.95, 0.9, 0.85],
  Venus: [1, 0.97, 0.9],
  Mars: [1, 0.62, 0.42],
  Jupiter: [1, 0.95, 0.86],
  Saturn: [1, 0.9, 0.72],
};
const PLANETS = 5;

interface Targets {
  scene: GPUTexture; // lit room and logs
  depth: GPUTexture;
  volume: GPUTexture; // fire light along each ray, and transmittance
  heat: GPUTexture; // hot air along each ray (heat haze)
  history: GPUTexture[]; // smoothed fire from earlier frames (ping-pong)
  hdr: GPUTexture; // everything together, before bloom and tonemapping
  bloom: GPUTexture[];
  downGroups: GPUBindGroup[];
  upGroups: GPUBindGroup[];
  combineGroups: GPUBindGroup[];
  finished: GPUTexture; // the finished picture, before its edges are smoothed (see smoothEdges)
  fxaaGroup: GPUBindGroup;
}

export class Renderer {
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new ArrayBuffer(FRAME_SIZE);
  private readonly bbBuf: GPUBuffer;
  private readonly lightsBuf: GPUBuffer;
  private vertexBuf: GPUBuffer;
  private vertexCount: number;
  private stillCount: number; // the scene's vertices that stand still come first (see splitScene)
  /** Where the furniture that turns see-through is, and how see-through each piece is now (0..1). */
  private clearings: Clearings;
  private readonly fades = new Float32Array(MAX_CLEARINGS + 1);
  private readonly logTemplateBuf: GPUBuffer;
  private readonly logVertexCount: number;
  private readonly propBuf: GPUBuffer;
  private propVertexCount = 0;
  private readonly linear: GPUSampler;
  private readonly flameNoise: GPUTexture;
  private readonly repeat: GPUSampler;
  // The flames' fine detail carried along with the gas: for each of two layers, how far the gas
  // has moved since the layer was renewed, on the air's grid. Two sides, one read and one written
  // each frame: [side 0 layer A, side 0 layer B, side 1 A, side 1 B]. (1 x 1 x 1 without detail.)
  private readonly carryPipeline: GPUComputePipeline;
  private readonly carryBuf: GPUBuffer;
  private readonly carryData = new Float32Array(8);
  private carried: GPUTexture[] = [];
  private carryGroups: GPUBindGroup[] = [];
  private carrySide = 0; // the side with the latest layers
  private carryTime = 0; // the fire's time at the last frame
  private carryRenewals = [NaN, NaN]; // how many times each layer had been renewed, as of the last frame
  private readonly bbTable: Float32Array;
  private match: { pos: Vec3; lit: boolean } | null = null;
  /** The room's own lights (set from the settings). */
  lighting: Lighting = { lamps: 0, candles: true, time: 'night' };
  /** The real sky over an outdoor scene (the moment shown, the Moon or not). */
  readonly sky = new SkyClock();
  /** Draw the constellations' figures on the sky. */
  constellations = false;
  /** The sky as last worked out (outdoors), refreshed now and then. */
  night: NightSky | null = null;
  private skyAge = Infinity;
  private readonly starPipeline: GPURenderPipeline;
  private readonly linePipeline: GPURenderPipeline;
  private readonly starGroup: GPUBindGroup;
  private starBuf: GPUBuffer | null = null;
  private starCount = 0;
  private lineBuf: GPUBuffer | null = null;
  private lineCount = 0;
  private labelStars: { name: string; v: Vec3 }[] = []; // (J2000 directions)

  private readonly lightsPipeline: GPUComputePipeline;
  private readonly lightFieldPipeline: GPUComputePipeline;
  private readonly scenePipeline: GPURenderPipeline;
  // What the still part of the scene is made of (albedo and spec, normal and gloss, its own light),
  // and how far away it is, worked out when the eye moves (or the sky has turned a little) and lit
  // afresh each frame (relight.wgsl): the materials are most of the cost of drawing a room.
  private readonly keepPipeline: GPURenderPipeline;
  private readonly relightPipeline: GPURenderPipeline;
  private relightGroup: GPUBindGroup | null = null;
  private kept: { albedo: GPUTexture; normal: GPUTexture; emission: GPUTexture; depth: GPUTexture } | null = null;
  private keptFresh = false;
  private readonly keptView = new Float32Array(16);
  private readonly keptFrame = new Float32Array(FRAME_SIZE / 4);
  private readonly logPipeline: GPURenderPipeline;
  private readonly volumePipeline: GPURenderPipeline;
  private readonly downKarisPipeline: GPURenderPipeline;
  private readonly downPipeline: GPURenderPipeline;
  private readonly upPipeline: GPURenderPipeline;
  private readonly combinePipeline: GPURenderPipeline;
  private readonly compositePipeline: GPURenderPipeline;
  private readonly fxaaPipeline: GPURenderPipeline;
  private readonly texSampLayout: GPUBindGroupLayout;
  private readonly logGroup: GPUBindGroup;
  readonly sparks: Sparks;
  readonly steam: Steam;
  /** A kettle set down by the fire (where the room has a place for one). */
  kettle = false;
  /** Smooth the stair-stepped edges of the finished picture (anti-aliasing: fxaa.wgsl). */
  smoothEdges = true;
  /** Science overlays (off unless asked for). */
  overlay: Overlay = { grid: false, flow: false, slice: 0 };
  private readonly overlayBuf: GPUBuffer;
  private readonly overlayLayout: GPUBindGroupLayout;
  private readonly overlayPipelines: { box: GPURenderPipeline; grid: GPURenderPipeline; solid: GPURenderPipeline; flow: GPURenderPipeline };
  private overlayGroup: GPUBindGroup | null = null;
  private readonly adaptPipeline: GPUComputePipeline;
  private readonly adaptBuf: GPUBuffer;
  private adaptGroup: GPUBindGroup | null = null;
  private historyValid = false;
  private historyIndex = 0;
  private lastViewProj = new Float32Array(16);

  private sim: FireSim | null = null;
  private lightField: GPUTexture | null = null;
  private lightsGroup: GPUBindGroup | null = null;
  private lightFieldGroup: GPUBindGroup | null = null;
  private sceneGroup: GPUBindGroup | null = null;
  private volumeGroups: GPUBindGroup[] = [];
  private compositeGroup: GPUBindGroup | null = null;
  private targets: Targets | null = null;
  private frameIndex = 0;

  constructor(
    private readonly device: GPUDevice,
    private readonly context: GPUCanvasContext,
    private readonly format: GPUTextureFormat,
    private readonly logs: LogSystem,
    private detail: Detail,
  ) {
    this.frameBuf = device.createBuffer({ label: 'frame', size: FRAME_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const bb = buildBlackbodyTable();
    this.bbTable = bb;
    this.bbBuf = device.createBuffer({ label: 'blackbody', size: bb.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.bbBuf, 0, bb);

    this.lightsBuf = device.createBuffer({ label: 'fire lights', size: LIGHT_BLOCKS * 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const built = buildScene(logs.room, detail);
    const { vertices: verts, still } = splitScene(built.vertices);
    this.clearings = built.clearings;
    this.vertexCount = verts.length / VERTEX_FLOATS;
    this.stillCount = still;
    this.vertexBuf = device.createBuffer({ label: 'scene vertices', size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.vertexBuf, 0, verts);

    const logVerts = buildLogTemplate();
    this.logVertexCount = logVerts.length / 4;
    this.logTemplateBuf = device.createBuffer({ label: 'log template', size: logVerts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.logTemplateBuf, 0, logVerts);

    this.propBuf = device.createBuffer({ label: 'props', size: PROP_VERTICES * VERTEX_FLOATS * 4, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });

    this.linear = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    const module = (label: string, ...parts: string[]) => device.createShaderModule({ label, code: parts.join('\n') });

    // The noise for the flames' fine detail, baked once.
    this.flameNoise = device.createTexture({
      label: 'flame noise',
      size: [FLAME_NOISE_SIZE, FLAME_NOISE_SIZE, FLAME_NOISE_SIZE],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.repeat = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', addressModeW: 'repeat' });
    const noisePipeline = device.createComputePipeline({ label: 'flame noise', layout: 'auto', compute: { module: module('flame noise', flameNoiseSrc), entryPoint: 'main' } });
    const noiseEnc = device.createCommandEncoder({ label: 'flame noise' });
    const noisePass = noiseEnc.beginComputePass({ label: 'flame noise' });
    noisePass.setPipeline(noisePipeline);
    noisePass.setBindGroup(0, device.createBindGroup({ layout: noisePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.flameNoise.createView() }] }));
    noisePass.dispatchWorkgroups(FLAME_NOISE_SIZE / 4, FLAME_NOISE_SIZE / 4, FLAME_NOISE_SIZE / 4);
    noisePass.end();
    device.queue.submit([noiseEnc.finish()]);
    this.carryPipeline = device.createComputePipeline({ label: 'flame detail carry', layout: 'auto', compute: { module: module('flame detail carry', flameCoordsSrc), entryPoint: 'main' } });
    this.carryBuf = device.createBuffer({ label: 'flame detail carry', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.lightsPipeline = device.createComputePipeline({
      label: 'fire lights',
      layout: 'auto',
      compute: { module: module('fire lights', frameSrc, commonSrc, lightsSrc), entryPoint: 'main' },
    });
    this.lightFieldPipeline = device.createComputePipeline({
      label: 'light field',
      layout: 'auto',
      compute: { module: module('light field', frameSrc, commonSrc, lightingSrc, lightFieldSrc), entryPoint: 'main' },
    });

    const depthStencil: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'less' };
    const sceneModule = module('scene', frameSrc, commonSrc, lightingSrc, sceneSrc, furnishingsSrc);
    // (One layout for drawing the scene lit and for keeping what it is made of, so that one bind
    // group serves both.)
    const V = GPUShaderStage.VERTEX;
    const FR = GPUShaderStage.FRAGMENT;
    const sceneLayout = device.createPipelineLayout({
      bindGroupLayouts: [
        device.createBindGroupLayout({
          label: 'scene',
          entries: [
            { binding: 0, visibility: V | FR, buffer: { type: 'uniform' } },
            { binding: 1, visibility: V | FR, sampler: { type: 'filtering' } },
            { binding: 2, visibility: FR, texture: { sampleType: 'float', viewDimension: '3d' } },
            { binding: 3, visibility: FR, buffer: { type: 'read-only-storage' } },
            { binding: 4, visibility: FR, buffer: { type: 'read-only-storage' } },
            { binding: 5, visibility: V | FR, texture: { sampleType: 'float' } },
          ],
        }),
      ],
    });
    const sceneVertex: GPUVertexState = {
      module: sceneModule,
      entryPoint: 'vs',
      buffers: [
        {
          arrayStride: VERTEX_FLOATS * 4,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x2' },
            { shaderLocation: 3, offset: 32, format: 'float32' },
            { shaderLocation: 4, offset: 36, format: 'float32x3' },
          ],
        },
      ],
    };
    this.scenePipeline = device.createRenderPipeline({
      label: 'scene',
      layout: sceneLayout,
      vertex: sceneVertex,
      fragment: { module: sceneModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    this.keepPipeline = device.createRenderPipeline({
      label: 'scene kept',
      layout: sceneLayout,
      vertex: sceneVertex,
      fragment: { module: sceneModule, entryPoint: 'fsKeep', targets: [{ format: KEPT_FORMAT }, { format: KEPT_NORMAL_FORMAT }, { format: KEPT_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    const relightModule = module('relight', frameSrc, commonSrc, lightingSrc, relightSrc);
    this.relightPipeline = device.createRenderPipeline({
      label: 'relight',
      layout: 'auto',
      vertex: { module: relightModule, entryPoint: 'vs' },
      fragment: { module: relightModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: 'always' },
    });

    const logModule = module('logs', frameSrc, commonSrc, logsSharedSrc, lightingSrc, logsSrc);
    this.logPipeline = device.createRenderPipeline({
      label: 'logs',
      layout: 'auto',
      vertex: {
        module: logModule,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }],
      },
      fragment: { module: logModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
    this.logGroup = device.createBindGroup({
      label: 'logs',
      layout: this.logPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.bbBuf } },
        { binding: 2, resource: { buffer: this.lightsBuf } },
        { binding: 3, resource: { buffer: logs.logBuffer } },
        { binding: 4, resource: logs.geo.createView({ dimension: '2d-array' }) },
        { binding: 5, resource: logs.flux.createView({ dimension: '2d-array' }) },
        { binding: 6, resource: logs.mapSampler },
        { binding: 7, resource: { buffer: logs.look } },
        { binding: 8, resource: { buffer: logs.prod } },
      ],
    });

    // The stars and planets, and the constellations' lines: added onto the sky, behind anything
    // in front of it.
    const starModule = module('stars', frameSrc, starsSrc);
    const additive: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } };
    const skyDepth: GPUDepthStencilState = { format: DEPTH_FORMAT, depthWriteEnabled: false, depthCompare: 'less' };
    const skyGroupLayout = device.createBindGroupLayout({
      label: 'stars',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const skyLayout = device.createPipelineLayout({ bindGroupLayouts: [skyGroupLayout] });
    this.starPipeline = device.createRenderPipeline({
      label: 'stars',
      layout: skyLayout,
      vertex: {
        module: starModule,
        entryPoint: 'vsStar',
        buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }] }],
      },
      fragment: { module: starModule, entryPoint: 'fsStar', targets: [{ format: HDR_FORMAT, blend: additive }] },
      primitive: { topology: 'triangle-list' },
      depthStencil: skyDepth,
    });
    this.linePipeline = device.createRenderPipeline({
      label: 'constellations',
      layout: skyLayout,
      vertex: { module: starModule, entryPoint: 'vsLine', buffers: [{ arrayStride: 16, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }] }] },
      fragment: { module: starModule, entryPoint: 'fsLine', targets: [{ format: HDR_FORMAT, blend: additive }] },
      primitive: { topology: 'line-list' },
      depthStencil: skyDepth,
    });
    this.starGroup = device.createBindGroup({
      label: 'stars',
      layout: skyGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuf } }],
    });

    const volumeModule = module('volume', frameSrc, commonSrc, volumeSrc);
    this.volumePipeline = device.createRenderPipeline({
      label: 'fire volume',
      layout: 'auto',
      vertex: { module: volumeModule, entryPoint: 'vs' },
      fragment: { module: volumeModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }, { format: HEAT_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    const combineModule = module('combine', frameSrc, combineSrc);
    this.combinePipeline = device.createRenderPipeline({
      label: 'combine',
      layout: 'auto',
      vertex: { module: combineModule, entryPoint: 'vs' },
      fragment: { module: combineModule, entryPoint: 'fs', targets: [{ format: HDR_FORMAT }, { format: HDR_FORMAT }] },
      primitive: { topology: 'triangle-list' },
    });

    this.sparks = new Sparks(device, logs, this.frameBuf, this.bbBuf, HDR_FORMAT, DEPTH_FORMAT);
    this.steam = new Steam(device, this.frameBuf, HDR_FORMAT, DEPTH_FORMAT);

    this.adaptBuf = device.createBuffer({ label: 'eye adaptation', size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.adaptPipeline = device.createComputePipeline({
      label: 'eye adaptation',
      layout: 'auto',
      compute: { module: module('eye adaptation', frameSrc, adaptSrc), entryPoint: 'main' },
    });

    this.texSampLayout = device.createBindGroupLayout({
      label: 'texture + sampler',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    });
    const postLayout = device.createPipelineLayout({ bindGroupLayouts: [this.texSampLayout] });
    const postModule = module('post', postSrc);
    const postPipeline = (label: string, entryPoint: string, additive: boolean, constants?: Record<string, number>) =>
      device.createRenderPipeline({
        label,
        layout: postLayout,
        vertex: { module: postModule, entryPoint: 'vsFull' },
        fragment: {
          module: postModule,
          entryPoint,
          constants,
          targets: [
            {
              format: HDR_FORMAT,
              blend: additive
                ? { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } }
                : undefined,
            },
          ],
        },
        primitive: { topology: 'triangle-list' },
      });
    this.downKarisPipeline = postPipeline('bloom down (karis)', 'fsDown', false, { KARIS: 1 });
    this.downPipeline = postPipeline('bloom down', 'fsDown', false, { KARIS: 0 });
    this.upPipeline = postPipeline('bloom up', 'fsUp', true);

    // The science overlays, drawn over the finished picture.
    this.overlayBuf = device.createBuffer({ label: 'overlay', size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.overlayLayout = device.createBindGroupLayout({
      label: 'overlay',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'float', viewDimension: '3d' } },
      ],
    });
    const overlayModule = module('overlay', frameSrc, overlaySrc);
    const overlayLayout = device.createPipelineLayout({ bindGroupLayouts: [this.overlayLayout] });
    const blend: GPUBlendState = {
      color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    const overlayPipeline = (entryPoint: string, topology: GPUPrimitiveTopology) =>
      device.createRenderPipeline({
        label: `overlay ${entryPoint}`,
        layout: overlayLayout,
        vertex: { module: overlayModule, entryPoint },
        fragment: { module: overlayModule, entryPoint: 'fsOverlay', targets: [{ format: this.format, blend }] },
        primitive: { topology },
      });
    this.overlayPipelines = {
      box: overlayPipeline('vsBox', 'line-list'),
      grid: overlayPipeline('vsGrid', 'line-list'),
      solid: overlayPipeline('vsSolid', 'triangle-list'),
      flow: overlayPipeline('vsFlow', 'triangle-list'),
    };

    const compositeModule = module('composite', frameSrc, compositeSrc);
    this.compositePipeline = device.createRenderPipeline({
      label: 'composite',
      layout: 'auto',
      vertex: { module: compositeModule, entryPoint: 'vs' },
      fragment: { module: compositeModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
    const fxaaModule = module('fxaa', fxaaSrc);
    this.fxaaPipeline = device.createRenderPipeline({
      label: 'fxaa',
      layout: postLayout,
      vertex: { module: fxaaModule, entryPoint: 'vs' },
      fragment: { module: fxaaModule, entryPoint: 'fs', targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list' },
    });
  }

  /**
   * The stars of the catalogue (and room for the planets after them): each as its J2000
   * direction and magnitude, and its colour; and the constellations' lines between them.
   */
  setStars(stars: StarCatalogue) {
    const count = stars.count + PLANETS;
    const data = new Float32Array(count * 8);
    const index = new Map<number, number>();
    for (let i = 0; i < stars.count; i++) {
      const [ra, dec] = [stars.ra[i], stars.dec[i]];
      const c = starColour(stars.bv[i], STAR_SATURATION * Math.min(1, Math.max(0, (4.5 - stars.vmag[i]) / 3)));
      data.set([Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), stars.vmag[i], c[0], c[1], c[2], 0], i * 8);
      index.set(stars.hr[i], i);
    }
    this.starBuf = this.device.createBuffer({ label: 'stars', size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.starBuf, 0, data);
    this.starCount = count;
    const lines: number[] = [];
    for (const [a, b] of CONSTELLATION_LINES) {
      const i = index.get(a);
      const j = index.get(b);
      if (i === undefined || j === undefined) continue;
      lines.push(...data.subarray(i * 8, i * 8 + 3), 0, ...data.subarray(j * 8, j * 8 + 3), 0);
    }
    const lineData = new Float32Array(lines);
    this.lineBuf = this.device.createBuffer({ label: 'constellations', size: lineData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.lineBuf, 0, lineData);
    this.lineCount = lineData.length / 4;
    this.labelStars = CONSTELLATION_NAMES.flatMap(({ name, hr }) => {
      const i = index.get(hr);
      return i === undefined ? [] : [{ name, v: [data[i * 8], data[i * 8 + 1], data[i * 8 + 2]] as Vec3 }];
    });
    this.skyAge = Infinity;
  }

  /** Where to write the names of the constellations and the planets on the sky (world directions). */
  skyLabels(): { name: string; dir: Vec3 }[] {
    const n = this.night;
    if (!n) return [];
    const m = n.starsToWorld;
    const turn = (v: Vec3): Vec3 => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
    return [...this.labelStars.map(({ name, v }) => ({ name, dir: turn(v) })), ...n.sky.planets.filter((p) => p.mag < 3).map((p) => ({ name: p.name, dir: p.dir }))];
  }

  /** Current eye adaptation: exposure multiplier and measured average luminance (debugging). */
  async readAdaptation(): Promise<[number, number]> {
    const copy = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyBufferToBuffer(this.adaptBuf, 0, copy, 0, 16);
    this.device.queue.submit([enc.finish()]);
    await copy.mapAsync(GPUMapMode.READ);
    const v = new Float32Array(copy.getMappedRange().slice(0));
    copy.destroy();
    return [v[0], v[1]];
  }

  setSim(sim: FireSim) {
    this.sim = sim;
    const scal = sim.scalars.createView();
    this.device.queue.writeBuffer(this.lightsBuf, 0, new Float32Array(LIGHT_BLOCKS * 8));
    this.lightsGroup = this.device.createBindGroup({
      label: 'fire lights',
      layout: this.lightsPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: scal },
        { binding: 2, resource: { buffer: this.bbBuf } },
        { binding: 3, resource: { buffer: this.lightsBuf } },
      ],
    });
    this.sceneGroup = this.device.createBindGroup({
      label: 'scene',
      layout: this.scenePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: this.linear },
        { binding: 2, resource: scal },
        { binding: 3, resource: { buffer: this.bbBuf } },
        { binding: 4, resource: { buffer: this.lightsBuf } },
        { binding: 5, resource: this.logs.bedMap.createView() },
      ],
    });

    this.lightField?.destroy();
    const [nx, ny, nz] = sim.dims;
    this.lightField = this.device.createTexture({
      label: 'light field',
      size: [Math.ceil(nx / LIGHT_FIELD_DIVISOR), Math.ceil(ny / LIGHT_FIELD_DIVISOR), Math.ceil(nz / LIGHT_FIELD_DIVISOR)],
      dimension: '3d',
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.lightFieldGroup = this.device.createBindGroup({
      label: 'light field',
      layout: this.lightFieldPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 2, resource: { buffer: this.lightsBuf } },
        { binding: 3, resource: this.lightField.createView() },
      ],
    });
    this.sparks.setSim(sim);

    for (const t of this.carried) t.destroy();
    const carrySize = sim.quality.flameDetail ? sim.dims : [1, 1, 1];
    this.carried = [0, 1, 2, 3].map((i) =>
      this.device.createTexture({
        label: `flame detail carried ${i}`,
        size: carrySize,
        dimension: '3d',
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
      }),
    );
    this.carryGroups = [0, 1].map((side) =>
      this.device.createBindGroup({
        label: 'flame detail carry',
        layout: this.carryPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.carryBuf } },
          { binding: 1, resource: sim.velocity.createView() },
          { binding: 2, resource: this.linear },
          { binding: 3, resource: this.carried[2 * side].createView() },
          { binding: 4, resource: this.carried[2 * side + 1].createView() },
          { binding: 5, resource: this.carried[2 * (1 - side)].createView() },
          { binding: 6, resource: this.carried[2 * (1 - side) + 1].createView() },
        ],
      }),
    );
    this.carryRenewals = [NaN, NaN];

    this.overlayGroup = this.device.createBindGroup({
      label: 'overlay',
      layout: this.overlayLayout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.overlayBuf } },
        { binding: 2, resource: { buffer: sim.solidCells } },
        { binding: 3, resource: sim.velocity.createView() },
      ],
    });
    this.rebuildVolumeGroup();
  }

  resize(width: number, height: number) {
    if (this.targets) {
      const t = this.targets;
      for (const tex of [t.scene, t.depth, t.volume, t.heat, t.hdr, t.finished, ...t.history, ...t.bloom]) tex.destroy();
    }
    if (this.kept) for (const tex of Object.values(this.kept)) tex.destroy();
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const target = (label: string, format: GPUTextureFormat) => this.device.createTexture({ label, size: [width, height], format, usage });
    const scene = target('scene', HDR_FORMAT);
    const depth = target('depth', DEPTH_FORMAT);
    const kept = {
      albedo: target('kept albedo', KEPT_FORMAT),
      normal: target('kept normal', KEPT_NORMAL_FORMAT),
      emission: target('kept emission', KEPT_FORMAT),
      depth: target('kept depth', DEPTH_FORMAT),
    };
    this.kept = kept;
    this.keptFresh = false;
    this.relightGroup = this.device.createBindGroup({
      label: 'relight',
      layout: this.relightPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.bbBuf } },
        { binding: 2, resource: { buffer: this.lightsBuf } },
        { binding: 3, resource: kept.albedo.createView() },
        { binding: 4, resource: kept.normal.createView() },
        { binding: 5, resource: kept.emission.createView() },
        { binding: 6, resource: kept.depth.createView() },
      ],
    });
    const volume = target('fire', HDR_FORMAT);
    const heat = target('heat', HEAT_FORMAT);
    const history = [target('fire history A', HDR_FORMAT), target('fire history B', HDR_FORMAT)];
    const hdr = target('hdr', HDR_FORMAT);
    this.historyValid = false;
    const bloom: GPUTexture[] = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const w = Math.max(1, width >> (i + 1));
      const h = Math.max(1, height >> (i + 1));
      bloom.push(this.device.createTexture({ label: `bloom ${i}`, size: [w, h], format: HDR_FORMAT, usage }));
    }
    const texSamp = (tex: GPUTexture) =>
      this.device.createBindGroup({
        layout: this.texSampLayout,
        entries: [
          { binding: 0, resource: tex.createView() },
          { binding: 1, resource: this.linear },
        ],
      });
    // down i reads the previous level (hdr for the first); up i reads level i + 1.
    const downGroups = bloom.map((_, i) => texSamp(i === 0 ? hdr : bloom[i - 1]));
    const upGroups = bloom.map((t) => texSamp(t));
    // combine i reads history i and writes the other one.
    const combineGroups = history.map((h) =>
      this.device.createBindGroup({
        label: 'combine',
        layout: this.combinePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: scene.createView() },
          { binding: 2, resource: volume.createView() },
          { binding: 3, resource: heat.createView() },
          { binding: 4, resource: h.createView() },
          { binding: 5, resource: this.linear },
        ],
      }),
    );
    const finished = target('finished', this.format);
    this.targets = { scene, depth, volume, heat, history, hdr, bloom, downGroups, upGroups, combineGroups, finished, fxaaGroup: texSamp(finished) };

    this.compositeGroup = this.device.createBindGroup({
      label: 'composite',
      layout: this.compositePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: hdr.createView() },
        { binding: 2, resource: bloom[0].createView() },
        { binding: 3, resource: this.linear },
        { binding: 4, resource: { buffer: this.adaptBuf } },
      ],
    });
    this.adaptGroup = this.device.createBindGroup({
      label: 'eye adaptation',
      layout: this.adaptPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: bloom[BLOOM_LEVELS - 1].createView() },
        { binding: 2, resource: { buffer: this.adaptBuf } },
      ],
    });
    this.rebuildVolumeGroup();
  }

  private rebuildVolumeGroup() {
    const sim = this.sim;
    const targets = this.targets;
    const lightField = this.lightField;
    if (!sim || !targets || !lightField) return;
    // One for each side of the carried detail.
    this.volumeGroups = [0, 1].map((side) =>
      this.device.createBindGroup({
        label: 'fire volume',
        layout: this.volumePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: this.frameBuf } },
          { binding: 1, resource: this.linear },
          { binding: 2, resource: sim.scalars.createView() },
          { binding: 3, resource: targets.depth.createView() },
          { binding: 4, resource: { buffer: this.bbBuf } },
          { binding: 5, resource: sim.velocity.createView() },
          { binding: 6, resource: sim.smoke.createView() },
          { binding: 7, resource: lightField.createView() },
          { binding: 8, resource: this.flameNoise.createView() },
          { binding: 9, resource: this.repeat },
          { binding: 10, resource: this.carried[2 * side].createView() },
          { binding: 11, resource: this.carried[2 * side + 1].createView() },
        ],
      }),
    );
  }

  /** Rebuilds the room around the fire (after the log model moved to another room, for more or less detail, or a kettle). */
  setRoom(detail = this.detail) {
    this.detail = detail;
    this.steam.clear();
    const built = buildScene(this.logs.room, detail, this.kettle);
    const { vertices: verts, still } = splitScene(built.vertices);
    this.clearings = built.clearings;
    this.fades.fill(0);
    this.vertexBuf.destroy();
    this.vertexCount = verts.length / VERTEX_FLOATS;
    this.stillCount = still;
    this.vertexBuf = this.device.createBuffer({ label: 'scene vertices', size: verts.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(this.vertexBuf, 0, verts);
    this.historyValid = false;
    this.keptFresh = false;
  }

  /** What moves about outside the logs: the tool in hand (if any), firelighters, creatures. */
  setProps(view: ToolView | null, lighters: LighterView[], critters: CritterView[] = []) {
    this.match = view?.kind === 'match' ? { pos: view.tip, lit: view.lit } : null;
    if (!view && !lighters.length && !critters.length) {
      this.propVertexCount = 0;
      return;
    }
    const verts = buildPropsMesh(view, lighters, critters);
    this.propVertexCount = Math.min(verts.length / VERTEX_FLOATS, PROP_VERTICES);
    this.device.queue.writeBuffer(this.propBuf, 0, verts, 0, this.propVertexCount * VERTEX_FLOATS);
  }

  /** Draws a frame. dt is the real time since the last frame (for sparks). */
  render(camera: Camera, params: Params, time: number, dt = 1 / 60) {
    const sim = this.sim;
    const t = this.targets;
    const field = this.lightField;
    if (!sim || !t || !field || !this.lightsGroup || !this.lightFieldGroup || !this.sceneGroup || !this.relightGroup || !this.volumeGroups.length || !this.compositeGroup) return;
    this.frameIndex++;
    // Smooth the fire over frames only while the camera holds still.
    const moved = camera.viewProj.some((v, i) => Math.abs(v - this.lastViewProj[i]) > 1e-5);
    this.lastViewProj.set(camera.viewProj);
    // (On Low, where the fire has no grain, it still smooths the thin tongues' flicker from one drawn frame to the next.)
    const blend = this.historyValid && !moved ? 1 - 0.5 * params.smoothing : 1;
    this.writeFrame(camera, params, time, sim, t.hdr.width, t.hdr.height, blend, dt);

    const enc = this.device.createCommandEncoder({ label: 'render' });

    const cp = enc.beginComputePass({ label: 'fire lights and sparks' });
    cp.setPipeline(this.lightsPipeline);
    cp.setBindGroup(0, this.lightsGroup);
    cp.dispatchWorkgroups(LIGHT_BLOCKS);
    cp.setPipeline(this.lightFieldPipeline);
    cp.setBindGroup(0, this.lightFieldGroup);
    cp.dispatchWorkgroups(Math.ceil(field.width / 4), Math.ceil(field.height / 4), Math.ceil(field.depthOrArrayLayers / 4));
    this.sparks.update(cp, dt, params.sparks, params.gravity);
    if (sim.quality.flameDetail) this.carryDetail(cp, sim, time);
    cp.end();

    // The still part of the scene: what it is made of, if that has changed (the eye has moved...),
    // then lit afresh; the rest drawn over it.
    if (this.keptStale(camera)) this.keep(enc, camera);
    const relight = enc.beginRenderPass({
      label: 'relight',
      colorAttachments: [{ view: t.scene.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    relight.setPipeline(this.relightPipeline);
    relight.setBindGroup(0, this.relightGroup);
    relight.draw(3);
    relight.end();

    const scene = enc.beginRenderPass({
      label: 'scene',
      colorAttachments: [{ view: t.scene.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depth.createView(), depthLoadOp: 'load', depthStoreOp: 'store' },
    });
    scene.setPipeline(this.scenePipeline);
    scene.setBindGroup(0, this.sceneGroup);
    scene.setVertexBuffer(0, this.vertexBuf);
    scene.draw(this.vertexCount - this.stillCount, 1, this.stillCount);
    if (this.propVertexCount > 0) {
      scene.setVertexBuffer(0, this.propBuf);
      scene.draw(this.propVertexCount);
    }
    if (this.night && this.starBuf) {
      scene.setPipeline(this.starPipeline);
      scene.setBindGroup(0, this.starGroup);
      scene.setVertexBuffer(0, this.starBuf);
      scene.draw(6, this.starCount);
      if (this.constellations && this.lineBuf) {
        scene.setPipeline(this.linePipeline);
        scene.setVertexBuffer(0, this.lineBuf);
        scene.draw(this.lineCount);
      }
    }
    scene.setPipeline(this.logPipeline);
    scene.setBindGroup(0, this.logGroup);
    scene.setVertexBuffer(0, this.logTemplateBuf);
    scene.draw(this.logVertexCount, this.logs.slotsInUse);
    scene.end();

    const vol = enc.beginRenderPass({
      label: 'fire volume',
      colorAttachments: [
        { view: t.volume.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
        { view: t.heat.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear', storeOp: 'store' },
      ],
    });
    vol.setPipeline(this.volumePipeline);
    vol.setBindGroup(0, this.volumeGroups[this.carrySide]);
    vol.draw(3);
    vol.end();

    const prev = this.historyIndex;
    const next = 1 - prev;
    const combine = enc.beginRenderPass({
      label: 'combine',
      colorAttachments: [
        { view: t.hdr.createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
        { view: t.history[next].createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' },
      ],
    });
    combine.setPipeline(this.combinePipeline);
    combine.setBindGroup(0, t.combineGroups[prev]);
    combine.draw(3);
    combine.end();
    this.historyIndex = next;
    this.historyValid = true;

    const sparks = enc.beginRenderPass({
      label: 'sparks',
      colorAttachments: [{ view: t.hdr.createView(), loadOp: 'load', storeOp: 'store' }],
      depthStencilAttachment: { view: t.depth.createView(), depthReadOnly: true },
    });
    this.sparks.draw(sparks);
    this.steam.draw(sparks);
    sparks.end();

    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const pass = enc.beginRenderPass({
        label: `bloom down ${i}`,
        colorAttachments: [{ view: t.bloom[i].createView(), clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
      pass.setPipeline(i === 0 ? this.downKarisPipeline : this.downPipeline);
      pass.setBindGroup(0, t.downGroups[i]);
      pass.draw(3);
      pass.end();
    }
    if (this.adaptGroup) {
      const ap = enc.beginComputePass({ label: 'eye adaptation' });
      ap.setPipeline(this.adaptPipeline);
      ap.setBindGroup(0, this.adaptGroup);
      ap.dispatchWorkgroups(1);
      ap.end();
    }
    for (let i = BLOOM_LEVELS - 1; i > 0; i--) {
      const pass = enc.beginRenderPass({
        label: `bloom up ${i}`,
        colorAttachments: [{ view: t.bloom[i - 1].createView(), loadOp: 'load', storeOp: 'store' }],
      });
      pass.setPipeline(this.upPipeline);
      pass.setBindGroup(0, t.upGroups[i]);
      pass.draw(3);
      pass.end();
    }

    // The finished picture: straight to the screen, or first to a texture for its edges to be
    // smoothed on the way there.
    const screen = this.context.getCurrentTexture().createView();
    const out = enc.beginRenderPass({
      label: 'composite',
      colorAttachments: [{ view: this.smoothEdges ? t.finished.createView() : screen, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
    });
    out.setPipeline(this.compositePipeline);
    out.setBindGroup(0, this.compositeGroup);
    out.draw(3);
    out.end();
    if (this.smoothEdges) {
      const fxaa = enc.beginRenderPass({
        label: 'fxaa',
        colorAttachments: [{ view: screen, clearValue: [0, 0, 0, 1], loadOp: 'clear', storeOp: 'store' }],
      });
      fxaa.setPipeline(this.fxaaPipeline);
      fxaa.setBindGroup(0, t.fxaaGroup);
      fxaa.draw(3);
      fxaa.end();
    }

    const o = this.overlay;
    if ((o.grid || o.flow) && this.overlayGroup) {
      const g = this.writeOverlay(camera, sim);
      const pass = enc.beginRenderPass({
        label: 'science overlays',
        colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: 'load', storeOp: 'store' }],
      });
      const p = this.overlayPipelines;
      pass.setBindGroup(0, this.overlayGroup);
      pass.setPipeline(p.box);
      pass.draw(24);
      if (o.grid) {
        pass.setPipeline(p.solid);
        pass.draw(6, g.across * g.up);
        pass.setPipeline(p.grid);
        pass.draw(2, Math.floor(g.up / g.every) + Math.floor(g.across / g.every) + 2);
      }
      if (o.flow) {
        pass.setPipeline(p.flow);
        pass.draw(18, Math.floor(g.across / g.every) * Math.floor(g.up / g.every));
      }
      pass.end();
    }

    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Whether what the still part of the scene is made of must be worked out again: the eye has
   * moved, or something its materials show has changed (furniture fading out of the way, the time
   * of day, the Moon, the sky turned a little further round; a new room: see setRoom).
   */
  private keptStale(camera: Camera): boolean {
    if (!this.keptFresh || camera.viewProj.some((v, i) => v !== this.keptView[i])) return true;
    const f = new Float32Array(this.frameData);
    const kept = this.keptFrame;
    return KEPT_WATCH.some(([from, to, within]) => {
      for (let i = from; i < to; i++) if (Math.abs(f[i] - kept[i]) > within) return true;
      return false;
    });
  }

  /** Works out what the still part of the scene is made of, as the eye sees it now (for relight.wgsl). */
  private keep(enc: GPUCommandEncoder, camera: Camera) {
    const k = this.kept;
    if (!k || !this.sceneGroup) return;
    const pass = enc.beginRenderPass({
      label: 'scene kept',
      colorAttachments: [k.albedo, k.normal, k.emission].map((tex) => ({ view: tex.createView(), clearValue: [0, 0, 0, 0], loadOp: 'clear' as const, storeOp: 'store' as const })),
      depthStencilAttachment: { view: k.depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' },
    });
    pass.setPipeline(this.keepPipeline);
    pass.setBindGroup(0, this.sceneGroup);
    pass.setVertexBuffer(0, this.vertexBuf);
    pass.draw(this.stillCount);
    pass.end();
    this.keptView.set(camera.viewProj);
    this.keptFrame.set(new Float32Array(this.frameData));
    this.keptFresh = true;
  }

  /**
   * Carries the flames' fine detail along with the gas, by the fire's time since the last frame;
   * a layer whose time is up starts afresh.
   */
  private carryDetail(pass: GPUComputePassEncoder, sim: FireSim, time: number) {
    const dt = Math.min(Math.max(time - this.carryTime, 0), 0.1);
    this.carryTime = time;
    const renew = [0, 0.5].map((offset, i) => {
      const n = Math.floor(time / FLAME_DETAIL_CYCLE + offset);
      const fresh = n !== this.carryRenewals[i];
      this.carryRenewals[i] = n;
      return fresh ? 1 : 0;
    });
    const [nx, ny, nz] = sim.dims;
    this.carryData.set([nx, ny, nz, sim.h, dt, renew[0], renew[1], 0]);
    this.device.queue.writeBuffer(this.carryBuf, 0, this.carryData);
    pass.setPipeline(this.carryPipeline);
    pass.setBindGroup(0, this.carryGroups[this.carrySide]);
    pass.dispatchWorkgroups(Math.ceil(nx / 4), Math.ceil(ny / 4), Math.ceil(nz / 4));
    this.carrySide = 1 - this.carrySide;
  }

  /**
   * Where the overlays' slice is: a vertical cut through the fire, across the grid's x (seen from
   * the front) or its z (seen from the side), whichever faces the eye better; moved by
   * overlay.slice. Grid lines and arrows every so many cells (about 24 across).
   */
  private writeOverlay(camera: Camera, sim: FireSim): { across: number; up: number; every: number } {
    const [nx, ny, nz] = sim.dims;
    const c = fireCentre(this.logs.room);
    const look = sub(camera.target, camera.eye);
    const axis = this.logs.room.enclosure !== 'open' || Math.abs(look[2]) >= Math.abs(look[0]) ? 0 : 1;
    const depth = axis === 0 ? nz : nx;
    const middle = axis === 0 ? (c[2] - sim.origin[2]) / sim.h : (c[0] - sim.origin[0]) / sim.h;
    const at = middle + this.overlay.slice * (this.overlay.slice < 0 ? middle : depth - middle);
    const slice = Math.min(depth - 1, Math.max(0, Math.floor(at)));
    const across = axis === 0 ? nx : nz;
    const every = Math.max(2, Math.round(across / 24));
    const data = new ArrayBuffer(48);
    const f = new Float32Array(data);
    const u = new Uint32Array(data);
    f.set(sim.origin, 0);
    f[3] = sim.h;
    u.set(sim.dims, 4);
    u[7] = axis;
    u[8] = slice;
    u[9] = every;
    f[10] = every * sim.h * 0.9; // (m per square root of m/s: 1 m/s is most of the gap between arrows)
    this.device.queue.writeBuffer(this.overlayBuf, 0, data);
    return { across, up: ny, every };
  }

  private writeFrame(camera: Camera, p: Params, time: number, sim: FireSim, width: number, height: number, volBlend: number, dt: number) {
    const f = new Float32Array(this.frameData);
    const u = new Uint32Array(this.frameData);
    f.set(camera.viewProj, 0);
    f.set(camera.invViewProj, 16);
    f.set(camera.eye, 32);
    f[35] = time;
    f.set(sim.origin, 36);
    f[39] = sim.h;
    f.set(sim.dims, 40);
    u[43] = LIGHT_BLOCKS;
    f[44] = width;
    f[45] = height;
    f[46] = p.exposure;
    // The flames' light on a coarse grid is calibrated to what a fine grid's fire of that wood gives.
    f[47] = p.emission * (sim.quality.flameLight ?? 1);
    f[48] = p.absorption;
    f[49] = p.blueGlow;
    f[50] = p.ignitionTemp;
    u[51] = p.debugView;
    // How far the eye adapts: further in the dark outdoors, less far in daylight.
    const outdoors = this.logs.room.enclosure === 'open';
    f[52] = outdoors ? 4.5 : 3;
    // Glowing surfaces are shown somewhat hotter than they are, as the eye (unlike a camera
    // exposed for the flames) adapts to see embers glowing brightly.
    f[53] = p.glowBoost;
    f[54] = p.bloom;
    f[55] = p.lightGain;
    f[56] = sim.quality.steadyFire ? 0.75 : 0.5; // ray-march step, in cells (coarser where the samples sit at fixed places: see volume.wgsl)
    f[57] = AMBIENT_TEMP;
    f[58] = this.frameIndex % 1024;
    f[59] = this.lighting.time === 'day' ? 0.3 : 0.6;
    f[60] = p.smoke;
    f[61] = volBlend;
    f[62] = p.haze;
    f[63] = dt;
    const room = this.logs.room;
    const light = this.lighting;
    f.set([room.opening.halfWidth, room.opening.spring, room.opening.apex, room.bounce], 64);
    // Candles flicker a little, now and then more; the match (last slot) more so.
    const flicker = (i: number, speed = 1) => {
      const t = time * 1.3 * speed + i * 17.1;
      return 0.9 + 0.06 * Math.sin(t * 7.3) + 0.04 * Math.sin(t * 13.7 + 1.3) + 0.05 * Math.sin(t * 2.1) * Math.sin(t * 23.3);
    };
    for (let i = 0; i < 3; i++) {
      const c = light.candles ? room.candles[i] : undefined;
      f.set(c ? [c[0], c[1], c[2], CANDLE_BRIGHTNESS * flicker(i)] : [0, 0, 0, 0], 68 + i * 4);
    }
    const m = this.match;
    f.set(m?.lit ? [m.pos[0], m.pos[1], m.pos[2], MATCH_BRIGHTNESS * flicker(3, 1.6)] : [0, 0, 0, 0], 80);
    // Lamps, on their dimmer: a dimmed bulb (or a turned-down wick) is redder as well as dimmer.
    const colour = [0, 0, 0];
    for (let i = 0; i < 2; i++) {
      const lamp = room.lamps[i];
      const level = lamp ? light.lamps : 0;
      if (!lamp || level <= 0) {
        f.fill(0, 84 + i * 8, 92 + i * 8);
        continue;
      }
      this.blackbody(lamp.temp * (0.8 + 0.2 * Math.sqrt(level)), colour);
      const k = lamp.power * level * (lamp.kind === 'lantern' ? 0.985 + 0.015 * flicker(5 + i, 0.6) : 1);
      f.set([lamp.pos[0], lamp.pos[1], lamp.pos[2], lamp.kind === 'lantern' ? 1 : 0], 84 + i * 8);
      f.set([colour[0] * k, colour[1] * k, colour[2] * k, lamp.kind === 'lantern' ? GLASS_GLOW : SHADE_GLOW], 88 + i * 8);
    }
    f.set(this.logs.bed.lights(p.glowBoost, p.lightGain), 100);
    // Light from outside: out in the open, the real sky's (see SkyClock).
    this.night = room.sky ? this.nightSky(room.sky.place, light.time, dt) : null;
    const n = this.night;
    if (n) {
      f.set([...n.light.ambient, 1], 124);
      f.set([...n.light.dir, TIMES.indexOf(light.time)], 128);
      f.set([...n.light.colour, 0], 132);
    } else {
      const outside = OUTSIDE[light.time];
      f.set([...outside.sky, outside.stars], 124);
      f.set([...outside.sun, TIMES.indexOf(light.time)], 128);
      f.set([...outside.sunColour, 0], 132);
    }
    const bed = room.bed;
    f.set([bed.minX, bed.maxX, bed.minZ, bed.maxZ], 136);
    const now = new Date();
    f[140] = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds() + now.getMilliseconds() / 1000;
    this.writeSky(f);
    f.set([p.saturation, room.sky ? p.starlight : 0, sim.quality.smooth ? 1 : 0, sim.quality.flameDetail ?? 0], 184);
    this.writeFades(f, camera, dt);
    f[220] = sim.quality.steadyFire ? 1 : 0;
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);
  }

  /**
   * Which pieces of furniture (or parts of a tent) stand between the eye and the fire: lines of
   * sight to the middle of the fire and round it, stepped through where they are. Those fade to a
   * ghost of themselves, quickly; the rest come back, gently. (Not while looking about the sky.)
   */
  private writeFades(f: Float32Array, camera: Camera, dt: number) {
    const hits = new Set<number>();
    if (camera.mode === 'orbit' || camera.destination) {
      const c = fireCentre(this.logs.room);
      const eye = camera.eye;
      const toward = sub([c[0], 0.25, c[2]], eye);
      const side = cross(toward, [0, 1, 0]);
      const right = Math.hypot(...side) > 1e-6 ? normalize(side) : ([1, 0, 0] as Vec3);
      for (const [s, y] of [[0, 0.25], [-0.28, 0.2], [0.28, 0.2], [0, 0.05], [0, 0.5]]) {
        this.clearings.between(eye, [c[0] + right[0] * s, y, c[2] + right[2] * s], 0.3, hits);
      }
    }
    for (let i = 1; i <= MAX_CLEARINGS; i++) {
      const want = hits.has(i) ? 1 : 0;
      const k = Math.min(1, (want > this.fades[i] ? 6 : 2.5) * dt);
      this.fades[i] += Math.sign(want - this.fades[i]) * Math.min(Math.abs(want - this.fades[i]), k);
    }
    f.set(this.fades, 188);
  }

  /** The sky over a place now, worked out afresh every half second (it turns slowly). */
  private nightSky(place: Place, time: TimeOfDay, dt: number): NightSky {
    this.skyAge += dt;
    if (this.night && this.skyAge < 0.5) return this.night;
    this.skyAge = 0;
    const n = this.sky.now(place, time);
    // The planets go after the stars, in world directions (they move among the stars).
    if (this.starBuf) {
      const data = new Float32Array(PLANETS * 8);
      n.sky.planets.slice(0, PLANETS).forEach((p, i) => data.set([...p.dir, p.mag, ...(PLANET_COLOURS[p.name] ?? [1, 1, 1]), 1], i * 8));
      this.device.queue.writeBuffer(this.starBuf, (this.starCount - PLANETS) * 32, data);
    }
    return n;
  }

  /** The night sky for the shaders: where the stars, the Milky Way, the Moon and the Sun are. */
  private writeSky(f: Float32Array) {
    const rows = (m: Mat3, at: number) => {
      for (let r = 0; r < 3; r++) f.set([m[3 * r], m[3 * r + 1], m[3 * r + 2], 0], at + 4 * r);
    };
    const n = this.night;
    if (!n) {
      rows([1, 0, 0, 0, 1, 0, 0, 0, 1], 144);
      rows([1, 0, 0, 0, 1, 0, 0, 0, 1], 156);
      f.set([0, 1, 0, -1, 0, 1, 0, 0, 0, 1, 0, 0, -10, 0, 0, 24], 168);
      return;
    }
    rows(n.starsToWorld, 144);
    rows(n.worldToGalaxy, 156);
    f.set([...n.moon.dir, n.moon.up ? n.moon.lit : -1], 168);
    f.set([...n.moon.sunDir, n.moon.radius], 172);
    f.set([...n.sunDir, n.sunAlt], 176);
    f.set([n.faintest, n.milkyWay, n.skyGlow, this.logs.room.sky?.radius ?? 24], 180);
  }

  /** Blackbody colour (as in the shaders' table) into out. */
  private blackbody(T: number, out: number[]) {
    const x = Math.min(Math.max((T - 400) / 2000, 0), 1) * 511;
    const i = Math.floor(x);
    const j = Math.min(i + 1, 511);
    const f = x - i;
    for (let c = 0; c < 3; c++) out[c] = this.bbTable[i * 4 + c] * (1 - f) + this.bbTable[j * 4 + c] * f;
  }
}
