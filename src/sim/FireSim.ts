import commonSrc from './shaders/common.wgsl?raw';
import logsSharedSrc from './shaders/logs_shared.wgsl?raw';
import solidFacesSrc from './shaders/solid_faces.wgsl?raw';
import solidMotionSrc from './shaders/solid_motion.wgsl?raw';
import clearSrc from './shaders/clear.wgsl?raw';
import solidSrc from './shaders/solid.wgsl?raw';
import advectCommonSrc from './shaders/advect_common.wgsl?raw';
import advectASrc from './shaders/advect_a.wgsl?raw';
import advectBSrc from './shaders/advect_b.wgsl?raw';
import curlSrc from './shaders/curl.wgsl?raw';
import confineSrc from './shaders/confine.wgsl?raw';
import mixSrc from './shaders/mix.wgsl?raw';
import forcesSrc from './shaders/forces.wgsl?raw';
import divergenceSrc from './shaders/divergence.wgsl?raw';
import pressureSrc from './shaders/pressure.wgsl?raw';
import projectSrc from './shaders/project.wgsl?raw';
import radiationSrc from './shaders/radiation.wgsl?raw';

import { AMBIENT_TEMP, BED_HEIGHT, FIREBOX, SIM_DT, THROAT, type Params, type Quality } from '../config';
import { halfToFloat } from '../half';
import type { Vec3 } from '../math';
import type { Room } from '../rooms';
import type { LogSystem } from './LogSystem';

const PARAMS_SIZE = 368;
const WORKGROUP = [8, 4, 4];
const RADIATION_BLOCKS = 24;
// Mixing of the gases finer than the grid (m2/s: see mix.wgsl), and the most of it one explicit
// pass can do in a step (as a share of each cell's neighbours; stable up to 1/6).
const MIXING = 2.5e-4;
const MIX_STEP = 0.15;

/** Grid for a room's air at a quality: cubic cells, as many as the quality allows. */
export function gridFor(room: Room, quality: Quality): { dims: [number, number, number]; h: number } {
  const [sx, sy, sz] = room.domain.size;
  const h0 = Math.cbrt((sx * sy * sz) / quality.cells);
  const nx = Math.round(sx / h0);
  const h = sx / nx;
  return { dims: [nx, Math.round(sy / h), Math.round(sz / h)], h };
}

export interface Blow {
  pos: Vec3; // world position
  radius: number; // metres
  vel: Vec3; // m/s
  strength: number; // 0..1
}

/**
 * Grid-based fire solver on the GPU: a MacCormack-advected, pressure-projected gas on a
 * staggered grid, carrying temperature, fuel, oxygen, soot and smoke, driven by buoyancy and
 * a simple combustion model, and fed by the log model's surfaces.
 *
 * Texture roles per step (fixed, so no ping-pong bookkeeping):
 *   advect A:  V0,S0,X0 -> V2,S2,X2      advect B: V0,S0,X0,V2,S2,X2 -> V1,S1,X1
 *   mix:       S1,X1 -> S2,X2            forces:   V1,S2,X2 -> V2,S0,X0
 *   project:   V2 -> V0
 * The current state is always V0 (velocity), S0 (scalars) and X0 (smoke) between steps.
 */
export class FireSim {
  readonly dims: [number, number, number];
  readonly h: number;
  readonly origin: Vec3;
  readonly room: Room;
  time = 0;

  private readonly vel: GPUTexture[];
  private readonly scal: GPUTexture[];
  private readonly aux: GPUTexture[];
  private readonly buffers: GPUBuffer[] = [];
  private readonly paramsBuf: GPUBuffer;
  private readonly pressure: GPUBuffer;
  private readonly solid: GPUBuffer;
  private readonly radiation: GPUBuffer;
  private readonly expand: GPUBuffer;
  private readonly paramData = new ArrayBuffer(PARAMS_SIZE);
  private frame = 0;
  private flameStaging: GPUBuffer | null = null;
  private flameBusy = false;
  /** Power (W) the flames radiate, as of the latest sampleFlamePower(). */
  flamePower = 0;

  private readonly clearStage: Stage;
  private readonly stages: Stage[];
  private readonly pressureStages: [Stage, Stage];
  private readonly finalStages: Stage[];

