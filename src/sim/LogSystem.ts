import logsSharedSrc from './shaders/logs_shared.wgsl?raw';
import logPhysicsSrc from './shaders/log_physics.wgsl?raw';
import logSurfaceSrc from './shaders/log_surface.wgsl?raw';
import logVoxelSrc from './shaders/log_voxel.wgsl?raw';
import logSplitSrc from './shaders/log_split.wgsl?raw';
import logMoistureSrc from './shaders/log_moisture.wgsl?raw';
import logWetnessSrc from './shaders/log_wetness.wgsl?raw';

import { buildBlackbodyTable } from '../blackbody';
import { AMBIENT_TEMP, BED_HEIGHT, FIREBOX, GRATE, LOG_GRID, WOODS, type Params, type Wood } from '../config';
import { halfToFloat } from '../half';
import { layFire, type FireMode } from '../layouts';
import { add, cross, dot, length, normalize, quatAxisAngle, quatFromBasis, quatMultiply, quatRotate, scale, sub, type Quat, type Vec3 } from '../math';
import { ANDIRONS, fireCentre, type Room } from '../rooms';
import { BED_N, CoalBed } from './CoalBed';
import type { Impact, LogPhysics, LogPose, LogShape } from './LogPhysics';

const { nx: NX, ns: NS, nt: NT, maxLogs: MAX } = LOG_GRID;
const VOXELS = NX * NX * NS;
const LOG_FLOATS = 32; // LogGPU: eight vec4s
const STEP_SIZE = 112; // LogStep uniform
const MAX_SUBSTEP = 0.5; // s of log time per substep
const MAX_PILE = 0.5; // highest a new log may come to rest in a fireplace (m, axis height)
const MAX_HEAP = 0.55; // and on a campfire, laid across the top of it
const DROP = 0.06; // a new log is let go this far above where it will land (m)
// Collision shape: convex pieces along the log, each from rings of surface points.
const PIECES = 6;
const HULL_ANGLES = 16;
const RESHAPE = 0.002; // m of change in the surface before the collision shape is rebuilt
// Breaking. A log snaps by itself where it has burnt through to this fraction of its original
// radius; where it is this thin and mostly char, a knock or a poke breaks it.
const SNAP_RADIUS = 0.3;
const WEAK_RADIUS = 0.5;
const MIN_PIECE = 0.06; // m
const READBACK_ROW = Math.ceil((NS * 8) / 256) * 256; // bytes per row of a surface map copy
const SIGMA = 5.67e-8;
const CHAR_SHED = 0.002; // kg/s of glowing char flaking off each m2 of glowing surface
const SKY_TEMP = 255; // K: what a clear night sky radiates like
// Firelighters: paraffin and wood-fibre cubes that burn with a steady flame for several minutes.
export const LIGHTER = { size: 0.028, height: 0.02, burn: 600, power: 1200, radius: 0.017, temp: 1150 };
// A long fireplace match.
const MATCH = { power: 70, radius: 0.007, temp: 1300 };

/** Gas-solver resources the log model reads (from FireSim). */
export interface GasLink {
  scalars: GPUTextureView;
  velocity: GPUTextureView;
  sampler: GPUSampler;
  radiation: GPUBuffer; // radiation blocks: xyz position, w power (W)
  radiationBlocks: number;
  origin: Vec3;
  h: number;
  dims: [number, number, number];
}

/** A small flame the solver adds by itself: a burning firelighter or a match. */
export interface Burner {
  pos: Vec3;
  radius: number; // m
  power: number; // W
  temp: number; // K of the gas it gives off
}

interface Lighter {
  pos: Vec3; // middle of its base
  lit: boolean;
  left: number; // s of burning left (log time)
  heat: number; // s a flame has been held to it
}

/** A firelighter as drawn: how tall it still is, whether it is burning. */
export interface LighterView {
  pos: Vec3;
  height: number;
  burning: number; // 0..1
  spent: number; // 0..1 how much of it has burnt
}

interface Log {
  id: number; // unique; also the generation of its slot
  slot: number;
  placedStep: number; // log step count when it was put in (its maps exist only after that)
  woodKey: string;
  wood: Wood;
  radius: number; // original radius (m)
  length: number;
  seed: number;
  sOffset: number; // where end A sits along the log this piece broke off (m)
  pose: LogPose;
  // From the latest readback of its surface map (texel t around, k along: [t * NS + k]).
  radii: Float32Array | null;
  temps: Float32Array | null;
  chars: Float32Array | null;
  sliceRadius: Float32Array | null; // mean radius of each slice
  sliceChar: Float32Array | null;
  hullRings: Float32Array | null; // ring radii its collision shape was built from
  meanRadius: number;
  glowArea: number; // m2 of glowing char
  maxTemp: number;
  charFrac: number; // share of its surface that is char
  gasRate: number; // kg/s of wood gas given off
  steamRate: number; // kg/s of steam
  lastKnock: number; // time of the last poke or impact that made a sound
}

/** What a log is doing, for the sound. */
export interface LogSound {
  id: number;
  centre: Vec3;
  wood: string;
  gas: number; // kg/s
  steam: number; // kg/s
  glow: number; // m2 glowing
}

export interface Knock {
  pos: Vec3;
  speed: number; // m/s
  energy: number; // J
  against: Impact['against'] | 'poker';
  charred: number; // 0..1, how much of the log's surface is char
  glowing: boolean;
}

/**
 * The logs: their interiors (a voxel model of heat, water, wood and char on the GPU), their
 * bodies (rigid-body physics: they fall, roll, get picked up and break), the coal bed they shed
 * onto, the firebox walls they warm, and whatever lights them: firelighters and a match.
 */
export class LogSystem {
  readonly logBuffer: GPUBuffer;
  readonly geo: GPUTexture; // per log: surface radius, surface T, char fraction, ash
  readonly flux: GPUTexture; // per log: wood gas, steam, CO (kg/m2/s), moisture fraction
  readonly look: GPUBuffer; // per voxel: T, char fraction, fill, ash (for drawing cut ends)
  readonly prod: GPUBuffer; // per voxel: wood gas and steam given off, ash, moisture content
  readonly mapSampler: GPUSampler;
  readonly bed: CoalBed;
  readonly bedMap: GPUTexture; // see CoalBed.mapData
  /** Fire already burning, or laid cold (applies from the next reset). */
  mode: FireMode = 'lit';
  wallTemp = 560; // K: the firebox walls (or the stones and ground round a campfire)
  /** Radiation blocks of the flames (xyz position, w power in W), as last read back. */
  flames: Float32Array | null = null;
  private flameGain = 1; // (Params.flameRadiation)

  /** A log hit something (landed, was dropped, was poked). */
  onKnock?: (knock: Knock) => void;
  /** A log broke in two at pos. */
  onBreak?: (pos: Vec3, radius: number) => void;
  /** A burnt-down log collapsed into the coals. */
  onCrumble?: (pos: Vec3, size: number) => void;
  /** A firelighter caught. */
  onLight?: (pos: Vec3) => void;

  private readonly logs: (Log | null)[] = new Array(MAX).fill(null);
  private readonly state: GPUBuffer[];
  private readonly surf: GPUBuffer;
  private readonly moistureStage: Stage;
  // Making the logs on the fire wetter or drier (Science): a factor for each slot's water.
  private readonly wetnessFactors: GPUBuffer;
  private readonly wetnessStages: Stage[];
  private readonly moistureTotals: GPUBuffer;
  private measuring = false;
  /** How wet each log is (water per dry wood), by log id, as last measured. */
  readonly moisture = new Map<number, number>();
  private readonly stepBuffer: GPUBuffer;
  private readonly stepData = new ArrayBuffer(STEP_SIZE);
  private readonly logData = new Float32Array(MAX * LOG_FLOATS);
  private readonly voxelStages: Stage[];
  private surfaceStages: Stage[] = [];
  private readonly scratch: GPUBuffer[];
  private readonly splitParams: GPUBuffer[];
  private readonly splitPipeline: GPUComputePipeline;
  private readonly splitGroups: GPUBindGroup[][];
  private gas: GasLink | null = null;
  private lighters: Lighter[] = [];
  // Props a teepee's logs lean on, until one of them is disturbed (see layouts.ts).
  private supports: { handle: number; ids: number[]; starts: Vec3[] }[] = [];
  private laidAt = 0; // (s) when the fire was last laid
  private match: Vec3 | null = null;
  private activity = 0; // how much of the logs glows (0..1), for warming the walls
  private parity = 0;
  private substeps = 1;
  private steps = 0;
  private nextId = 0;
  private time = 0;
  private readbackTimer = 0;
  private reading = false;

