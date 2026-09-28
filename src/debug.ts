import type { FireAudio } from './audio';
import type { Camera } from './camera';
import type { CameraView } from './rooms';
import type { Detail } from './config';
import type { Critters } from './critters';
import type { Params } from './config';
import type { FireMode } from './layouts';
import type { Lighting, Renderer } from './render/Renderer';
import type { RoomKey } from './rooms';
import type { Blow, FireSim } from './sim/FireSim';
import type { LogSystem } from './sim/LogSystem';
import type { Tools } from './tools';
import type { Kettle } from './sim/Kettle';

interface DebugHooks {
  device: GPUDevice;
  getSim: () => FireSim;
  logs: LogSystem;
  tools: Tools;
  audio: FireAudio;
  critters: Critters;
  params: Params;
  dt: number;
  startOver: () => void;
  stepWorld: (dt: number, blow?: Blow | null) => void;
  render: () => void;
  renderer: Renderer;
  camera: Camera;
  adaptation: () => Promise<[number, number]>;
  setRoom: (key: RoomKey) => void;
  setMode: (mode: FireMode) => void;
  setLighting: (l: Partial<Lighting>) => void;
  setDetail: (detail: Detail) => void;
  kettle: () => Kettle | null;
  stepKettle: (dt: number) => void;
}

/**
 * Exposes `window.fire` for tuning from the browser console:
 *   fire.params                 live simulation / look parameters
 *   await fire.stats()          summary statistics and height profiles of the gas
 *   await fire.logs()           per-log masses, temperatures and gas output
 *   await fire.advance(secs)    runs the solver (and logs) without waiting for display frames
 *   fire.addLog('oak')          drops a log on the fire
 *   fire.tools                  the tongs / poker / blowing / match (down, move, up at screen coordinates)
 *   fire.setRoom('campfire'), fire.setMode('cold'), fire.light(0), fire.bed()
 *   fire.embers()               skips ahead to a bed of ashy embers, the flames gone
 *   fire.critters               the night's fireflies, moths, bats and eyes
 *   fire.system                 the log system itself, for poking at its GPU buffers
 *   fire.renderer               the renderer itself (what it keeps of the still scene...)
 *   fire.look({ target, distance, yaw, pitch }), fire.view('chair')   points the camera and draws a frame
 *   fire.setDetail('high')      how much furniture and scenery there is
 */
export function installDebug(h: DebugHooks) {
  const { device, getSim, logs, params, dt } = h;
  (window as unknown as { fire: unknown }).fire = {
    params,
    startOver: h.startOver,
    render: h.render,
    renderer: h.renderer,
    camera: h.camera,
    tools: h.tools,
    audio: h.audio,
    critters: h.critters,
    system: logs,
    physics: logs.physics,
    adaptation: h.adaptation,
    setRoom: h.setRoom,
    setMode: h.setMode,
    setLighting: h.setLighting,
    setDetail: h.setDetail,
    kettle: h.kettle,
    stepKettle: h.stepKettle,
    look: (v: Partial<CameraView>) => {
      h.camera.setView({ key: 'debug', label: 'debug', kind: 'orbit', target: [0, 0.3, 0], distance: 1, yaw: 0, pitch: 0.2, ...v }, false);
      h.camera.update(innerWidth / innerHeight, 0);
      h.render();
    },
    view: (key: string) => {
      const v = logs.room.views.find((view) => view.key === key);
      if (!v) return;
      h.camera.setView(v, false);
      h.camera.update(innerWidth / innerHeight, 0);
      h.render();
    },
    stats: () => fieldStats(getSim()),
    sim: getSim,
    /**
     * A vertical slice through the gas at depth z (m): one channel (0 T, 1 fuel, 2 O2, 3 soot)
     * as rows of numbers, top row highest, every `step` cells, up to height `top` (m).
     */
    async slice(z: number, channel = 0, step = 2, top = 0.3) {
      const sim = getSim();
      const { scal } = await sim.readFields();
      const [nx, ny] = sim.dims;
      const k = Math.round((z - sim.origin[2]) / sim.h - 0.5);
      const rows = [];
      for (let j = Math.min(Math.round(top / sim.h), ny - 1); j >= 0; j -= step) {
        const row = [];
        for (let i = 0; i < nx; i += step) row.push(scal[(i + nx * (j + ny * k)) * 4 + channel]);
        rows.push(`${((j + 0.5) * sim.h).toFixed(3)} ` + row.map((v) => (channel === 0 ? String(Math.round(v / 10)).padStart(3) : v.toFixed(2).padStart(5))).join(''));
      }
      return rows.join('\n');
    },
    logs: () => logs.inspect(),
    bed: () => logs.bedProfile(),
    light: (i = 0) => logs.lightLighter(i),
    embers: () => logs.emberStage(),
    addLog: (wood = 'oak') => logs.addLog(wood),
    breakLog: (slot: number, at = 0.5) => logs.breakLog(slot, at),
    /** Runs everything for a while; `blow` overrides the pointer's blowing for the whole run. */
    async advance(seconds: number, blow?: Blow) {
      const steps = Math.round(seconds / dt);
      for (let i = 0; i < steps; i++) {
        if (blow && blow.pos[1] < 0.3) logs.blowOnCoals(blow.strength, blow.pos);
        if (i % 6 === 0) getSim().sampleFlamePower();
        h.tools.frame(dt);
        logs.update(dt, params);
        logs.prepare(params, dt);
        h.stepWorld(dt, blow);
        if (i % 20 === 19) await device.queue.onSubmittedWorkDone();
      }
      await device.queue.onSubmittedWorkDone();
      return getSim().time;
    },
  };
}