  constructor(
    private readonly device: GPUDevice,
    readonly quality: Quality,
    private readonly logs: LogSystem,
  ) {
    this.room = logs.room;
    const grid = gridFor(this.room, quality);
    this.dims = grid.dims;
    this.h = grid.h;
    this.origin = this.room.domain.min;
    const [nx, ny, nz] = this.dims;
    const cells = nx * ny * nz;

    const makeField = (label: string, size: number[]) =>
      device.createTexture({
        label,
        size,
        dimension: '3d',
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.vel = [0, 1, 2].map((i) => makeField(`velocity ${i}`, [nx + 1, ny + 1, nz + 1]));
    this.scal = [0, 1, 2].map((i) => makeField(`scalars ${i}`, [nx, ny, nz]));
    this.aux = [0, 1, 2].map((i) => makeField(`smoke ${i}`, [nx, ny, nz]));

    const makeBuffer = (label: string, size: number, usage = GPUBufferUsage.STORAGE) => {
      const b = device.createBuffer({ label, size, usage });
      this.buffers.push(b);
      return b;
    };
    this.paramsBuf = makeBuffer('sim params', PARAMS_SIZE, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
    const curl = makeBuffer('curl', cells * 16);
    const confine = makeBuffer('confinement', cells * 16);
    const expand = makeBuffer('expansion', cells * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.expand = expand;
    const div = makeBuffer('divergence', cells * 4);
    this.solid = makeBuffer('solid', cells * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
    this.pressure = makeBuffer('pressure', cells * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);
    this.radiation = makeBuffer('radiation blocks', RADIATION_BLOCKS * 16, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC);

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      addressModeW: 'clamp-to-edge',
    });

    const [V0, V1, V2] = this.vel.map((t) => t.createView());
    const [S0, S1, S2] = this.scal.map((t) => t.createView());
    const [X0, X1, X2] = this.aux.map((t) => t.createView());
    const P = { buffer: this.paramsBuf };
    const solid = { buffer: this.solid };
    const logBuf = { buffer: logs.logBuffer };
    const geo = logs.geo.createView({ dimension: '2d-array' });
    const flux = logs.flux.createView({ dimension: '2d-array' });
    const cellGroups = this.groups(nx, ny, nz);
    const texelGroups = this.groups(nx + 1, ny + 1, nz + 1);

    const stage = (label: string, code: string, resources: GPUBindingResource[], groups: number[], constants?: Record<string, number>) =>
      makeStage(device, label, commonSrc + logsSharedSrc + code, resources, groups, constants);

    this.clearStage = stage('clear', clearSrc, [P, V0, S0, X0], texelGroups);
    // The finer the grid, the more of its cells the gases mix across in a step: on the finest,
    // more than one explicit pass can take, so the mixing is split into several, back and forth
    // (an odd number, to end where the forces pass reads).
    // (A grid coarser than the one the mixing was tuned on cannot resolve the eddies between its
    // cells' size and that: their share of the mixing grows as the cell size to the 4/3, the
    // scaling of eddy diffusion in the inertial range of turbulence.)
    const mixScale = quality.mixRef ? Math.pow(this.h / quality.mixRef, 4 / 3) : 1;
    const mixPasses = 2 * Math.ceil((Math.ceil((MIXING * mixScale * SIM_DT) / (this.h * this.h) / MIX_STEP) - 1) / 2) + 1;
    const mixing = { MIXING: MIXING * mixScale, MIX_PASSES: mixPasses };
    const mixOn = stage('mix', mixSrc, [P, S1, X1, solid, S2, X2], cellGroups, mixing);
    const tracing = { TRACE_CELLS: quality.traceCells ?? 0 };
    const mixBack = mixPasses > 1 ? stage('mix back', mixSrc, [P, S2, X2, solid, S1, X1], cellGroups, mixing) : mixOn;
    this.stages = [
      stage('solid', solidSrc, [P, logBuf, geo, logs.mapSampler, solid], cellGroups),
      stage('advect A', advectCommonSrc + advectASrc, [P, sampler, V0, S0, X0, V2, S2, X2], texelGroups, tracing),
      stage('advect B', advectCommonSrc + advectBSrc, [P, sampler, V0, S0, X0, V2, S2, X2, V1, S1, X1], texelGroups, tracing),
      ...Array.from({ length: mixPasses }, (_, i) => (i % 2 ? mixBack : mixOn)),
      stage('curl', curlSrc, [P, V1, { buffer: curl }], cellGroups),
      stage('confine', confineSrc, [P, { buffer: curl }, solid, { buffer: confine }], cellGroups),
      stage(
        'forces',
        solidFacesSrc + solidMotionSrc + forcesSrc,
        [P, V1, S2, X2, { buffer: confine }, solid, logBuf, V2, S0, X0, { buffer: expand }, geo, flux, logs.mapSampler, logs.bedMap.createView(), sampler],
        texelGroups,
        // (What a coarse grid needs besides more mixing: a thicker layer of gas off the logs, less soot
        // per gas burnt, and more cooling. A cell holds flame and cool air mixed, so its mean
        // temperature understates the radiation, which goes as the fourth power, and the more so the
        // coarser the cell: the loss is scaled by about the square root of the cell size over High's,
        // which fits all four rooms.)
        { SURFACE_LAYER: Math.max(0.011, (quality.fuelLayer ?? 0) * this.h), SOOT_SCALE: quality.sootScale ?? 1, COOL_SCALE: quality.coolRef ? Math.sqrt(this.h / quality.coolRef) : 1 },
      ),
      stage('divergence', divergenceSrc, [P, V2, solid, { buffer: expand }, { buffer: div }], cellGroups),
    ];
    const half = this.groups(Math.ceil(nx / 2), ny, nz);
    const pressureRes = [P, { buffer: div }, solid, { buffer: this.pressure }];
    this.pressureStages = [
      stage('pressure red', pressureSrc, pressureRes, half, { PARITY: 0 }),
      stage('pressure black', pressureSrc, pressureRes, half, { PARITY: 1 }),
    ];
    this.finalStages = [
      stage('project', solidFacesSrc + solidMotionSrc + projectSrc, [P, V2, solid, { buffer: this.pressure }, V0, logBuf], texelGroups),
      stage('radiation', radiationSrc, [P, S0, { buffer: this.radiation }], [RADIATION_BLOCKS, 1, 1]),
    ];

    logs.attach(
      {
        scalars: S0,
        velocity: V0,
        sampler,
        radiation: this.radiation,
        radiationBlocks: RADIATION_BLOCKS,
        origin: this.origin,
        h: this.h,
        dims: this.dims,
      },
      quality,
    );
  }

  /** Scalar field (temperature, fuel, oxygen, soot) after the latest step. */
  get scalars(): GPUTexture {
    return this.scal[0];
  }

  /** Smoke field after the latest step. */
  get smoke(): GPUTexture {
    return this.aux[0];
  }

  /** Staggered velocity field after the latest step (see common.wgsl for the layout). */
  get velocity(): GPUTexture {
    return this.vel[0];
  }

  /** Which cells the air takes to be solid (0: air; 1..15: walls and stones; 16 + i: log i). */
  get solidCells(): GPUBuffer {
    return this.solid;
  }

  reset(params: Params) {
    this.time = 0;
    this.writeParams(0, params, null);
    this.device.queue.writeBuffer(this.pressure, 0, new Float32Array(this.dims[0] * this.dims[1] * this.dims[2]));
    this.device.queue.writeBuffer(this.radiation, 0, new Float32Array(RADIATION_BLOCKS * 4));
    const enc = this.device.createCommandEncoder({ label: 'sim reset' });
    const pass = enc.beginComputePass();
    this.clearStage.run(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  step(dt: number, params: Params, blow: Blow | null) {
    this.time += dt;
    this.frame++;
    this.writeParams(dt, params, blow);
    const enc = this.device.createCommandEncoder({ label: 'sim step' });
    const pass = enc.beginComputePass({ label: 'fire solver' });
    this.logs.encode(pass);
    for (const s of this.stages) s.run(pass);
    for (let i = 0; i < this.quality.pressureIterations; i++) {
      this.pressureStages[0].run(pass);
      this.pressureStages[1].run(pass);
    }
    for (const s of this.finalStages) s.run(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * Starts reading back how much the flames radiate, and from where (for the sound and for
   * heating the coal bed); lands in flamePower and the log system's `flames`.
   */
  sampleFlamePower() {
    if (this.flameBusy) return;
    this.flameBusy = true;
    const size = RADIATION_BLOCKS * 16;
    const staging = (this.flameStaging ??= this.device.createBuffer({ label: 'flame power', size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    const enc = this.device.createCommandEncoder({ label: 'flame power' });
    enc.copyBufferToBuffer(this.radiation, 0, staging, 0, size);
    this.device.queue.submit([enc.finish()]);
    staging.mapAsync(GPUMapMode.READ).then(
      () => {
        const blocks = new Float32Array(staging.getMappedRange()).slice();
        staging.unmap();
        let sum = 0;
        for (let b = 0; b < RADIATION_BLOCKS; b++) sum += blocks[b * 4 + 3];
        this.flamePower = sum;
        if (this.logs.room === this.room) this.logs.flames = blocks;
        this.flameBusy = false;
      },
      () => (this.flameBusy = false),
    );
  }

  /** Reads the current fields back to the CPU (for debugging and tuning). */
  async readFields(): Promise<{
    vel: Float32Array;
    scal: Float32Array;
    smoke: Float32Array;
    solid: Uint32Array;
    radiation: Float32Array;
    expand: Float32Array;
    pressure: Float32Array;
  }> {
    const [nx, ny, nz] = this.dims;
    const readTexture = async (tex: GPUTexture) => {
      const [w, hgt, d] = [tex.width, tex.height, tex.depthOrArrayLayers];
      const bytesPerRow = Math.ceil((w * 8) / 256) * 256;
      const buf = this.device.createBuffer({ size: bytesPerRow * hgt * d, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = this.device.createCommandEncoder();
      enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow, rowsPerImage: hgt }, [w, hgt, d]);
      this.device.queue.submit([enc.finish()]);
      await buf.mapAsync(GPUMapMode.READ);
      const halves = new Uint16Array(buf.getMappedRange());
      const out = new Float32Array(w * hgt * d * 4);
      const rowHalves = bytesPerRow / 2;
      for (let z = 0; z < d; z++) {
        for (let y = 0; y < hgt; y++) {
          const src = (z * hgt + y) * rowHalves;
          const dst = (z * hgt + y) * w * 4;
          for (let i = 0; i < w * 4; i++) out[dst + i] = halfToFloat(halves[src + i]);
        }
      }
      buf.unmap();
      buf.destroy();
      return out;
    };
    const readBuffer = async (src: GPUBuffer, size: number) => {
      const copy = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, copy, 0, size);
      this.device.queue.submit([enc.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      const data = copy.getMappedRange().slice(0);
      copy.destroy();
      return data;
    };
    const solid = new Uint32Array(await readBuffer(this.solid, nx * ny * nz * 4));
    const radiation = new Float32Array(await readBuffer(this.radiation, RADIATION_BLOCKS * 16));
    const expand = new Float32Array(await readBuffer(this.expand, nx * ny * nz * 4));
    const pressure = new Float32Array(await readBuffer(this.pressure, nx * ny * nz * 4));
    return {
      expand,
      pressure,
      vel: await readTexture(this.vel[0]),
      scal: await readTexture(this.scal[0]),
      smoke: await readTexture(this.aux[0]),
      solid,
      radiation,
    };
  }

  destroy() {
    for (const t of [...this.vel, ...this.scal, ...this.aux]) t.destroy();
    for (const b of this.buffers) b.destroy();
    this.flameStaging?.destroy();
  }

  private groups(x: number, y: number, z: number): number[] {
    return [Math.ceil(x / WORKGROUP[0]), Math.ceil(y / WORKGROUP[1]), Math.ceil(z / WORKGROUP[2])];
  }

  private toCells(p: Vec3): Vec3 {
    return [(p[0] - this.origin[0]) / this.h, (p[1] - this.origin[1]) / this.h, (p[2] - this.origin[2]) / this.h];
  }

  private writeParams(dt: number, p: Params, blow: Blow | null) {
    const f = new Float32Array(this.paramData);
    const u = new Uint32Array(this.paramData);
    const h = this.h;
    const o = this.origin;
    u.set(this.dims, 0);
    u[3] = this.frame;
    f.set(o, 4);
    f[7] = h;
    f[8] = dt;
    f[9] = this.time;
    f[10] = AMBIENT_TEMP;
    f[11] = p.buoyancy;
    f[12] = p.vorticity * (this.quality.swirl ?? 1);
    f[13] = p.damping;
    f[14] = p.burnRate;
    f[15] = p.ignitionTemp;
    f[16] = p.heatRelease;
    f[17] = p.stoich;
    f[18] = p.sootYield;
    f[19] = p.sootBurn;
    f[20] = p.cooling;
    const room = this.room;
    const opening = room.opening;
    const open = room.enclosure === 'open';
    f[21] = opening.apex / h;
    // (A chimney draws because the hot gas in it is lighter: more strongly the stronger gravity.)
    f[22] = open ? 0 : p.draft * Math.sqrt(Math.max(p.gravity, 0) / 9.81);
    f[23] = p.turbulence;
    f[24] = p.smokeYield;
    f[25] = p.smokeDecay;
    f[26] = 0;
    f[27] = 0;
    if (blow && blow.strength > 0) {
      f.set([...this.toCells(blow.pos), blow.radius / h], 28);
      f.set([...blow.vel, blow.strength], 32);
    } else {
      f.fill(0, 28, 36);
    }
    const bed = room.bed;
    f.set([(bed.minX - o[0]) / h, (bed.maxX - o[0]) / h, (bed.minZ - o[2]) / h, (bed.maxZ - o[2]) / h], 36);
    const nz = this.dims[2];
    if (open) {
      f.fill(0, 40, 48);
    } else {
      f.set([-o[0] / h, FIREBOX.backHalfWidth / h, FIREBOX.frontHalfWidth / h, -o[2] / h], 40);
      f.set([(-THROAT.halfWidth - o[0]) / h, (THROAT.halfWidth - o[0]) / h, nz - THROAT.depth / h, nz], 44);
    }
    f[48] = BED_HEIGHT / h;
    f[49] = opening.spring / h;
    f[50] = p.expansion;
    f[51] = opening.halfWidth / h;
    u[52] = open ? 1 : 0;
    const ring = room.ring;
    f[53] = ring ? ring.height / h : 0;
    f[54] = p.gravity;
    f[55] = 0;
    f.set(ring ? [-o[0] / h, -o[2] / h, ring.inner / h, ring.outer / h] : [0, 0, 0, 0], 56);
    // Firelighters and a match: the fuel each gives off (as the wood gas the solver burns),
    // spread over a small ball.
    const burners = this.logs.burners();
    for (let i = 0; i < 4; i++) {
      const b = burners[i];
      const at = 60 + i * 8;
      if (!b) {
        f.fill(0, at, at + 8);
        continue;
      }
      const r = Math.max(b.radius, 1.3 * h);
      const volume = (8 * Math.PI * r ** 3) / 15; // of the weighting 1 - (d/r)^2 over the ball
      const fuelRate = b.power / (p.heatRelease * 1200) / volume;
      // A third burns on the spot, the rest rises as vapour and burns in the flame above.
      f.set([...this.toCells(b.pos), r / h, 0.65 * fuelRate, b.temp, 0.35 * fuelRate, 0], at);
    }
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.paramData);
  }
}

interface Stage {
  run(pass: GPUComputePassEncoder): void;
}

function makeStage(
  device: GPUDevice,
  label: string,
  code: string,
  resources: GPUBindingResource[],
  groups: number[],
  constants?: Record<string, number>,
): Stage {
  const module = device.createShaderModule({ label, code });
  const pipeline = device.createComputePipeline({
    label,
    layout: 'auto',
    compute: { module, entryPoint: 'main', constants },
  });
  const bindGroup = device.createBindGroup({
    label,
    layout: pipeline.getBindGroupLayout(0),
    entries: resources.map((resource, binding) => ({ binding, resource })),
  });
  const [x, y, z] = groups;
  return {
    run(pass) {
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(x, y, z);
    },
  };
}
