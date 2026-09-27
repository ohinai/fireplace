import frameSrc from './shaders/frame.wgsl?raw';
import steamSrc from './shaders/steam.wgsl?raw';

import { add, scale, type Vec3 } from '../math';

const MAX = 192;

interface Puff {
  pos: Vec3;
  vel: Vec3;
  age: number;
  life: number;
  size: number;
}

/**
 * Steam from a kettle's spout: puffs that leave it fast, slow as they rise, swell and thin out
 * into the night air, drifting with the breeze. Simulated on the CPU (there are few), drawn as
 * soft billboards over the picture.
 */
export class Steam {
  private readonly pipeline: GPURenderPipeline;
  private readonly group: GPUBindGroup;
  private readonly buffer: GPUBuffer;
  private readonly data = new Float32Array(MAX * 8);
  private puffs: Puff[] = [];
  private owed = 0;
  private count = 0;
  private time = 0;
  /** How strongly the warm steam rises (1 under Earth's gravity; less where it is weaker). */
  lift = 1;

  constructor(
    private readonly device: GPUDevice,
    frameBuf: GPUBuffer,
    hdrFormat: GPUTextureFormat,
    depthFormat: GPUTextureFormat,
  ) {
    this.buffer = device.createBuffer({ label: 'steam', size: this.data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    const module = device.createShaderModule({ label: 'steam', code: frameSrc + steamSrc });
    this.pipeline = device.createRenderPipeline({
      label: 'steam',
      layout: 'auto',
      vertex: {
        module,
        entryPoint: 'vs',
        buffers: [{ arrayStride: 32, stepMode: 'instance', attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }, { shaderLocation: 1, offset: 16, format: 'float32x4' }] }],
      },
      fragment: {
        module,
        entryPoint: 'fs',
        targets: [{
          format: hdrFormat,
          blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } },
        }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: { format: depthFormat, depthWriteEnabled: false, depthCompare: 'less' },
    });
    this.group = device.createBindGroup({ label: 'steam', layout: this.pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: frameBuf } }] });
  }

  /**
   * Moves the steam on by dt. `from`: where it leaves (and which way, how fast), `rate`: puffs
   * a second (0: none now); `wind`: the breeze; `light(p)`: the light falling on a puff at p.
   */
  update(dt: number, from: { pos: Vec3; dir: Vec3 } | null, rate: number, wind: Vec3, light: (p: Vec3) => Vec3) {
    this.time += dt;
    if (from && rate > 0) {
      this.owed += rate * dt;
      while (this.owed >= 1 && this.puffs.length < MAX) {
        this.owed -= 1;
        const jitter: Vec3 = [(Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12];
        this.puffs.push({ pos: [...from.pos], vel: add(scale(add(from.dir, jitter), 0.3 + 0.5 * Math.min(rate / 25, 1)), [0, 0.08, 0]), age: 0, life: 0.7 + Math.random() * 1.3, size: 0.008 + Math.random() * 0.006 });
      }
    } else {
      this.owed = 0;
    }
    const k = Math.exp(-dt * 2.2);
    for (const p of this.puffs) {
      p.age += dt;
      // Warm and light, it rises; the air slows it and carries it off; it swells as it mixes.
      const swirl: Vec3 = [Math.sin(this.time * 2.1 + p.life * 9) * 0.05, 0, Math.cos(this.time * 1.7 + p.life * 7) * 0.05];
      p.vel = add(scale(p.vel, k), scale(add(add(wind, swirl), [0, 0.35 * this.lift * (1 - p.age / p.life), 0]), 1 - k));
      p.pos = add(p.pos, scale(p.vel, dt));
      p.size += dt * 0.045;
    }
    this.puffs = this.puffs.filter((p) => p.age < p.life);
    this.count = this.puffs.length;
    this.puffs.forEach((p, i) => {
      const t = p.age / p.life;
      const alpha = 0.16 * Math.min(1, p.age / 0.1) * (1 - t) * (1 - t);
      const c = light(p.pos);
      this.data.set([p.pos[0], p.pos[1], p.pos[2], p.size, c[0], c[1], c[2], alpha], i * 8);
    });
    if (this.count) this.device.queue.writeBuffer(this.buffer, 0, this.data, 0, this.count * 8);
  }

  clear() {
    this.puffs = [];
    this.count = 0;
  }

  draw(pass: GPURenderPassEncoder) {
    if (!this.count) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.group);
    pass.setVertexBuffer(0, this.buffer);
    pass.draw(6, this.count);
  }
}