async function fieldStats(sim: FireSim) {
  const { vel, scal, solid, smoke, radiation, expand, pressure } = await sim.readFields();
  let pMax = 0, pMaxAt = [0, 0, 0];
  for (let i = 0; i < pressure.length; i++) {
    if (!solid[i] && Math.abs(pressure[i]) > pMax) {
      pMax = Math.abs(pressure[i]);
      const [nx0, ny0] = sim.dims;
      pMaxAt = [i % nx0, Math.floor(i / nx0) % ny0, Math.floor(i / (nx0 * ny0))];
    }
  }
  let expandTotal = 0, expandMax = 0;
  for (const e of expand) {
    expandTotal += e * sim.h * sim.h;
    expandMax = Math.max(expandMax, e);
  }
  let radiated = 0;
  for (let b = 0; b < radiation.length / 4; b++) radiated += radiation[b * 4 + 3];
  const smokeOnly = new Float32Array(smoke.length / 4);
  for (let i = 0; i < smokeOnly.length; i++) smokeOnly[i] = smoke[i * 4];
  const [nx, ny, nz] = sim.dims;
  const n = nx * ny * nz;
  const h = sim.h;
  // Staggered velocity: texel (i, j, k) of an (nx+1)(ny+1)(nz+1) grid holds the min faces of cell (i, j, k).
  const vi = (x: number, y: number, z: number) => x + (nx + 1) * (y + (ny + 1) * z);
  const U = (x: number, y: number, z: number) => vel[vi(x, y, z) * 4];
  const V = (x: number, y: number, z: number) => vel[vi(x, y, z) * 4 + 1];
  const W = (x: number, y: number, z: number) => vel[vi(x, y, z) * 4 + 2];
  const ci = (x: number, y: number, z: number) => x + nx * (y + ny * z);

  const speed = new Float32Array(n);
  const vyCell = new Float32Array(n);
  const T = new Float32Array(n);
  const fuel = new Float32Array(n);
  const ox = new Float32Array(n);
  const soot = new Float32Array(n);
  let nans = 0, divAbs = 0, divMax = 0, fluidCells = 0;
  let fastest = { speed: 0, at: [0, 0, 0] as number[], T: 0, solidNear: 0 };
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = ci(x, y, z);
        const u = 0.5 * (U(x, y, z) + U(x + 1, y, z));
        const v = 0.5 * (V(x, y, z) + V(x, y + 1, z));
        const w = 0.5 * (W(x, y, z) + W(x, y, z + 1));
        speed[i] = Math.hypot(u, v, w);
        vyCell[i] = v;
        if (speed[i] > fastest.speed) {
          let near = 0;
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
            const q = x + dx + nx * (y + dy + ny * (z + dz));
            if (x + dx >= 0 && x + dx < nx && y + dy >= 0 && y + dy < ny && z + dz >= 0 && z + dz < nz && solid[q]) near++;
          }
          fastest = { speed: speed[i], at: [round(sim.origin[0] + (x + 0.5) * h), round((y + 0.5) * h), round(sim.origin[2] + (z + 0.5) * h)], T: scal[i * 4], solidNear: near };
        }
        T[i] = scal[i * 4];
        fuel[i] = scal[i * 4 + 1];
        ox[i] = scal[i * 4 + 2];
        soot[i] = scal[i * 4 + 3];
        if (Number.isNaN(speed[i] + T[i] + fuel[i] + ox[i] + soot[i])) nans++;
        if (!solid[i]) {
          const d = U(x + 1, y, z) - U(x, y, z) + V(x, y + 1, z) - V(x, y, z) + W(x, y, z + 1) - W(x, y, z);
          divAbs += Math.abs(d);
          divMax = Math.max(divMax, Math.abs(d));
          fluidCells++;
        }
      }
    }
  }

  const summary = (a: Float32Array) => {
    const s = Float32Array.from(a).sort();
    const q = (p: number) => round(s[Math.min(s.length - 1, Math.floor(p * s.length))]);
    let sum = 0;
    for (const v of a) sum += v;
    return { min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), p99: q(0.99), max: q(1), mean: round(sum / a.length) };
  };

  // Flow through the flue (top faces) and the opening (front faces); heat carried up the flue
  // (rho * cp of air ~ 1200 J/m3K at room temperature; hot gas is lighter in proportion).
  const area = h * h;
  const rhoCp = (t: number) => (1200 * 300) / Math.max(t, 300);
  let flueFlow = 0, fluePower = 0, roomIn = 0, roomOut = 0, roomOutPower = 0;
  for (let z = 0; z < nz; z++) {
    for (let x = 0; x < nx; x++) {
      const v = V(x, ny, z);
      const t = T[ci(x, ny - 1, z)];
      flueFlow += v * area;
      fluePower += v * area * rhoCp(t) * (t - 300);
    }
  }
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      const w = W(x, y, nz);
      if (w > 0) {
        roomOut += w * area;
        roomOutPower += w * area * rhoCp(T[ci(x, y, nz - 1)]) * (T[ci(x, y, nz - 1)] - 300);
      } else {
        roomIn -= w * area;
      }
    }
  }

  // Horizontal averages at a few heights.
  const rows = [];
  for (let y = 2; y < ny; y += Math.floor(ny / 9)) {
    let t = 0, sp = 0, vy = 0, o = 0, f = 0, so = 0;
    for (let z = 0; z < nz; z++) {
      for (let x = 0; x < nx; x++) {
        const i = ci(x, y, z);
        t += T[i]; sp += speed[i]; vy += vyCell[i]; o += ox[i]; f += fuel[i]; so += soot[i];
      }
    }
    const c = nx * nz;
    rows.push({ y: round((y + 0.5) * h), T: round(t / c), speed: round(sp / c), vy: round(vy / c), O2: round(o / c), fuel: round(f / c), soot: round(so / c) });
  }

  // Temperature across the width and from back to front at 30 cm height.
  const yMid = Math.floor(0.3 / h);
  const band = (bins: number, count: number, cell: (b: number, j: number) => number[]) => {
    const out = [];
    for (let b = 0; b < bins; b++) {
      let t = 0, c = 0;
      for (let j = 0; j < count; j++) {
        for (const i of cell(b, j)) { t += T[i]; c++; }
      }
      out.push(round(t / c));
    }
    return out;
  };
  const across = band(8, nz, (b, z) => {
    const r = [];
    for (let x = Math.floor((b * nx) / 8); x < Math.floor(((b + 1) * nx) / 8); x++) r.push(ci(x, yMid, z));
    return r;
  });
  const depth = band(6, nx, (b, x) => {
    const r = [];
    for (let z = Math.floor((b * nz) / 6); z < Math.floor(((b + 1) * nz) / 6); z++) r.push(ci(x, yMid, z));
    return r;
  });

  return {
    time: round(sim.time),
    nans,
    fastest,
    pressureMax: round(pMax),
    pressureMaxAtCell: pMaxAt,
    released_m3s: round(expandTotal),
    released_max: round(expandMax),
    div_mean_abs: round(divAbs / fluidCells),
    div_max: round(divMax),
    flue_m3s: round(flueFlow),
    flue_kW: round(fluePower / 1000),
    opening_in_m3s: round(roomIn),
    opening_out_m3s: round(roomOut),
    opening_out_kW: round(roomOutPower / 1000),
    radiated_kW: round(radiated / 1000),
    smoke: summary(smokeOnly),
    speed: summary(speed),
    T: summary(T),
    fuel: summary(fuel),
    O2: summary(ox),
    soot: summary(soot),
    rows,
    T_acrossX_at30cm: across,
    T_backToFront_at30cm: depth,
  };
}

function round(v: number) {
  return Math.round(v * 1000) / 1000;
}
