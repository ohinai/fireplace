import frameSrc from './shaders/frame.wgsl?raw';
import commonSrc from './shaders/common.wgsl?raw';
import sparkCommonSrc from './shaders/spark_common.wgsl?raw';
import sparkUpdateSrc from './shaders/spark_update.wgsl?raw';
import sparkDrawSrc from './shaders/spark_draw.wgsl?raw';
import logsSharedSrc from '../sim/shaders/logs_shared.wgsl?raw';

import type { Vec3 } from '../math';
import type { FireSim } from '../sim/FireSim';
import type { LogSystem } from '../sim/LogSystem';

const COUNT = 2048;
const PARAMS_SIZE = 128;

/** Sparks thrown up by the fire, simulated and drawn on the GPU. */
export class Sparks {
  private readonly buffer: GPUBuffer;
  private readonly paramsBuf: GPUBuffer;
  private readonly params = new ArrayBuffer(PARAMS_SIZE);
  private readonly updatePipeline: GPUComputePipeline;
  readonly drawPipeline: GPURenderPipeline;
  private updateGroup: GPUBindGroup | null = null;
  private drawGroup: GPUBindGroup | null = null;
  private burstStart = 0;
  private pending: { pos: Vec3; radius: number; vel: Vec3; spread: number; count: number } | null = null;
  private frame = 0;
  private sim: FireSim | null = null;

  constructor(
    private readonly device: GPUDevice,
    private readonly logs: LogSystem,
    private readonly frameBuf: GPUBuffer,
    private readonly bbBuf: GPUBuffer,
    hdrFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
  ) {
    this.buffer = device.createBuffer({ label: 'sparks', size: COUNT * 32, usage: GPUBufferUsage.STORAGE });
    this.paramsBuf = device.createBuffer({ label: 'spark params', size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    this.updatePipeline = device.createComputePipeline({
      label: 'sparks update',
      layout: 'auto',
      compute: { module: device.createShaderModule({ label: 'sparks update', code: logsSharedSrc + sparkCommonSrc + sparkUpdateSrc }), entryPoint: 'main' },
    });
    const drawModule = device.createShaderModule({ label: 'sparks draw', code: frameSrc + commonSrc + sparkCommonSrc + sparkDrawSrc });
    this.drawPipeline = device.createRenderPipeline({
      label: 'sparks draw',
      layout: 'auto',
      vertex: { module: drawModule, entryPoint: 'vs' },
      fragment: {
        module: drawModule,
        entryPoint: 'fs',
        targets: [
          {
            format: hdrFormat,
            blend: {
              color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
              alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
            },
          },
        ],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.drawGroup = device.createBindGroup({
      label: 'sparks draw',
      layout: this.drawPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.buffer } },
        { binding: 2, resource: { buffer: this.bbBuf } },
      ],
    });
  }

  setSim(sim: FireSim) {
    this.sim = sim;
    this.updateGroup = this.device.createBindGroup({
      label: 'sparks update',
      layout: this.updatePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.paramsBuf } },
        { binding: 1, resource: { buffer: this.buffer } },
        { binding: 2, resource: { buffer: this.logs.logBuffer } },
        { binding: 3, resource: this.logs.geo.createView({ dimension: '2d-array' }) },
        { binding: 4, resource: this.logs.mapSampler },
        { binding: 5, resource: sim.velocity.createView() },
        { binding: 6, resource: this.device.createSampler({ magFilter: 'linear', minFilter: 'linear' }) },
      ],
    });
  }

  /** Throws a handful of sparks from around pos (m), moving at vel ± spread (m/s). */
  burst(pos: Vec3, count: number, vel: Vec3 = [0, 1.2, 0], spread = 1.2, radius = 0.04) {
    this.pending = { pos, radius, vel, spread, count: Math.min(count, 256) };
  }

  update(pass: GPUComputePassEncoder, dt: number, rate: number, gravity = 9.81) {
    const sim = this.sim;
    if (!sim || !this.updateGroup) return;
    const f = new Float32Array(this.params);
    const u = new Uint32Array(this.params);
    f[0] = dt;
    f[1] = rate;
    u[2] = COUNT;
    u[3] = this.frame++;
    const b = this.pending;
    f.set(b ? [...b.pos, b.radius] : [0, 0, 0, 0], 4);
    f.set(b ? [...b.vel, b.spread] : [0, 0, 0, 0], 8);
    u[12] = this.burstStart;
    u[13] = b ? b.count : 0;
    if (b) this.burstStart = (this.burstStart + b.count) % COUNT;
    this.pending = null;
    f.set(sim.origin, 16);
    f[19] = sim.h;
    f.set(sim.dims, 20);
    // Sparks go up the chimney, or rise high into the night over a campfire.
    const open = this.logs.room.enclosure === 'open';
    f.set(open ? [-2.5, 0, -2.5, gravity] : [-0.45, 0, -0.42, gravity], 24);
    f.set(open ? [2.5, 3.5, 2.5, 0] : [0.45, 0.95, 0.35, 0], 28);
    this.device.queue.writeBuffer(this.paramsBuf, 0, this.params);
    pass.setPipeline(this.updatePipeline);
    pass.setBindGroup(0, this.updateGroup);
    pass.dispatchWorkgroups(Math.ceil(COUNT / 64));
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.drawGroup) return;
    pass.setPipeline(this.drawPipeline);
    pass.setBindGroup(0, this.drawGroup);
    pass.draw(6, COUNT);
  }
}