  constructor(
    private readonly device: GPUDevice,
    readonly physics: LogPhysics,
    public room: Room,
  ) {
    physics.setRoom(room);
    const storage = (label: string, size: number) =>
      device.createBuffer({ label, size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    this.logBuffer = storage('logs', MAX * LOG_FLOATS * 4);
    this.state = [storage('log state A', MAX * VOXELS * 16), storage('log state B', MAX * VOXELS * 16)];
    this.prod = storage('log production', MAX * VOXELS * 16);
    this.look = storage('log look', MAX * VOXELS * 16);
    this.surf = storage('log surface flux', MAX * NS * NT * 16);
    this.stepBuffer = device.createBuffer({ label: 'log step', size: STEP_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    const map = (label: string) =>
      device.createTexture({
        label,
        size: [NS, NT, MAX],
        format: 'rgba16float',
        usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC,
      });
    this.geo = map('log surface');
    this.flux = map('log gas flux');
    this.mapSampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'repeat',
    });
    this.bed = new CoalBed(room.bed, buildBlackbodyTable());
    this.bedMap = device.createTexture({
      label: 'coal bed',
      size: [BED_N, BED_N],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const voxelCode = logsSharedSrc + logPhysicsSrc + logVoxelSrc;
    const groups = [Math.ceil(NX / 8), Math.ceil(NX / 8), NS * MAX];
    this.voxelStages = [0, 1].map((p) =>
      makeStage(device, `log voxels ${p}`, voxelCode, [
        { buffer: this.stepBuffer },
        { buffer: this.logBuffer },
        { buffer: this.state[p] },
        { buffer: this.state[1 - p] },
        { buffer: this.prod },
        { buffer: this.surf },
        { buffer: this.look },
      ], groups),
    );

    this.moistureTotals = device.createBuffer({ label: 'log moisture', size: MAX * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    this.moistureStage = makeStage(device, 'log moisture', logsSharedSrc + logMoistureSrc, [
      { buffer: this.prod },
      { buffer: this.look },
      { buffer: this.moistureTotals },
    ], [MAX, 1, 1]);

    this.wetnessFactors = device.createBuffer({ label: 'log wetness', size: MAX * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.wetnessStages = [0, 1].map((p) =>
      makeStage(device, `log wetness ${p}`, logsSharedSrc + logWetnessSrc, [{ buffer: this.wetnessFactors }, { buffer: this.state[p] }], [Math.ceil((MAX * VOXELS) / 64), 1, 1]),
    );

    // Breaking a log: copy it aside, then resample each piece into its slot.
    this.scratch = [storage('split scratch state', VOXELS * 16), storage('split scratch production', VOXELS * 16)];
    this.splitParams = [0, 1].map((i) =>
      device.createBuffer({ label: `split piece ${i}`, size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }),
    );
    const splitModule = device.createShaderModule({ label: 'log split', code: logsSharedSrc + logSplitSrc });
    this.splitPipeline = device.createComputePipeline({ label: 'log split', layout: 'auto', compute: { module: splitModule, entryPoint: 'main' } });
    this.splitGroups = [0, 1].map((p) =>
      this.splitParams.map((params) =>
        device.createBindGroup({
          label: 'log split',
          layout: this.splitPipeline.getBindGroupLayout(0),
          entries: [params, this.scratch[0], this.scratch[1], this.state[p], this.prod].map((buffer, binding) => ({ binding, resource: { buffer } })),
        }),
      ),
    );
  }

  /** Connects the log model to (a new) gas solver. */
  attach(gas: GasLink) {
    this.gas = gas;
    const code = logsSharedSrc + logPhysicsSrc + logSurfaceSrc;
    const groups = [Math.ceil(NS / 8), Math.ceil(NT / 8), MAX];
    this.surfaceStages = [0, 1].map((p) =>
      makeStage(this.device, `log surfaces ${p}`, code, [
        { buffer: this.stepBuffer },
        { buffer: this.logBuffer },
        { buffer: this.state[p] },
        { buffer: this.prod },
        gas.scalars,
        gas.velocity,
        gas.sampler,
        { buffer: gas.radiation },
        this.geo.createView({ dimension: '2d-array' }),
        this.flux.createView({ dimension: '2d-array' }),
        { buffer: this.surf },
        this.bedMap.createView(),
      ], groups),
    );
  }

  /** Moves the fire to another room (and lays it there). */
  setRoom(room: Room) {
    this.physics.clear();
    this.logs.fill(null);
    this.supports = []; // (they go with the old fireplace)
    this.room = room;
    this.physics.setRoom(room);
    this.reset();
  }

  /**
   * Starts over: lays the fire for the room and mode. Logs on a grate or andirons are lowered
   * onto what is below them here, rather than by the physics (which only knows about a new
   * fireplace once it has taken a step).
   */
  reset() {
    this.physics.clear();
    this.logs.fill(null);
    this.match = null;
    this.flames = null;
    const layout = layFire(this.room, this.mode);
    this.wallTemp = layout.walls;
    this.activity = 0;
    this.bed.setRect(this.room.bed);
    this.bed.fill(layout.coals, layout.coalTemp, layout.walls, this.room.bed.round, layout.coalAsh);
    this.lighters = layout.lighters.map((pos) => ({ pos, lit: false, left: LIGHTER.burn, heat: 0 }));

    for (const s of this.supports) this.physics.removeSupport(s.handle);
    this.supports = [];

    // What a level log lowered at a..b comes down on first: the andirons' bars (if it lies
    // across them), the grate, or the floor.
    const support = (a: Vec3, b: Vec3) => {
      if (this.room.support === 'andirons') {
        const across = ANDIRONS.x.some((x) => Math.min(a[0], b[0]) < x && Math.max(a[0], b[0]) > x);
        return across ? ANDIRONS.barY + ANDIRONS.barRadius : 0;
      }
      return this.room.support === 'grate' ? GRATE.top : 0;
    };
    const placed: { a: Vec3; b: Vec3; r: number; y: number }[] = [];
    const laid: (Log | null)[] = [];
    for (const spec of layout.logs) {
      const r = spec.radius;
      let a = spec.a;
      let b = spec.b;
      if (spec.stacked) {
        // Lowered until it rests on the support or on a log below (logs lie level here).
        let y = support(a, b) + r;
        for (const q of placed) {
          const d = segmentDistanceXZ(a, b, q.a, q.b);
          if (d < q.r + r) y = Math.max(y, q.y + Math.sqrt((q.r + r) ** 2 - d * d));
        }
        y += 0.003;
        a = [a[0], y, a[2]];
        b = [b[0], y, b[2]];
        placed.push({ a, b, r, y });
      }
      const d = sub(b, a);
      const pose: LogPose = { centre: scale(add(a, b), 0.5), rot: levelFrame(normalize(d)), vel: [0, 0, 0], spin: [0, 0, 0] };
      laid.push(this.place(spec.wood, r, length(d), pose, spec.preburn));
    }
    for (const s of layout.supports) {
      const members = s.members.map((i) => laid[i]).filter((l): l is Log => !!l);
      this.supports.push({ handle: this.physics.addSupport(s.hull), ids: members.map((l) => l.id), starts: members.map((l) => l.pose.centre) });
    }
    this.laidAt = this.time;
    this.upload();
    this.uploadBed();
  }

  /**
   * A teepee's prop goes once any of its logs is knocked or carried off, has broken or has burnt
   * thin. (Logs settling a centimetre or two against it don't count, nor the little jolt a stick
   * gives as its shape is remade while it burns.)
   */
  private checkSupports() {
    // Just after the fire is laid its logs are still settling against the prop: that doesn't
    // count, and where they come to rest is where they start from.
    const settling = this.time - this.laidAt < 1.5;
    this.supports = this.supports.filter((s) => {
      const disturbed = s.ids.some((id, i) => {
        const log = this.byId(id);
        if (log && settling && this.physics.held !== id) {
          s.starts[i] = log.pose.centre;
          return false;
        }
        return (
          !log ||
          this.physics.held === id ||
          length(log.pose.vel) > 0.6 ||
          length(sub(log.pose.centre, s.starts[i])) > 0.06 ||
          log.meanRadius < 0.75 * log.radius
        );
      });
      if (disturbed) this.physics.removeSupport(s.handle);
      return !disturbed;
    });
  }

  get count(): number {
    return this.logs.filter(Boolean).length;
  }

  /** How wet the logs are (water per dry wood, by mass), if not as the wood comes (Science: see setMoisture). */
  private moistureOverride: number | null = null;

  /** How wet Science says the wood is (null: as it comes). */
  get wetness(): number | null {
    return this.moistureOverride;
  }

  /**
   * How wet the wood is (Science: water for its dry weight), or null for each as its wood comes:
   * for the logs laid from now on (Start over) and put on, and for those on the fire now. In
   * those, the water left is scaled, so whatever the fire has dried (the char, the dried rim)
   * stays dry and the rest takes the new moisture. Kindling is kept dry.
   */
  setMoisture(moisture: number | null) {
    this.moistureOverride = moisture;
    const factors = new Float32Array(MAX).fill(1);
    let changed = false;
    for (const log of this.logs) {
      if (!log || log.woodKey === 'kindling') continue;
      const target = moisture ?? WOODS[log.woodKey]?.moisture ?? log.wood.moisture;
      if (Math.abs(target - log.wood.moisture) < 1e-6) continue;
      factors[log.slot] = target / log.wood.moisture;
      log.wood = { ...log.wood, moisture: target };
      changed = true;
    }
    if (!changed) return;
    this.device.queue.writeBuffer(this.wetnessFactors, 0, factors);
    const enc = this.device.createCommandEncoder({ label: 'log wetness' });
    const pass = enc.beginComputePass({ label: 'log wetness' });
    this.wetnessStages[this.parity].run(pass);
    pass.end();
    this.device.queue.submit([enc.finish()]);
    // (Each log's water to start with, which the moisture shown is reckoned from.)
    this.upload();
  }

  /** Puts a fresh log (or stick of kindling) on the fire. Returns false when there is no room for it. */
  addLog(woodKey: string): boolean {
    if (!this.logs.includes(null)) return false;
    const kindling = woodKey === 'kindling';
    const size = WOODS[woodKey]?.size;
    const between = (r: [number, number]) => r[0] + Math.random() * (r[1] - r[0]);
    const radius = size ? between(size.radius) : kindling ? 0.011 + Math.random() * 0.004 : 0.042 + Math.random() * 0.016;
    const logLength = size ? between(size.length) : kindling ? 0.24 + Math.random() * 0.06 : 0.36 + Math.random() * 0.09;
    const pose =
      this.room.enclosure !== 'open' ? this.lowerOnto(radius, logLength) : this.room.ring ? this.leanOn(radius, logLength) : this.layIn(radius, logLength);
    return !!pose && this.place(woodKey, radius, logLength, pose, 0) !== null;
  }

  /**
   * Where a new stick goes on a fire laid as a star (as in the desert): pushed in from outside,
   * its end in the middle of the fire, from the side where the sticks are sparsest (and never
   * where the kettle stands). It is dropped a little above the pile, to settle on it.
   */
  private layIn(radius: number, logLength: number): LogPose | null {
    const c = fireCentre(this.room);
    const headings = this.live().map((l) => {
      const { axis } = frame(l.pose.rot);
      const out = sub(l.pose.centre, c);
      return Math.atan2(out[2] || axis[2], out[0] || axis[0]);
    });
    const avoid = this.room.kettle ? [Math.atan2(this.room.kettle.at[2] - c[2], this.room.kettle.at[0] - c[0])] : [];
    const gap = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    let best = 0;
    let bestGap = -1;
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2 + Math.random() * 0.1;
      if (avoid.some((k) => gap(a, k) < 0.55)) continue;
      const g = Math.min(Math.PI, ...headings.map((h) => gap(a, h)));
      if (g > bestGap) {
        bestGap = g;
        best = a;
      }
    }
    const dir: Vec3 = [Math.cos(best), 0, Math.sin(best)];
    const inner = 0.03 + Math.random() * 0.03;
    const mid = inner + logLength / 2;
    const height = this.physics.restHeight(c[0] + dir[0] * mid, c[2] + dir[2] * mid, best, logLength, radius);
    // Tipped a little, its inner end lower (in the coals), as a stick pushed into a fire lies.
    const axis = normalize([dir[0], 0.12, dir[2]]);
    return {
      centre: [c[0] + dir[0] * mid, height + DROP, c[2] + dir[2] * mid],
      rot: quatMultiply(quatAxisAngle(axis, Math.random() * Math.PI * 2), levelFrame(axis)),
      vel: [0, -0.3, 0],
      spin: [0, 0, 0],
    };
  }

  /**
   * Where a new log goes in a fireplace: looking across the grate from back to front for where it
   * would rest lowest, preferring a spot it cannot roll out of (a groove between logs rather
   * than the crown of one). Null when the pile is already high.
   */
  private lowerOnto(radius: number, logLength: number): LogPose | null {
    const x = (Math.random() - 0.5) * 0.06;
    const heading = (Math.random() - 0.5) * 0.3;
    const zs = [-0.33, -0.3, -0.27, -0.24, -0.21, -0.18, -0.15, -0.12, -0.09];
    const heights = zs.map((z) => this.physics.restHeight(x, z, heading, logLength, radius));
    let best: { x: number; z: number; heading: number; height: number } | null = null;
    let bestScore = Infinity;
    for (let i = 1; i < zs.length - 2; i++) {
      const h = heights[i];
      const downhill = Math.max(h - heights[i - 1], h - heights[i + 1], 0);
      const score = h + 2 * downhill + Math.random() * 0.01;
      if (score < bestScore) {
        bestScore = score;
        best = { x, z: zs[i], heading, height: h };
      }
    }
    // Nobody stacks logs to the lintel.
    if (!best || best.height > MAX_PILE) return null;
    const axis: Vec3 = [Math.cos(best.heading), 0, Math.sin(best.heading)];
    const roll = quatAxisAngle(axis, Math.random() * Math.PI * 2);
    return {
      centre: [best.x, best.height + DROP, best.z],
      rot: quatMultiply(roll, levelFrame(axis)),
      vel: [0, -0.3, 0],
      spin: [0, 0, 0],
    };
  }

  /**
   * Where a new log goes on a campfire: stood up leaning in toward the middle, its foot on the
   * ground, somewhere round the fire where there is room for it. It then tips in until it rests
   * against the pile (or falls into the coals if there is no pile left). With no room left round
   * it, it is laid across the top; with the heap already high, nowhere (null).
   */
  private leanOn(radius: number, logLength: number): LogPose | null {
    const c = fireCentre(this.room);
    const start = Math.random() * Math.PI * 2;
    const small = logLength < 0.32;
    // Round the fire, lowered from upright until it would touch the pile: there it rests against
    // the pile (or, with no pile left, it tips over into the coals).
    const pose = (dir: Vec3, foot: number, lean: number): LogPose => {
      const axis = normalize(add(scale(dir, -Math.cos(lean)), [0, Math.sin(lean), 0]));
      const a: Vec3 = [c[0] + dir[0] * foot, radius * Math.cos(lean) + 0.004, c[2] + dir[2] * foot];
      return { centre: add(a, scale(axis, logLength / 2)), rot: levelFrame(axis), vel: [0, 0, 0], spin: [0, 0, 0] };
    };
    const clear = (p: LogPose) => !this.physics.overlaps(p.centre, p.rot, logLength, radius * 1.1 + 0.005);
    for (const foot of small ? [0.16, 0.2] : [0.23, 0.28]) {
      for (let tries = 0; tries < 24; tries++) {
        const phi = start + tries * 2.4;
        const dir: Vec3 = [Math.cos(phi), 0, Math.sin(phi)];
        let best: LogPose | null = null;
        for (let lean = 1.5; lean > 0.9; lean -= 0.02) {
          const p = pose(dir, foot, lean);
          if (!clear(p)) break;
          best = p;
        }
        if (best) return best;
      }
    }
    // No room left to stand another up: lay it across the top, as one does on a big campfire.
    const heading = Math.random() * Math.PI;
    const [x, z] = [c[0] + (Math.random() - 0.5) * 0.1, c[2] + (Math.random() - 0.5) * 0.1];
    const height = this.physics.restHeight(x, z, heading, logLength, radius);
    if (height > MAX_HEAP) return null;
    const axis: Vec3 = [Math.cos(heading), 0, Math.sin(heading)];
    return {
      centre: [x, height + DROP, z],
      rot: quatMultiply(quatAxisAngle(axis, Math.random() * Math.PI * 2), levelFrame(axis)),
      vel: [0, -0.3, 0],
      spin: [0, 0, 0],
    };
  }

  /** The match's flame is here (or null: no match lit). Call every step it is held. */
  holdMatch(pos: Vec3 | null) {
    this.match = pos;
  }

  /** Firelighters, for drawing. */
  lighterViews(): LighterView[] {
    return this.lighters.map((l) => {
      const spent = 1 - l.left / LIGHTER.burn;
      return {
        pos: l.pos,
        height: LIGHTER.height * (1 - 0.7 * spent),
        burning: l.lit && l.left > 0 ? Math.min(1, l.left / 30) : 0,
        spent,
      };
    });
  }

  /** Whether a firelighter is burning (or waiting to be lit). */
  get lighterState(): 'none' | 'unlit' | 'burning' | 'spent' {
    if (!this.lighters.length) return 'none';
    if (this.lighters.some((l) => l.lit && l.left > 0)) return 'burning';
    return this.lighters.some((l) => !l.lit) ? 'unlit' : 'spent';
  }

  /** The small flames the gas solver should add: burning firelighters and a lit match. */
  burners(): Burner[] {
    const out: Burner[] = [];
    for (const l of this.lighters) {
      if (!l.lit || l.left <= 0) continue;
      const burnt = LIGHTER.burn - l.left;
      // It takes a little while to get going and dies down at the end.
      const power = LIGHTER.power * Math.min(1, 0.35 + (0.65 * burnt) / 20) * Math.min(1, l.left / 45);
      const top = LIGHTER.height * (1 - (0.7 * burnt) / LIGHTER.burn);
      out.push({ pos: add(l.pos, [0, top + 0.004, 0]), radius: LIGHTER.radius, power, temp: LIGHTER.temp });
    }
    if (this.match) out.push({ pos: this.match, radius: MATCH.radius, power: MATCH.power, temp: MATCH.temp });
    return out.slice(0, 4);
  }

  /** Writes the step parameters; call once per frame before the solver steps. */
  prepare(params: Params, simDt: number) {
    const gas = this.gas;
    if (!gas) return;
    const logDt = simDt * params.burnSpeed;
    this.substeps = Math.max(1, Math.ceil(logDt / MAX_SUBSTEP));
    const f = new Float32Array(this.stepData);
    const u = new Uint32Array(this.stepData);
    const b = this.room.bed;
    f[0] = logDt / this.substeps;
    f[1] = AMBIENT_TEMP;
    f[2] = this.wallTemp;
    f[3] = SKY_TEMP;
    f[4] = BED_HEIGHT + 0.005;
    f[5] = params.flameRadiation;
    this.flameGain = params.flameRadiation;
    u[6] = gas.radiationBlocks;
    u[7] = this.room.enclosure === 'open' ? 1 : 0;
    f.set([b.minX, b.maxX, b.minZ, b.maxZ], 8);
    f.set([FIREBOX.frontHalfWidth, FIREBOX.backHalfWidth, FIREBOX.depth, FIREBOX.height], 12);
    const o = this.room.opening;
    f.set([o.halfWidth, o.apex, o.spring, 0], 16);
    f.set(gas.origin, 20);
    f[23] = gas.h;
    f.set(gas.dims, 24);
    f[27] = params.cooling;
    this.device.queue.writeBuffer(this.stepBuffer, 0, this.stepData);
  }

  /** Advances the log interiors by one solver step (encoded before the gas passes). */
  encode(pass: GPUComputePassEncoder) {
    if (!this.surfaceStages.length) return;
    for (let i = 0; i < this.substeps; i++) {
      this.surfaceStages[this.parity].run(pass);
      this.voxelStages[this.parity].run(pass);
      this.parity = 1 - this.parity;
    }
    this.steps++;
  }

  /**
   * Moves the logs one physics step (real time) and hands their poses to the GPU. Call before
   * each solver step. pokerSpeed: how fast the poker's tip is moving (m/s).
   */
  step(dt: number, pokerSpeed = 0) {
    this.time += dt;
    this.physics.step(dt);
    for (const log of this.logs) {
      if (log) log.pose = this.physics.pose(log.id) ?? log.pose;
    }
    for (const hit of this.physics.impacts.splice(0)) {
      const log = this.byId(hit.id);
      if (!log) continue;
      this.knock(log, { pos: hit.pos, speed: hit.speed, energy: hit.energy, against: hit.against, charred: log.charFrac, glowing: log.glowArea > 0.002 });
      // A hard knock snaps a log that has burnt thin somewhere.
      if (hit.speed > 1.3) this.breakWeakest(log, WEAK_RADIUS, null);
    }
    for (const poke of this.physics.pokes) {
      const log = this.byId(poke.id);
      if (!log || pokerSpeed < 0.25) continue;
      if (this.time - log.lastKnock > 0.2) {
        this.knock(log, { pos: poke.pos, speed: pokerSpeed, energy: 0.1 * pokerSpeed * pokerSpeed, against: 'poker', charred: log.charFrac, glowing: log.glowArea > 0.002 });
      }
      if (pokerSpeed > 0.35) this.breakWeakest(log, WEAK_RADIUS + 0.05, poke.pos);
    }
    if (this.supports.length) this.checkSupports();
    this.upload();
  }

  /** Per-frame bookkeeping: the coal bed, walls, firelighters, and checking on the logs' surfaces. */
  update(frameDt: number, params: Params) {
    const dtLog = frameDt * params.burnSpeed;
    this.bed.update(dtLog, frameDt, this.room.enclosure === 'open' ? SKY_TEMP : this.wallTemp);
    this.updateWalls(dtLog);
    this.updateLighters(frameDt, dtLog);
    this.uploadBed();
    this.readbackTimer += frameDt;
    if (this.readbackTimer > 0.25 && !this.reading) {
      this.readbackTimer = 0;
      void this.readback();
    }
  }

  /** Someone is blowing on the coals at `at`, or stirring them there (strength 0..1, every frame while they do). */
  blowOnCoals(strength: number, at: Vec3) {
    this.bed.blowAt(at[0], at[2], Math.min(strength, 1));
  }

  /** The poker raking through the coals at `at` (amount 0..1, for dt seconds): they flare and spread. */
  stirCoals(amount: number, at: Vec3, dt: number) {
    this.bed.blowAt(at[0], at[2], Math.min(amount * 0.8, 1));
    this.bed.stirAt(at[0], at[2], amount * dt * 8);
  }

  /** What each log is doing, for the sound. */
  sounds(): LogSound[] {
    return this.live().map((l) => ({ id: l.id, centre: l.pose.centre, wood: l.woodKey, gas: l.gasRate, steam: l.steamRate, glow: l.glowArea }));
  }

  /** Each log's moisture content (water per dry wood left), as last measured, and where it is (not the kindling's). */
  moistureReadings(): { centre: Vec3; top: Vec3; wood: string; moisture: number }[] {
    return this.live()
      .filter((l) => this.moisture.has(l.id) && l.woodKey !== 'kindling')
      .map((l) => ({ centre: l.pose.centre, top: add(l.pose.centre, [0, l.radius + 0.02, 0]), wood: l.woodKey, moisture: this.moisture.get(l.id)! }));
  }

  /** Measures how wet each log is, on the GPU; `moisture` has the answers a moment later. */
  async measureMoisture() {
    if (this.measuring) return;
    this.measuring = true;
    const ids = this.logs.map((l) => (l ? l.id : -1));
    const copy = this.device.createBuffer({ size: MAX * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder({ label: 'log moisture' });
    const pass = enc.beginComputePass({ label: 'log moisture' });
    this.moistureStage.run(pass);
    pass.end();
    enc.copyBufferToBuffer(this.moistureTotals, 0, copy, 0, MAX * 16);
    this.device.queue.submit([enc.finish()]);
    try {
      await copy.mapAsync(GPUMapMode.READ);
      const totals = new Float32Array(copy.getMappedRange());
      this.moisture.clear();
      ids.forEach((id, slot) => {
        const wood = totals[slot * 4 + 1];
        if (id >= 0 && this.logs[slot]?.id === id && wood > 0.5) this.moisture.set(id, totals[slot * 4] / wood);
      });
      copy.unmap();
    } catch {
      // The device went away: nothing to show.
    }
    copy.destroy();
    this.measuring = false;
  }

  /** A random hot, charring spot on a log's surface (where it pops and throws sparks). */
  hotSpot(id: number): { pos: Vec3; normal: Vec3 } | null {
    const log = this.byId(id);
    if (!log || !log.radii || !log.temps || !log.chars) return null;
    for (let tries = 0; tries < 12; tries++) {
      const i = Math.floor(Math.random() * NS * NT);
      if (log.temps[i] < 650 || log.chars[i] < 0.2 || log.radii[i] < 0.004) continue;
      const { pos, normal } = this.texelPoint(log, i);
      return { pos, normal };
    }
    return null;
  }

  /** A log's current mean radius, or null if it is gone. */
  logRadius(id: number): number | null {
    const log = this.byId(id);
    return log ? Math.max(log.meanRadius, 0.01) : null;
  }

  logLength(id: number): number | null {
    return this.byId(id)?.length ?? null;
  }

  /** Breaks a log at a fraction (0..1) along it (for testing). */
  breakLog(slot: number, at = 0.5): boolean {
    const log = this.logs[slot];
    return !!log && this.split(log, Math.round(at * NS));
  }

  /** Jumps to the end of a fire: no logs, a bed of glowing coals skinned with ash (for testing). */
  emberStage() {
    this.physics.clear();
    this.logs.fill(null);
    for (const s of this.supports) this.physics.removeSupport(s.handle);
    this.supports = [];
    this.lighters = [];
    this.bed.fill(6, 1000, 480, this.room.bed.round, 0.95);
    this.upload();
    this.uploadBed();
  }

  /** Lights firelighter i (for testing). */
  lightLighter(i: number) {
    const l = this.lighters[i];
    if (l && !l.lit) {
      l.lit = true;
      this.onLight?.(l.pos);
    }
  }

  // ---- Placing, breaking and removing logs --------------------------------------------------

  private live(): Log[] {
    return this.logs.filter((l): l is Log => !!l);
  }

  private byId(id: number): Log | null {
    return this.logs.find((l) => l?.id === id) ?? null;
  }

  private newLog(slot: number, woodKey: string, radius: number, logLength: number, pose: LogPose): Log {
    return {
      id: ++this.nextId,
      slot,
      placedStep: this.steps,
      woodKey,
      wood: WOODS[woodKey] ?? WOODS.oak,
      radius,
      length: logLength,
      seed: Math.random() * 100,
      sOffset: 0,
      pose,
      radii: null,
      temps: null,
      chars: null,
      sliceRadius: null,
      sliceChar: null,
      hullRings: null,
      meanRadius: radius,
      glowArea: 0,
      maxTemp: 300,
      charFrac: 0,
      gasRate: 0,
      steamRate: 0,
      lastKnock: -1,
    };
  }

  private place(woodKey: string, radius: number, logLength: number, pose: LogPose, preburn: number): Log | null {
    const slot = this.logs.indexOf(null);
    if (slot < 0) return null;
    const log = this.newLog(slot, woodKey, radius, logLength, pose);
    // (As wet as Science says, if it says: see setMoisture. Kindling is kept dry.)
    if (this.moistureOverride !== null && woodKey !== 'kindling') log.wood = { ...log.wood, moisture: this.moistureOverride };
    this.logs[slot] = log;
    this.device.queue.writeBuffer(this.state[this.parity], slot * VOXELS * 16, buildVoxels(log, preburn));
    this.device.queue.writeBuffer(this.prod, slot * VOXELS * 16, new Float32Array(VOXELS * 4));
    const shape = this.shape(log);
    this.physics.addLog(log.id, pose, logLength, shape.shape);
    log.hullRings = shape.rings;
    return log;
  }

  private remove(log: Log) {
    this.physics.removeLog(log.id);
    this.logs[log.slot] = null;
  }

  /**
   * Breaks a log at its thinnest point (near `near`, if given) if that is thinner than `limit`
   * times its original radius and mostly char.
   */
  private breakWeakest(log: Log, limit: number, near: Vec3 | null): boolean {
    if (!log.sliceRadius || !log.sliceChar) return false;
    const min = Math.max(1, Math.ceil((MIN_PIECE / log.length) * NS));
    let lo = min;
    let hi = NS - min;
    if (near) {
      const { axis } = frame(log.pose.rot);
      const k = Math.floor((dot(sub(near, log.pose.centre), axis) / log.length + 0.5) * NS);
      lo = Math.max(lo, k - 5);
      hi = Math.min(hi, k + 5);
    }
    let best = -1;
    for (let k = lo; k < hi; k++) {
      if (best < 0 || log.sliceRadius[k] < log.sliceRadius[best]) best = k;
    }
    if (best < 0 || log.sliceRadius[best] > limit * log.radius || log.sliceChar[best] < 0.5) return false;
    return this.split(log, best);
  }

  /** Splits a log into two pieces at slice boundary `cut`. */
  private split(log: Log, cut: number): boolean {
    const slotB = this.logs.indexOf(null);
    const lengthA = (log.length * cut) / NS;
    const lengthB = log.length - lengthA;
    if (slotB < 0 || cut < 1 || cut >= NS || Math.min(lengthA, lengthB) < MIN_PIECE * 0.8) return false;
    const pose = log.pose;
    const { axis } = frame(pose.rot);
    const endA = sub(pose.centre, scale(axis, log.length / 2));
    const held = this.physics.held === log.id ? this.physics.grip() : null;

    // The interiors, on the GPU.
    const enc = this.device.createCommandEncoder({ label: 'log split' });
    enc.copyBufferToBuffer(this.state[this.parity], log.slot * VOXELS * 16, this.scratch[0], 0, VOXELS * 16);
    enc.copyBufferToBuffer(this.prod, log.slot * VOXELS * 16, this.scratch[1], 0, VOXELS * 16);
    this.device.queue.writeBuffer(this.splitParams[0], 0, splitParams(log.slot, 0, cut));
    this.device.queue.writeBuffer(this.splitParams[1], 0, splitParams(slotB, cut, NS));
    const pass = enc.beginComputePass({ label: 'log split' });
    pass.setPipeline(this.splitPipeline);
    for (const group of this.splitGroups[this.parity]) {
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(Math.ceil(NX / 8), Math.ceil(NX / 8), NS);
    }
    pass.end();
    this.device.queue.submit([enc.finish()]);

    // The bodies: each piece carries on moving as that part of the log was.
    this.physics.removeLog(log.id);
    this.logs[log.slot] = null;
    const pieces: Log[] = [];
    for (const [slot, from, to, offset, pieceLength] of [
      [log.slot, 0, cut, 0, lengthA],
      [slotB, cut, NS, lengthA, lengthB],
    ] as const) {
      const centre = add(endA, scale(axis, offset + pieceLength / 2));
      const piece = this.newLog(slot, log.woodKey, log.radius, pieceLength, {
        centre,
        rot: pose.rot,
        vel: add(pose.vel, cross(pose.spin, sub(centre, pose.centre))),
        spin: pose.spin,
      });
      piece.seed = log.seed;
      piece.wood = log.wood; // (as wet as the log was, whatever the wood's own moisture)
      piece.sOffset = log.sOffset + offset;
      piece.radii = log.radii && resampleMap(log.radii, from, to);
      piece.temps = log.temps && resampleMap(log.temps, from, to);
      piece.chars = log.chars && resampleMap(log.chars, from, to);
      piece.sliceRadius = log.sliceRadius && resampleSlices(log.sliceRadius, from, to);
      piece.sliceChar = log.sliceChar && resampleSlices(log.sliceChar, from, to);
      piece.meanRadius = log.meanRadius;
      piece.charFrac = log.charFrac;
      const share = pieceLength / log.length;
      piece.glowArea = log.glowArea * share;
      piece.gasRate = log.gasRate * share;
      piece.steamRate = log.steamRate * share;
      piece.maxTemp = log.maxTemp;
      this.logs[slot] = piece;
      const shape = this.shape(piece);
      piece.hullRings = shape.rings;
      this.physics.addLog(piece.id, piece.pose, pieceLength, shape.shape);
      pieces.push(piece);
    }
    // Still holding it? Keep hold of the piece that was in the tongs.
    if (held) {
      const s = dot(sub(held.point, endA), axis);
      const kept = s < lengthA ? pieces[0] : pieces[1];
      this.physics.grabLog(kept.id, held.point);
    }
    const at = add(endA, scale(axis, lengthA));
    this.onBreak?.(at, log.sliceRadius ? log.sliceRadius[Math.min(cut, NS - 1)] : log.radius * 0.3);
    return true;
  }

  private knock(log: Log, knock: Knock) {
    log.lastKnock = this.time;
    this.onKnock?.(knock);
  }

  // ---- Collision shapes -------------------------------------------------------------------

  /**
   * Convex pieces following the log's current surface, and the ring radii they came from. Given
   * the rings it had before, it only ever shrinks: burning wood doesn't grow back, and a shape
   * that flickered bigger would shove whatever rests on it.
   */
  private shape(log: Log, before: Float32Array | null = null): { shape: LogShape; rings: Float32Array } {
    const ringCount = 2 * PIECES + 1;
    const rings = new Float32Array(ringCount * HULL_ANGLES);
    const perBin = NT / HULL_ANGLES;
    for (let r = 0; r < ringCount; r++) {
      const b = (r / (ringCount - 1)) * NS; // position in slices
      const k0 = Math.min(Math.max(Math.floor(b - 0.5), 0), NS - 1);
      const k1 = Math.min(Math.max(Math.ceil(b - 0.5), 0), NS - 1);
      for (let j = 0; j < HULL_ANGLES; j++) {
        let most = 0;
        for (let t = j * perBin; t < (j + 1) * perBin; t++) {
          const theta = ((t + 0.5) / NT) * Math.PI * 2;
          most = Math.max(most, log.radii ? Math.max(log.radii[t * NS + k0], log.radii[t * NS + k1]) : outline(log, theta, (b / NS) * log.length) * 0.97);
        }
        rings[r * HULL_ANGLES + j] = before ? Math.min(most, before[r * HULL_ANGLES + j]) : most;
      }
    }
    const pieces: Float32Array[] = [];
    for (let p = 0; p < PIECES; p++) {
      const points = new Float32Array(3 * HULL_ANGLES * 3);
      let o = 0;
      for (let r = 2 * p; r <= 2 * p + 2; r++) {
        const x = (r / (ringCount - 1) - 0.5) * log.length;
        for (let j = 0; j < HULL_ANGLES; j++) {
          const theta = ((j + 0.5) / HULL_ANGLES) * Math.PI * 2;
          const radius = Math.max(rings[r * HULL_ANGLES + j] - 0.003, 0.004);
          points[o++] = x;
          points[o++] = radius * Math.cos(theta);
          points[o++] = radius * Math.sin(theta);
        }
      }
      pieces.push(points);
    }
    // Dry wood with some water left in it; charcoal is lighter.
    const density = log.wood.density * (1 + log.wood.moisture) * (1 - 0.6 * log.charFrac);
    return { shape: { pieces, density }, rings };
  }

  // ---- Walls and firelighters ---------------------------------------------------------------

  private updateWalls(dtLog: number) {
    // The firebox walls warm up over an evening of fires and cool slowly after. Round a
    // campfire only the stones and the ground nearby warm up, and less.
    const warmth = Math.min(0.6 * this.activity + 0.6 * smoothstep(0.05, 1, this.bed.totalMass), 1);
    const open = this.room.enclosure === 'open';
    const target = AMBIENT_TEMP + (open ? 100 : 280) * warmth;
    this.wallTemp += (target - this.wallTemp) * (1 - Math.exp(-dtLog / (open ? 900 : 1200)));
  }

  private updateLighters(frameDt: number, dtLog: number) {
    for (const l of this.lighters) {
      if (l.lit) {
        l.left = Math.max(0, l.left - dtLog);
        continue;
      }
      // A match held to it lights it after a moment.
      const top = add(l.pos, [0, LIGHTER.height, 0]);
      const near = this.match && length(sub(this.match, top)) < 0.035;
      l.heat = near ? l.heat + frameDt : Math.max(0, l.heat - frameDt);
      if (l.heat > 1) this.lightLighter(this.lighters.indexOf(l));
    }
  }

  // ---- GPU upload and readback ---------------------------------------------------------------

  private upload() {
    this.logData.fill(0);
    for (const log of this.logs) {
      if (!log) continue;
      const { centre, rot, vel, spin } = log.pose;
      const { axis, e1, e2 } = frame(rot);
      const a = sub(centre, scale(axis, log.length / 2));
      const o = log.slot * LOG_FLOATS;
      const w = log.wood;
      this.logData.set([a[0], a[1], a[2], 1], o);
      this.logData.set([...axis, log.length], o + 4);
      this.logData.set([...e1, log.radius * 1.12], o + 8);
      this.logData.set([...e2, log.radius], o + 12);
      this.logData.set([w.density, w.charYield, w.density * w.moisture, Math.max(log.meanRadius, 0.004)], o + 16);
      this.logData.set([...w.bark, log.seed], o + 20);
      this.logData.set([...vel, log.sOffset], o + 24);
      this.logData.set([...spin, w.crooked ?? 0], o + 28);
    }
    this.device.queue.writeBuffer(this.logBuffer, 0, this.logData);
  }

  private uploadBed() {
    this.device.queue.writeTexture({ texture: this.bedMap }, this.bed.mapData(), { bytesPerRow: BED_N * 8 }, [BED_N, BED_N]);
  }

  /** World position and outward normal of surface-map texel i (t * NS + k) of a log. */
  private texelPoint(log: Log, i: number, f = frame(log.pose.rot)): { pos: Vec3; normal: Vec3 } {
    const k = i % NS;
    const t = Math.floor(i / NS);
    const s = ((k + 0.5) / NS) * log.length;
    const theta = ((t + 0.5) / NT) * Math.PI * 2;
    const normal = add(scale(f.e1, Math.cos(theta)), scale(f.e2, Math.sin(theta)));
    const r = log.radii ? log.radii[i] : log.radius;
    return { pos: add(add(log.pose.centre, scale(f.axis, s - log.length / 2)), scale(normal, r)), normal };
  }

  private async readback() {
    this.reading = true;
    const layer = READBACK_ROW * NT * MAX;
    const buf = this.device.createBuffer({ size: 2 * layer, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder({ label: 'log readback' });
    enc.copyTextureToBuffer({ texture: this.geo }, { buffer: buf, bytesPerRow: READBACK_ROW, rowsPerImage: NT }, [NS, NT, MAX]);
    enc.copyTextureToBuffer({ texture: this.flux }, { buffer: buf, offset: layer, bytesPerRow: READBACK_ROW, rowsPerImage: NT }, [NS, NT, MAX]);
    this.device.queue.submit([enc.finish()]);
    // Only logs whose surface has been computed at least once are in this copy.
    const ids = this.logs.map((l) => (l && l.placedStep < this.steps ? l.id : -1));
    try {
      await buf.mapAsync(GPUMapMode.READ);
    } catch {
      this.reading = false;
      return;
    }
    const geo = new Uint16Array(buf.getMappedRange(0, layer));
    const flux = new Uint16Array(buf.getMappedRange(layer, layer));
    const rowHalves = READBACK_ROW / 2;
    const crumbled: Log[] = [];
    let glowTotal = 0;
    for (let slot = 0; slot < MAX; slot++) {
      const log = this.logs[slot];
      if (!log || log.id !== ids[slot]) continue;
      const radii = new Float32Array(NS * NT);
      const temps = new Float32Array(NS * NT);
      const chars = new Float32Array(NS * NT);
      const sliceRadius = new Float32Array(NS);
      const sliceChar = new Float32Array(NS);
      let covered = 0;
      let glow = 0;
      let maxT = 0;
      let gas = 0;
      let steam = 0;
      const ds = log.length / NS;
      for (let t = 0; t < NT; t++) {
        for (let k = 0; k < NS; k++) {
          const o = (slot * NT + t) * rowHalves + k * 4;
          const r = halfToFloat(geo[o]);
          const T = halfToFloat(geo[o + 1]);
          const c = halfToFloat(geo[o + 2]);
          const i = t * NS + k;
          radii[i] = r;
          temps[i] = T;
          chars[i] = c;
          sliceRadius[k] += r / NT;
          sliceChar[k] += c / NT;
          if (r > 0.1 * log.radius) covered++;
          maxT = Math.max(maxT, T);
          const area = r * ((2 * Math.PI) / NT) * ds;
          if (c > 0.6 && T > 750) glow += area;
          gas += Math.max(halfToFloat(flux[o]), 0) * area;
          steam += Math.max(halfToFloat(flux[o + 1]), 0) * area;
        }
      }
      let sum = 0;
      let charSum = 0;
      for (let k = 0; k < NS; k++) {
        sum += sliceRadius[k];
        charSum += sliceChar[k];
      }
      Object.assign(log, {
        radii,
        temps,
        chars,
        sliceRadius,
        sliceChar,
        meanRadius: sum / NS,
        charFrac: charSum / NS,
        glowArea: glow,
        maxTemp: maxT,
        gasRate: gas,
        steamRate: steam,
      });
      glowTotal += glow;
      // Burnt down to a thin, broken stick (or a stub): it collapses into the coal bed.
      if (log.meanRadius < 0.22 * log.radius || covered < 0.3 * NS * NT || (log.length < 0.08 && log.meanRadius < 0.45 * log.radius)) {
        crumbled.push(log);
      }
    }
    buf.unmap();
    buf.destroy();
    this.activity = Math.min(glowTotal / 0.08, 1);

    for (const log of crumbled) {
      const { axis } = frame(log.pose.rot);
      const half = scale(axis, log.length / 2);
      const kg = log.wood.charYield * log.wood.density * Math.PI * log.meanRadius ** 2 * log.length * 0.5;
      this.bed.collapse(sub(log.pose.centre, half), add(log.pose.centre, half), kg);
      this.remove(log);
      this.onCrumble?.(log.pose.centre, log.meanRadius * log.length);
    }
    this.heatTheBed();
    this.catchLighters();
    for (const log of this.live()) {
      if (log.id !== ids[log.slot]) continue;
      // Burnt through somewhere: it snaps there.
      if (this.breakWeakest(log, SNAP_RADIUS, null)) continue;
      // Follow its burnt-away shape.
      const prev = log.hullRings;
      const next = this.shape(log, prev);
      let change = prev ? 0 : Infinity;
      if (prev) for (let i = 0; i < prev.length; i++) change = Math.max(change, Math.abs(prev[i] - next.rings[i]));
      if (change > RESHAPE) {
        this.physics.setShape(log.id, next.shape);
        log.hullRings = next.rings;
      }
    }
    this.reading = false;
  }

  /**
   * What the coal bed gets from above: glowing char flaking off onto it right below where it
   * glows, and heat radiated down by the logs and the flames.
   */
  private heatTheBed() {
    const bed = this.bed;
    bed.deposit.fill(0);
    bed.heat.fill(0);
    const Ta4 = AMBIENT_TEMP ** 4;
    // Each log's surface in patches (8 along x 8 around): the power each sends downward, and
    // where it comes from.
    const GA = 8;
    const GT = 8;
    const emitters: number[] = []; // x, y, z, power
    for (const log of this.live()) {
      if (!log.radii || !log.temps || !log.chars) continue;
      const ds = log.length / NS;
      const f = frame(log.pose.rot);
      for (let ga = 0; ga < GA; ga++) {
        for (let gt = 0; gt < GT; gt++) {
          let p = 0, px = 0, py = 0, pz = 0;
          let shed = 0, sx = 0, sz = 0;
          for (let t = (gt * NT) / GT; t < ((gt + 1) * NT) / GT; t++) {
            for (let k = (ga * NS) / GA; k < ((ga + 1) * NS) / GA; k++) {
              const i = t * NS + k;
              const r = log.radii[i];
              if (r <= 0.002) continue;
              const T = log.temps[i];
              const area = r * ((2 * Math.PI) / NT) * ds;
              const hot = T > 450;
              const glowing = log.chars[i] > 0.6 && T > 750;
              if (!hot && !glowing) continue;
              const { pos, normal } = this.texelPoint(log, i, f);
              if (hot) {
                const down = Math.max(-normal[1], 0);
                const w = 0.9 * SIGMA * (T ** 4 - Ta4) * area * down;
                if (w > 0) {
                  p += w;
                  px += pos[0] * w;
                  py += pos[1] * w;
                  pz += pos[2] * w;
                }
              }
              if (glowing) {
                shed += area * CHAR_SHED;
                sx += pos[0] * area;
                sz += pos[2] * area;
              }
            }
          }
          if (p > 0) emitters.push(px / p, py / p, pz / p, p);
          if (shed > 0) bed.splat(bed.deposit, sx / (shed / CHAR_SHED), sz / (shed / CHAR_SHED), shed, 0.03);
        }
      }
    }
    // The flames radiate in every direction.
    const flames = this.flames;
    for (let j = 0; j < BED_N; j++) {
      for (let i = 0; i < BED_N; i++) {
        const [x, z] = bed.centre(i, j);
        let q = 0;
        for (let e = 0; e < emitters.length; e += 4) {
          const d = Math.max(emitters[e + 1] - BED_HEIGHT, 0.01);
          const s2 = d * d + (emitters[e] - x) ** 2 + (emitters[e + 2] - z) ** 2;
          q += (emitters[e + 3] * d * d) / (Math.PI * s2 * s2);
        }
        if (flames) {
          for (let b = 0; b < flames.length; b += 4) {
            const d = flames[b + 1] - BED_HEIGHT;
            if (d <= 0.005) continue;
            const s2 = d * d + (flames[b] - x) ** 2 + (flames[b + 2] - z) ** 2;
            q += (flames[b + 3] * d * this.flameGain) / (4 * Math.PI * s2 * Math.sqrt(s2));
          }
        }
        bed.heat[j * BED_N + i] = q;
      }
    }
  }

  /** A firelighter the fire has reached catches by itself. */
  private catchLighters() {
    for (let n = 0; n < this.lighters.length; n++) {
      const l = this.lighters[n];
      if (l.lit) continue;
      const top = add(l.pos, [0, LIGHTER.height, 0]);
      let hot = false;
      for (const log of this.live()) {
        if (!log.temps || hot) continue;
        if (length(sub(log.pose.centre, top)) > log.length / 2 + 0.1) continue;
        const f = frame(log.pose.rot);
        for (let i = 0; i < NS * NT && !hot; i += 3) {
          if (log.temps[i] > 800 && length(sub(this.texelPoint(log, i, f).pos, top)) < 0.05) hot = true;
        }
      }
      if (hot) this.lightLighter(n);
    }
  }

  /** Detailed per-log numbers read back from the GPU (for tuning). */
  async inspect() {
    const read = async (src: GPUBuffer, size: number) => {
      const copy = this.device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(src, 0, copy, 0, size);
      this.device.queue.submit([enc.finish()]);
      await copy.mapAsync(GPUMapMode.READ);
      const data = new Float32Array(copy.getMappedRange().slice(0));
      copy.destroy();
      return data;
    };
    const state = await read(this.state[this.parity], MAX * VOXELS * 16);
    const surf = await read(this.surf, MAX * NS * NT * 16);
    const out = [];
    for (const log of this.live()) {
      const half = log.radius * 1.12;
      const dx = (2 * half) / NX;
      const vol = dx * dx * (log.length / NS);
      let wood = 0, char = 0, water = 0, tMax = 0, tSum = 0, n = 0;
      for (let v = 0; v < VOXELS; v++) {
        const o = (log.slot * VOXELS + v) * 4;
        const [T, M, W, C] = [state[o], state[o + 1], state[o + 2], state[o + 3]];
        if (W + C <= 1) continue;
        wood += W * vol;
        char += C * vol;
        water += M * vol;
        tMax = Math.max(tMax, T);
        tSum += T;
        n++;
      }
      let qSum = 0, burn = 0, tsMax = 0, tsSum = 0;
      for (let k = 0; k < NS; k++) {
        for (let t = 0; t < NT; t++) {
          const col = (log.slot * NS + k) * NT + t;
          const r = log.radii ? log.radii[t * NS + k] : log.radius;
          const area = Math.max(r, 1e-3) * ((2 * Math.PI) / NT) * (log.length / NS);
          qSum += surf[col * 4];
          burn += surf[col * 4 + 2] * area;
          tsMax = Math.max(tsMax, surf[col * 4 + 3]);
          tsSum += surf[col * 4 + 3];
        }
      }
      const cols = NS * NT;
      const minSlice = log.sliceRadius ? Math.min(...log.sliceRadius) : log.radius;
      // How far along the log (from end A, 0..1) its surface is burning: slices over 600 K.
      let burning = 0;
      if (log.temps) {
        for (let k = 0; k < NS; k++) {
          let hot = 0;
          for (let t = 0; t < NT; t++) if (log.temps[t * NS + k] > 600) hot++;
          if (hot > NT / 4) burning++;
        }
      }
      out.push({
        slot: log.slot,
        id: log.id,
        wood: log.wood.label,
        length: round(log.length, 3),
        centre: log.pose.centre.map((v) => round(v, 3)),
        speed: round(length(log.pose.vel), 3),
        woodKg: round(wood, 3),
        charKg: round(char, 3),
        waterKg: round(water, 3),
        meanT: round(tSum / Math.max(n, 1), 0),
        maxT: round(tMax, 0),
        surfaceMeanT: round(tsSum / cols, 0),
        surfaceMaxT: round(tsMax, 0),
        burningShare: round(burning / NS, 2),
        meanHeatIn_kWm2: round(qSum / cols / 1000, 2),
        woodGas_gps: round(log.gasRate * 1000, 3),
        steam_gps: round(log.steamRate * 1000, 3),
        charBurn_gps: round(burn * 1000, 3),
        meanRadius: round(log.meanRadius, 4),
        thinnest: round(minSlice / log.radius, 2),
        charFrac: round(log.charFrac, 2),
        mass: round(this.physics.mass(log.id), 3),
      });
    }
    return {
      bedMass: round(this.bed.totalMass, 3),
      bedGlowTemp: this.bed.glowTemp === null ? null : round(this.bed.glowTemp, 0),
      wallTemp: round(this.wallTemp, 0),
      lighters: this.lighters.map((l) => ({ lit: l.lit, left: round(l.left, 0) })),
      logs: out,
    };
  }

  /** The bed in a few rows (for tuning): coal kg/m2 / K / ash cover. */
  bedProfile() {
    const rows = [];
    const bed = this.bed;
    for (let j = 2; j < BED_N; j += 6) {
      const row = [];
      for (let i = 1; i < BED_N; i += 4) {
        const k = j * BED_N + i;
        row.push(`${round(bed.mass[k] / (((bed.rect.maxX - bed.rect.minX) / BED_N) * ((bed.rect.maxZ - bed.rect.minZ) / BED_N)), 1)}/${round(bed.temp[k], 0)}/${round(bed.ash[k], 2)}`);
      }
      rows.push(row.join(' '));
    }
    return rows;
  }
}

// ---- Helpers -----------------------------------------------------------------------------------

function frame(rot: Quat) {
  return { axis: quatRotate(rot, [1, 0, 0]), e1: quatRotate(rot, [0, 1, 0]), e2: quatRotate(rot, [0, 0, 1]) };
}

/** Orientation of a log along `axis` with its cross-section axis e1 level. */
export function levelFrame(axis: Vec3): Quat {
  let e1 = cross(axis, [0, 1, 0]);
  if (length(e1) < 1e-3) e1 = cross(axis, [1, 0, 0]);
  e1 = normalize(e1);
  return quatFromBasis(axis, e1, cross(axis, e1));
}

/** Distance between two segments seen from above (in x and z). */
function segmentDistanceXZ(a: Vec3, b: Vec3, c: Vec3, d: Vec3): number {
  const p = (v: Vec3): [number, number] => [v[0], v[2]];
  const [A, B, C, D] = [p(a), p(b), p(c), p(d)];
  const cross2 = (o: [number, number], u: [number, number], v: [number, number]) => (u[0] - o[0]) * (v[1] - o[1]) - (u[1] - o[1]) * (v[0] - o[0]);
  // Crossing segments touch.
  if (cross2(A, B, C) * cross2(A, B, D) < 0 && cross2(C, D, A) * cross2(C, D, B) < 0) return 0;
  const toSeg = (q: [number, number], s0: [number, number], s1: [number, number]) => {
    const ux = s1[0] - s0[0];
    const uz = s1[1] - s0[1];
    const t = Math.min(Math.max(((q[0] - s0[0]) * ux + (q[1] - s0[1]) * uz) / (ux * ux + uz * uz || 1), 0), 1);
    return Math.hypot(q[0] - s0[0] - ux * t, q[1] - s0[1] - uz * t);
  };
  return Math.min(toSeg(A, C, D), toSeg(B, C, D), toSeg(C, A, B), toSeg(D, A, B));
}

function splitParams(slot: number, from: number, to: number): ArrayBuffer {
  const data = new ArrayBuffer(16);
  new Uint32Array(data)[0] = slot;
  new Float32Array(data).set([from, to, 0], 1);
  return data;
}

/** Stretches slices [from, to) of a surface map (t-major, NS per row) over a whole map. */
function resampleMap(src: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(NS * NT);
  for (let t = 0; t < NT; t++) out.set(resampleSlices(src.subarray(t * NS, (t + 1) * NS), from, to), t * NS);
  return out;
}

function resampleSlices(src: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(NS);
  for (let k = 0; k < NS; k++) {
    const s = from + ((k + 0.5) * (to - from)) / NS - 0.5;
    const lo = Math.min(Math.max(Math.floor(s), from), to - 1);
    const hi = Math.min(lo + 1, to - 1);
    const f = Math.min(Math.max(s - lo, 0), 1);
    out[k] = src[lo] * (1 - f) + src[hi] * f;
  }
  return out;
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}

function round(v: number, digits: number) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/**
 * Radius of a log's cross-section at angle theta, s along it: a round log, not quite round; or
 * a stick of split kindling, square-ish with rounded corners (so it does not roll).
 */
function outline(log: Log, theta: number, s: number): number {
  const seed = log.seed;
  const wobble =
    0.02 * Math.sin(((2 * Math.PI * s) / log.length) * 1.3 + seed) + 0.012 * Math.sin(17 * theta + 3 * seed);
  if (log.wood.crooked) {
    // A dead branch: knobbly, thicker at old side shoots and scars.
    const knots = 0.08 * Math.max(0, Math.sin(((2 * Math.PI * s) / log.length) * 3.1 + seed * 2.3)) ** 3 + 0.04 * Math.sin(3 * theta + seed * 1.7);
    return log.radius * (1 + 0.06 * Math.cos(2 * theta + seed) + knots + wobble);
  }
  if (log.woodKey === 'kindling') {
    const a = theta + seed;
    const p = 3.5;
    const square = (Math.abs(Math.cos(a)) ** p + Math.abs(Math.sin(a)) ** p) ** (-1 / p);
    return log.radius * 0.9 * (square * (1 + 0.06 * Math.sin(2 * a + seed)) + wobble);
  }
  // A little oval (flatter top and bottom as laid), so it lies still rather than rolling at a touch.
  return log.radius * (1 + 0.05 * Math.cos(2 * theta) + 0.025 * Math.sin(3 * theta + seed) + 0.015 * Math.sin(5 * theta + 2.1 * seed) + wobble);
}

/**
 * Initial interior of a log. A fresh log is room temperature, damp to its wood's moisture
 * content. A pre-burnt one (preburn 1 = about a quarter hour in the fire) has a char layer, a
 * zone where wood is turning to char, a dried zone and a still-damp core.
 */
function buildVoxels(log: Log, preburn: number): Float32Array {
  const out = new Float32Array(VOXELS * 4);
  const half = log.radius * 1.12;
  const dx = (2 * half) / NX;
  const ds = log.length / NS;
  const w = log.wood;
  const W0 = w.density;
  const M0 = w.density * w.moisture;
  const shape = (theta: number, s: number) => outline(log, theta, s);

  const charDepth = 0.01 * preburn;
  const pyroDepth = 0.004 * preburn;
  const dryDepth = 0.01 * preburn;

  for (let k = 0; k < NS; k++) {
    const s = (k + 0.5) * ds;
    for (let j = 0; j < NX; j++) {
      for (let i = 0; i < NX; i++) {
        let fill = 0;
        for (const oy of [0.25, 0.75]) {
          for (const ox of [0.25, 0.75]) {
            const x = (i + ox) * dx - half;
            const y = (j + oy) * dx - half;
            if (Math.hypot(x, y) < shape(Math.atan2(y, x), s)) fill += 0.25;
          }
        }
        if (fill <= 0) continue;
        const x = (i + 0.5) * dx - half;
        const y = (j + 0.5) * dx - half;
        const depth = Math.max(0, Math.min(shape(Math.atan2(y, x), s) - Math.hypot(x, y), s, log.length - s));

        let T = 293;
        let M = M0;
        let W = W0;
        let C = 0;
        if (preburn > 0) {
          if (depth < charDepth) {
            W = 0;
            C = w.charYield * W0;
            M = 0;
            T = 950 - (280 * depth) / charDepth;
          } else if (depth < charDepth + pyroDepth) {
            const f = (depth - charDepth) / pyroDepth;
            W = W0 * f;
            C = w.charYield * W0 * (1 - f);
            M = 0;
            T = 670 - 170 * f;
          } else if (depth < charDepth + pyroDepth + dryDepth) {
            M = 0;
            T = 500 - (127 * (depth - charDepth - pyroDepth)) / dryDepth;
          } else {
            T = Math.max(300, 373 - ((depth - charDepth - pyroDepth - dryDepth) / 0.01) * 73);
          }
        }
        out.set([T, M * fill, W * fill, C * fill], (i + NX * (j + NX * k)) * 4);
      }
    }
  }
  return out;
}

interface Stage {
  run(pass: GPUComputePassEncoder): void;
}

function makeStage(device: GPUDevice, label: string, code: string, resources: GPUBindingResource[], groups: number[]): Stage {
  const module = device.createShaderModule({ label, code });
  const pipeline = device.createComputePipeline({ label, layout: 'auto', compute: { module, entryPoint: 'main' } });
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
