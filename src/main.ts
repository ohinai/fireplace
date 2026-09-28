import './style.css';
import { FireAudio } from './audio';
import { Camera } from './camera';
import { DEFAULT_PARAMS, DETAILS, QUALITY, SIM_DT, WOODS, type Detail, type Params } from './config';
import { installDebug } from './debug';
import type { FireMode } from './layouts';
import { add, dot, normalize, project, scale, sub, type Vec3 } from './math';
import { Renderer, type Lighting } from './render/Renderer';
import { fireCentre, ROOMS, type RoomKey } from './rooms';
import { FireSim, type Blow } from './sim/FireSim';
import { LogPhysics } from './sim/LogPhysics';
import { LogSystem } from './sim/LogSystem';
import { Tools, type ToolName } from './tools';
import { Critters } from './critters';
import { countEvent } from './stats';
import { createUI, MOISTURE_VIEW, SCIENCE_SLIDERS, SLIDERS, TOUCH, type SkySettings, type SoundSettings } from './ui';
import starsUrl from './sky/stars.bin?url';
import { parseStars } from './sky/stars';
import { Kettle } from './sim/Kettle';
import { kettleVents } from './render/desert';
import { groundHeight } from './render/campfire';

const MAX_LOGS_ADDED = 20; // how many logs (and sticks, and pieces of broken ones) there can be on the fire
const FLAME_REF = 14000; // W the flames of a healthy fire radiate (for the sound)
const COLD_HINT = 'The fire is laid but not lit: take the match (4) and hold it to a firelighter, tucked under the logs at either end';

function showMessage(html: string) {
  document.getElementById('loading')!.hidden = true;
  const el = document.getElementById('message')!;
  // (Shown first, then filled, so that screen readers read it out; in one block, so that the
  // centring grid lays it out as one paragraph rather than each run of text on its own.)
  el.hidden = false;
  el.innerHTML = `<div>${html}</div>`;
}

const NO_WEBGPU =
  'This fireplace needs <b>WebGPU</b>, which this browser doesn’t have (or has turned off).<br>' +
  'It runs in recent Chrome and Edge (on Windows, Mac, ChromeOS and Android), in Safari 26 (on Mac, iPhone and iPad) and in Firefox on Windows.';

/** A setting remembered from last time (or the default). */
function load<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(`fireplace.${key}`);
    return saved === null ? fallback : ({ ...fallback, ...JSON.parse(saved) } as T);
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    localStorage.setItem(`fireplace.${key}`, JSON.stringify(value));
  } catch {
    // Not important.
  }
}

function forget(key: string) {
  try {
    localStorage.removeItem(`fireplace.${key}`);
  } catch {
    // Not important.
  }
}

// How the settings start, and what Reset puts them back to.
const DEFAULT_LIGHTING: Lighting = { lamps: 0, candles: true, time: 'night' };
const DEFAULT_LOOK: { detail: Detail; sky: SkySettings } = { detail: 'medium', sky: { moon: true, constellations: false } };
const DEFAULT_VOLUME = 0.7;

/**
 * The sliders moved from where they start, as last time. (Only those that were moved are kept,
 * so a slider left alone follows its default if that changes.)
 */
function loadTweaks(params: Params) {
  const saved = load<Partial<Record<keyof Params, number>>>('tweaks', {});
  for (const s of SLIDERS) {
    const v = saved[s.key];
    if (typeof v === 'number' && Number.isFinite(v)) params[s.key] = Math.min(s.max, Math.max(s.min, v));
  }
}

function saveTweaks(params: Params) {
  const moved: Partial<Record<keyof Params, number>> = {};
  for (const s of SLIDERS) if (params[s.key] !== DEFAULT_PARAMS[s.key]) moved[s.key] = params[s.key];
  if (Object.keys(moved).length) save('tweaks', moved);
  else forget('tweaks');
}

/** The room to start in: ?room= in the address, else the one chosen last time. */
function initialRoom(query: URLSearchParams): RoomKey {
  let key = query.get('room');
  if (!key) {
    try {
      key = localStorage.getItem('fireplace.room');
    } catch {
      key = null;
    }
  }
  return key && key in ROOMS ? (key as RoomKey) : 'brick';
}

async function start() {
  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  if (!navigator.gpu) {
    showMessage(NO_WEBGPU);
    countEvent('no-webgpu', 'No WebGPU in this browser');
    return;
  }
  // The physics engine loads while the GPU gets ready.
  const physicsLoading = LogPhysics.load();
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    showMessage('This browser has WebGPU, but found no graphics card it can use for it (it may be switched off, or blocked for this one).');
    countEvent('no-gpu-adapter', 'WebGPU, but no graphics card it can use');
    return;
  }
  const device = await adapter.requestDevice({ label: 'fireplace' });
  device.lost.then((info) => {
    if (info.reason === 'destroyed') return;
    showMessage(`The GPU device was lost: ${info.message}`);
    countEvent('gpu-lost', 'The graphics card gave up (device lost)');
  });
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU error:', (e as GPUUncapturedErrorEvent).error.message));

  const context = canvas.getContext('webgpu')!;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const params: Params = { ...DEFAULT_PARAMS };
  loadTweaks(params);
  const query = new URLSearchParams(location.search);
  // The quality to start at, until the automatic check has timed this machine: Low on a phone
  // (a touch screen a hand's width across), where even a few seconds of Medium is a struggle.
  const phone = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
  let qualityKey = QUALITY[query.get('quality') ?? ''] ? query.get('quality')! : phone ? 'low' : 'medium';
  let autoQuality = !query.has('quality');
  let startQuality = qualityKey; // the quality picked for this machine (what Reset goes back to)
  const fire = load<{ mode: FireMode }>('fire', { mode: 'lit' });
  if (query.get('fire') === 'cold' || query.get('fire') === 'lit') fire.mode = query.get('fire') as FireMode;
  const lighting = load<Lighting>('lighting', { ...DEFAULT_LIGHTING });
  const look = load<{ detail: Detail; sky: SkySettings }>('look', { ...DEFAULT_LOOK, sky: { ...DEFAULT_LOOK.sky } });
  if (!DETAILS.some(([d]) => d === look.detail)) look.detail = DEFAULT_LOOK.detail;

  const logs = new LogSystem(device, await physicsLoading, ROOMS[initialRoom(query)]);
  logs.mode = fire.mode;
  logs.reset();
  let sim = new FireSim(device, QUALITY[qualityKey], logs);
  sim.reset(params);
  const renderer = new Renderer(device, context, format, logs, look.detail);
  renderer.lighting = lighting;
  renderer.sky.moonless = !look.sky.moon;
  renderer.constellations = look.sky.constellations;
  // The stars of the night sky outdoors: they load while the fire gets going.
  fetch(starsUrl)
    .then((r) => r.arrayBuffer())
    .then((b) => renderer.setStars(parseStars(b)))
    .catch((e) => console.warn('No stars:', e));
  renderer.setSim(sim);
  const camera = new Camera();
  camera.frame(logs.room);
  canvas.setAttribute('aria-label', logs.room.alt);
  const sparks = renderer.sparks;

  // --- Sound ---------------------------------------------------------------------------------
  const sound = load<SoundSettings>('sound', { on: true, volume: DEFAULT_VOLUME });
  const audio = new FireAudio();
  audio.setVolume(sound.volume);
  audio.setOutdoors(logs.room.wild, lighting.time);
  if (!sound.on) audio.setEnabled(false);
  /** Stereo position of a point in the fire, from where it is on screen. */
  const pan = (p: Vec3) => Math.min(Math.max(project(camera.viewProj, p[0], p[1], p[2])[0] * 0.8, -0.9), 0.9);
  // Browsers only start sound after a click, tap or key press. (The sound button and M decide
  // for themselves, so that pressing them first starts the sound rather than muting it.)
  window.addEventListener('pointerdown', (e) => {
    if (!(e.target instanceof Element && e.target.closest('#sound'))) audio.start();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'm') audio.start();
  });
  document.addEventListener('visibilitychange', () => audio.setVisible(document.visibilityState === 'visible'));

  // --- What happens to the logs shows and sounds -----------------------------------------------
  logs.onKnock = (k) => {
    const hard = Math.min(Math.sqrt(k.energy / 2), 1.5);
    const strength = k.against === 'poker' ? Math.min(k.speed / 1.5, 1) : hard;
    audio.knock(pan(k.pos), strength, k.against, k.charred);
    // Knocking glowing char (or landing in the coals) throws up sparks.
    const glow = k.glowing ? 1 : k.against === 'coals' || k.against === 'iron' ? 0.4 * logs.bed.glow : 0;
    const count = Math.round(glow * (8 + 45 * strength));
    if (count > 2) sparks.burst(k.pos, count, [0, 1.1, 0], 0.8 + 0.8 * strength, 0.05 + 0.05 * strength);
  };
  logs.onBreak = (pos) => {
    audio.snap(pan(pos));
    sparks.burst(pos, 70, [0, 1.3, 0], 1.6, 0.06);
  };
  logs.onCrumble = (pos, size) => {
    audio.crumble(pan(pos), size);
    sparks.burst(pos, 40, [0, 1.0, 0], 1.2, 0.08);
  };
  logs.onLight = (pos) => audio.flare(pan(pos));
  let soundLogs: ReturnType<LogSystem['sounds']> = [];
  audio.onPop = (i) => {
    const spot = soundLogs[i] && logs.hotSpot(soundLogs[i].id);
    if (spot) sparks.burst(spot.pos, 4 + Math.floor(Math.random() * 10), scale(spot.normal, 1.4), 0.9, 0.006);
  };

  // Life round a campfire after dark.
  const critters = new Critters();
  critters.setWild(logs.room.wild);
  critters.onRustle = (p, loud) => audio.rustle(pan(p), loud);
  critters.onKnocks = (p) => {
    audio.woodKnocks(pan(p));
    countEvent('bigfoot', 'Bigfoot came by');
  };
  /** How bright the fire is (0..1), for eyes in the dark to shine back. */
  const fireLevel = () => Math.min(sim.flamePower / FLAME_REF + 0.3 * logs.bed.glow, 1);
  const stepCritters = (dt: number) => {
    const lamp = logs.room.lamps[0];
    critters.update(dt, {
      time: lighting.time,
      lantern: lamp ? { pos: lamp.pos, level: lighting.lamps } : null,
      fire: fireLevel(),
      eye: camera.eye,
      forward: normalize(sub(camera.target, camera.eye)),
      ground: logs.room.key === 'campfire' ? groundHeight : undefined,
    });
  };

  const tools = new Tools(camera, logs, sparks, {
    clack: (p) => audio.clack(pan(p)),
    clink: (p, s) => audio.clink(pan(p), s),
    stir: (p, a) => audio.stir(pan(p), a),
    strike: (p) => audio.strike(pan(p)),
    snuff: (p) => audio.snuff(pan(p)),
  });

  /** A new air solver: for another quality, or for another room (whose air is another shape). */
  const replaceSim = () => {
    const next = new FireSim(device, QUALITY[qualityKey], logs);
    next.reset(params);
    renderer.setSim(next);
    sim.destroy();
    sim = next;
  };

  const setQuality = (key: string) => {
    if (key === qualityKey) return;
    const before = qualityKey;
    qualityKey = key;
    // (A finer grid may be more than the graphics card has memory for: then back to the last.)
    device.pushErrorScope('out-of-memory');
    replaceSim();
    resize();
    ui.setQuality(key);
    void device.popErrorScope().then((error) => {
      if (!error || qualityKey !== key) return;
      ui.hint(`Not enough graphics memory for ${QUALITY[key].label}: back to ${QUALITY[before].label}`, 6);
      setQuality(before);
    });
  };

  const startOver = () => {
    tools.cancel();
    logs.reset();
    sim.reset(params);
    kettle?.reset(airTemp());
    kettleBoiled = false;
    if (logs.mode === 'cold') ui.hint(COLD_HINT, 10);
  };

  const addLog = (wood: string) => logs.count < MAX_LOGS_ADDED && logs.addLog(wood);

  // A kettle set down by the fire: it heats, boils and steams.
  let kettle: Kettle | null = null;
  let kettleBody = -1; // (its collider, for the logs to knock against)
  let kettleBoiled = false;
  /** The air round it (K): a cool night outdoors, a warm room in. */
  const airTemp = () => (logs.room.enclosure === 'open' ? 290 : 295);
  const setKettle = (on: boolean) => {
    if (kettleBody >= 0) logs.physics.removeSupport(kettleBody);
    kettleBody = -1;
    const spot = logs.room.kettle;
    kettle = on && spot ? new Kettle(spot.at, logs.room.sky?.altitude ?? 0, fireCentre(logs.room)) : null;
    kettle?.reset(airTemp());
    kettleBoiled = false;
    if (kettle && spot) {
      const points: Vec3[] = [];
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        for (const y of [0, 0.15]) points.push([spot.at[0] + Math.cos(a) * 0.07, spot.at[1] + y, spot.at[2] + Math.sin(a) * 0.07]);
      }
      kettleBody = logs.physics.addSupport(points, 'iron');
      ui.hint('A kettle of cold water, set down by the fire: it will take a while to boil', 5);
    }
    renderer.kettle = !!kettle;
    renderer.setRoom();
  };
  /** The kettle's steam: lit by the fire (warm, fading with distance) and by the night. */
  const steamLight = (p: Vec3): Vec3 => {
    const fire = sim.flamePower / FLAME_REF + 0.4 * logs.bed.glow;
    const c = fireCentre(logs.room);
    const d2 = (p[0] - c[0]) ** 2 + (p[1] - 0.2) ** 2 + (p[2] - c[2]) ** 2;
    const warm = (0.025 * fire) / (d2 + 0.04);
    const n = renderer.night;
    const cool: Vec3 = n ? [n.light.ambient[0] * 3 + n.light.colour[0], n.light.ambient[1] * 3 + n.light.colour[1], n.light.ambient[2] * 3 + n.light.colour[2]] : [0.01, 0.01, 0.012];
    return [cool[0] + warm, cool[1] + warm * 0.55, cool[2] + warm * 0.28];
  };
  /** The kettle's state, in words. */
  const kettleText = (k: Kettle) => (k.water < 0.01 ? 'boiled dry' : `${Math.round(k.temp - 273.15)} °C${k.boil > 0 ? ', boiling' : ''}`);
  // Showing the fire's workings (Science), the kettle's temperature floats over it.
  const kettleLabel = document.getElementById('kettle-label')!;
  const showKettleLabel = () => {
    const spot = logs.room.kettle;
    const o = renderer.overlay;
    if (!kettle || !spot || (params.debugView === 0 && !o.grid && !o.flow)) {
      kettleLabel.hidden = true;
      return;
    }
    const top = add(spot.at, [0, 0.2, 0]);
    const [x, y] = project(camera.viewProj, top[0], top[1], top[2]);
    const forward = normalize(sub(camera.target, camera.eye));
    kettleLabel.hidden = dot(sub(top, camera.eye), forward) < 0.05 || Math.abs(x) > 1.05 || Math.abs(y) > 1.05;
    kettleLabel.style.left = `${((x + 1) / 2) * canvas.clientWidth}px`;
    kettleLabel.style.top = `${((1 - y) / 2) * canvas.clientHeight}px`;
    kettleLabel.textContent = `Kettle ${kettleText(kettle)}`;
  };
  const stepKettle = (dt: number) => {
    const spot = logs.room.kettle;
    if (!kettle || !spot) {
      renderer.steam.update(dt, null, 0, [0, 0, 0], steamLight);
      return;
    }
    kettle.step(dt * params.burnSpeed, kettle.heatIn(logs), airTemp());
    if (kettle.boil > 0 && !kettleBoiled) {
      kettleBoiled = true;
      ui.hint(`The kettle is boiling (water boils at ${(kettle.boilingPoint - 273.15).toFixed(1)} °C here)`, 5);
    }
    // Wisps as it gets hot, a steady plume at the boil.
    const rate = Math.min(25, kettle.steam / 8e-6) + (kettle.warmth > 0.75 ? 8 * (kettle.warmth - 0.75) : 0);
    const vents = kettleVents(spot.at, spot.yaw);
    const out = normalize(sub(vents.spout, add(spot.at, [0, 0.12, 0])));
    // (Outdoors a breeze carries it off; in a fireplace the draft draws it in and up the chimney.)
    const drift: Vec3 = logs.room.enclosure === 'open' ? [0.12, 0, 0.05] : [0, 0.12, -0.18];
    renderer.steam.update(dt, { pos: vents.spout, dir: out }, rate, drift, steamLight);
  };

  // The moisture view: its key, and a reading over each log.
  const moistureKey = document.getElementById('moisture')!;
  const labels = document.getElementById('labels')!;
  // Names of the constellations and planets, with their figures drawn.
  const skyLabels = document.getElementById('sky-labels')!;
  const showSkyLabels = () => {
    const names = renderer.skyLabels();
    while (skyLabels.children.length < names.length) {
      const el = document.createElement('div');
      el.className = 'sky-label';
      skyLabels.append(el);
    }
    while (skyLabels.children.length > names.length) skyLabels.lastElementChild!.remove();
    const forward = normalize(sub(camera.target, camera.eye));
    names.forEach(({ name, dir }, i) => {
      const el = skyLabels.children[i] as HTMLElement;
      const p = add(camera.eye, scale(dir, 20));
      const [x, y] = project(camera.viewProj, p[0], p[1], p[2]);
      el.hidden = dot(dir, forward) < 0.1 || dir[1] < 0.03 || Math.abs(x) > 1 || Math.abs(y) > 1;
      el.style.left = `${((x + 1) / 2) * canvas.clientWidth}px`;
      el.style.top = `${((1 - y) / 2) * canvas.clientHeight}px`;
      el.textContent = name;
    });
  };
  let moistureTimer = 0;
  const showMoisture = () => {
    const readings = logs.moistureReadings();
    while (labels.children.length < readings.length) {
      const el = document.createElement('div');
      el.className = 'label';
      labels.append(el);
    }
    while (labels.children.length > readings.length) labels.lastElementChild!.remove();
    const forward = normalize(sub(camera.target, camera.eye));
    readings.forEach((r, i) => {
      const el = labels.children[i] as HTMLElement;
      const [x, y] = project(camera.viewProj, r.top[0], r.top[1], r.top[2]);
      el.hidden = dot(sub(r.top, camera.eye), forward) < 0.05 || Math.abs(x) > 1.05 || Math.abs(y) > 1.05;
      el.style.left = `${((x + 1) / 2) * canvas.clientWidth}px`;
      el.style.top = `${((1 - y) / 2) * canvas.clientHeight}px`;
      el.textContent = `${WOODS[r.wood]?.short ?? r.wood} ${Math.round(r.moisture * 100)}%`;
    });
  };

  /** Moves the fire to another room, with a new fire. */
  const setRoom = (key: RoomKey) => {
    if (key === logs.room.key) return;
    tools.cancel();
    logs.setRoom(ROOMS[key]);
    replaceSim();
    renderer.setRoom();
    camera.frame(logs.room);
    canvas.setAttribute('aria-label', logs.room.alt);
    kettle = null;
    kettleBody = -1;
    renderer.kettle = false;
    renderer.steam.clear();
    ui.setRoom(logs.room);
    critters.setWild(logs.room.wild);
    audio.setOutdoors(logs.room.wild, lighting.time);
    if (logs.mode === 'cold') ui.hint(COLD_HINT, 10);
    try {
      localStorage.setItem('fireplace.room', key);
    } catch {
      // Not important.
    }
    const url = new URL(location.href);
    url.searchParams.set('room', key);
    history.replaceState(null, '', url);
  };

  const ui = createUI(params, { quality: qualityKey, detail: look.detail, view: logs.room.views[0].key, sky: look.sky }, sound, logs.room, fire.mode, { ...lighting }, {
    onRoom: (key) => {
      countEvent(`room/${key}`, `Room picked: ${ROOMS[key].label}`);
      setRoom(key);
    },
    onView: (key) => {
      const view = logs.room.views.find((v) => v.key === key);
      if (view) camera.setView(view);
    },
    onDetail: (detail) => {
      look.detail = detail;
      save('look', look);
      renderer.setRoom(detail);
    },
    onKettle: (on) => setKettle(on),
    onSky: (sky) => {
      look.sky = sky;
      save('look', look);
      renderer.sky.moonless = !sky.moon;
      renderer.constellations = sky.constellations;
      if (!sky.constellations) skyLabels.replaceChildren();
    },
    onShow: (view) => {
      params.debugView = view;
      moistureKey.hidden = view !== MOISTURE_VIEW;
      if (view !== MOISTURE_VIEW) labels.replaceChildren();
    },
    onMode: (mode) => {
      fire.mode = mode;
      logs.mode = mode;
      save('fire', fire);
      startOver();
    },
    onLighting: (l) => {
      Object.assign(lighting, l);
      renderer.lighting = lighting;
      audio.setOutdoors(logs.room.wild, lighting.time);
      save('lighting', lighting);
    },
    onQuality: (key) => {
      autoQuality = false;
      countEvent(`quality-picked/${key}`, `Quality picked: ${QUALITY[key].label}`);
      setQuality(key);
    },
    onRelight: startOver,
    onTweak: () => saveTweaks(params),
    onReset: () => resetSettings(),
    onOverlay: (o) => (renderer.overlay = o),
    onMoisture: (m) => {
      logs.setMoisture(m);
      ui.hint(
        m === null
          ? 'The wood is back to as it comes (what the fire has dried stays dry)'
          : `The wood on the fire, and any you lay or put on, is now ${Math.round(m * 100)}% water for its dry weight (what the fire has dried stays dry; kindling is kept dry)`,
        6,
      );
    },
    onResetScience: () => {
      resetScience();
      refreshUI();
      ui.hint('Back to Earth: the science settings are as they were', 3);
    },
    onAddLog: addLog,
    onTool: (tool: ToolName) => {
      tools.setTool(tool);
      updateCursor();
    },
    onTurn: (steps) => tools.turn(steps),
    onNudge: (steps) => tools.nudge(steps),
    onSound: () => {
      if (sound.on && !audio.running) {
        audio.start();
        return true;
      }
      sound.on = !sound.on;
      audio.setEnabled(sound.on);
      save('sound', sound);
      return sound.on;
    },
    onVolume: (v) => {
      sound.volume = v;
      audio.setVolume(v);
      save('sound', sound);
    },
  });
  ui.setTool(tools.tool);

  /** The science settings back to how they are on Earth: gravity, the air, the burning, what shows. */
  const resetScience = () => {
    for (const s of SCIENCE_SLIDERS) params[s.key] = DEFAULT_PARAMS[s.key];
    params.debugView = 0;
    moistureKey.hidden = true;
    labels.replaceChildren();
    renderer.overlay = { grid: false, flow: false, slice: 0 };
    logs.setMoisture(null);
  };
  const refreshUI = (view?: string) =>
    ui.refresh({ params, lighting, sky: look.sky, detail: look.detail, volume: sound.volume, quality: qualityKey, view, overlay: renderer.overlay, moisture: logs.wetness });

  /**
   * Puts every setting back to how it started: the sliders, the science, the lights, the sky,
   * the detail, the volume, the quality picked for this machine, and the view. The room and the
   * fire stay as they are.
   */
  const resetSettings = () => {
    for (const s of SLIDERS) params[s.key] = DEFAULT_PARAMS[s.key];
    forget('tweaks');
    resetScience();
    Object.assign(lighting, DEFAULT_LIGHTING);
    renderer.lighting = lighting;
    audio.setOutdoors(logs.room.wild, lighting.time);
    forget('lighting');
    look.sky = { ...DEFAULT_LOOK.sky };
    renderer.sky.moonless = !look.sky.moon;
    renderer.constellations = look.sky.constellations;
    skyLabels.replaceChildren();
    if (look.detail !== DEFAULT_LOOK.detail) {
      look.detail = DEFAULT_LOOK.detail;
      renderer.setRoom(look.detail);
    }
    forget('look');
    sound.volume = DEFAULT_VOLUME;
    audio.setVolume(sound.volume);
    save('sound', sound);
    setQuality(startQuality);
    const home = logs.room.views[0];
    camera.setView(home);
    refreshUI(home.key);
    ui.hint('Settings are back to how they started', 3);
  };

  // The first few times a log is picked up, say how to move it about.
  let grabs = 0;
  tools.onGrab = () => {
    if (grabs++ < 3) ui.hint(TOUCH ? 'The buttons below turn it and move it back and forth' : 'Scroll (or W/S) to move it back and forth · Shift+scroll (or Q/E) to turn it', 5);
  };
  if (logs.mode === 'cold') setTimeout(() => ui.hint(COLD_HINT, 10), 9500);

  /** Everything that happens in one solver step (blow overrides the pointer, for testing). */
  const stepWorld = (dt: number, blow?: Blow | null) => {
    tools.step(dt);
    logs.step(dt, tools.tipSpeed);
    sim.step(dt, params, blow === undefined ? tools.blow : blow);
  };

  if (import.meta.env.DEV) {
    installDebug({
      device,
      getSim: () => sim,
      logs,
      tools,
      audio,
      critters,
      params,
      dt: SIM_DT,
      startOver,
      stepWorld,
      render: () => {
        camera.update(canvas.width / canvas.height);
        stepCritters(1 / 60);
        renderer.setProps(tools.view(), logs.lighterViews(), critters.views(fireLevel()));
        renderer.render(camera, params, sim.time);
      },
      renderer,
      camera,
      adaptation: () => renderer.readAdaptation(),
      setRoom,
      setMode: (mode: FireMode) => {
        fire.mode = mode;
        logs.mode = mode;
        startOver();
      },
      setLighting: (l: Partial<Lighting>) => {
        Object.assign(lighting, l);
        renderer.lighting = lighting;
      },
      setDetail: (detail) => renderer.setRoom(detail),
      kettle: () => kettle,
      stepKettle,
    });
  }

  // --- Canvas size ------------------------------------------------------------------------
  const resize = () => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    let w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    let h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    const k = Math.sqrt(QUALITY[qualityKey].pixels / (w * h));
    if (k < 1) {
      w = Math.round(w * k);
      h = Math.round(h * k);
    }
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      renderer.resize(w, h);
    }
  };
  resize();
  new ResizeObserver(resize).observe(canvas);

  // --- Input -------------------------------------------------------------------------------
  // One finger or the left button uses the tool in hand. Right-drag (or two fingers) looks
  // around; the wheel (or pinching) zooms, or turns a log held in the tongs.
  const pointers = new Map<number, { x: number; y: number }>();
  let orbiting = false;
  let gesture: { x: number; y: number; spread: number } | null = null;
  let last = { x: 0, y: 0 };

  const ndc = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
  };
  const twoFingers = () => {
    const [a, b] = [...pointers.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
  };
  const updateCursor = (e?: PointerEvent) => {
    canvas.style.cursor = orbiting ? 'move' : e ? tools.hover(ndc(e)) : tools.tool === 'tongs' ? 'default' : 'crosshair';
  };

  canvas.addEventListener('pointerdown', (e) => {
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      // Not an active pointer (a synthetic event): carry on without capture.
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    last = { x: e.clientX, y: e.clientY };
    if (pointers.size === 2) {
      // A second finger: stop using the tool, look around instead.
      tools.cancel();
      gesture = twoFingers();
    } else if (pointers.size === 1) {
      // (Looking about the sky there is nothing to take hold of: any drag turns the head.)
      if (e.button === 2 || e.button === 1 || camera.mode === 'look') orbiting = true;
      else tools.down(ndc(e));
    }
    updateCursor(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture && pointers.size === 2) {
      const g = twoFingers();
      camera.orbit(-(g.x - gesture.x) * 0.004, (g.y - gesture.y) * 0.004);
      if (g.spread > 0 && gesture.spread > 0) camera.zoom(gesture.spread / g.spread);
      gesture = g;
    } else if (orbiting) {
      camera.orbit(-(e.clientX - last.x) * 0.004, (e.clientY - last.y) * 0.004);
    } else if (!gesture) {
      tools.move(ndc(e));
    }
    last = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'mouse') updateCursor(e);
  });
  const endPointer = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (gesture) {
      if (pointers.size === 0) gesture = null;
      return;
    }
    if (orbiting) orbiting = false;
    else tools.up();
    updateCursor(e);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // With a log in the tongs, the wheel moves it deeper or closer (a notch at a time, or
      // smoothly on a touchpad), or with Shift turns it.
      const notches = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100;
      const held = e.shiftKey ? tools.turn(Math.sign(e.deltaY || e.deltaX)) : tools.nudge(-Math.max(-3, Math.min(3, notches)));
      if (!held) camera.zoom(Math.exp(e.deltaY * 0.001));
    },
    { passive: false },
  );

  const hint = document.getElementById('hint')!;
  if (TOUCH) hint.textContent = 'Drag a log to move it · two fingers to look around · tap for sound';
  setTimeout(() => hint.classList.add('faded'), 9000);

  // Keep the screen from sleeping while the fire is showing. Browsers only grant this for a
  // visible page, and drop it when the page is hidden, so ask again whenever it comes back.
  const keepAwake = () => {
    if (document.visibilityState === 'visible' && 'wakeLock' in navigator) {
      navigator.wakeLock.request('screen').catch(() => {});
    }
  };
  keepAwake();
  document.addEventListener('visibilitychange', keepAwake);
  canvas.addEventListener('pointerdown', keepAwake, { once: true });

  // --- Automatic quality -------------------------------------------------------------------
  // Times a few solver steps on this GPU once things have warmed up. Fast GPUs get the finer
  // grid; slow ones drop to the coarse one. A later frame-rate check can still step down.
  const pickQuality = async () => {
    await device.queue.onSubmittedWorkDone();
    const t0 = performance.now();
    for (let i = 0; i < 8; i++) sim.step(SIM_DT, params, null);
    await device.queue.onSubmittedWorkDone();
    const msPerStep = (performance.now() - t0) / 8;
    if (!autoQuality) return;
    if (msPerStep < 3 && qualityKey === 'medium') setQuality('high');
    else if (msPerStep > 9 && qualityKey === 'medium') setQuality('low');
    startQuality = qualityKey;
  };

  // --- Main loop ---------------------------------------------------------------------------
  let lastTime = performance.now();
  let acc = 0;
  let frameTimeAvg = 16;
  let frames = 0;
  let statsTimer = 0;
  let soundTimer = 0;

  const frame = (now: number) => {
    // A quality that draws fewer frames skips those that come too soon after the last it drew (the
    // next one then catches the fire up, two steps at a time).
    const cap = QUALITY[qualityKey].fps;
    if (cap && now - lastTime < 1000 / cap - 3) {
      requestAnimationFrame(frame);
      return;
    }
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    acc += dt;

    // Gravity (Science) for the logs and the kettle's steam; the air and the sparks read it themselves.
    logs.physics.setGravity(params.gravity);
    renderer.steam.lift = Math.sqrt(Math.max(params.gravity, 0) / 9.81);
    tools.frame(dt);
    logs.update(dt, params);
    logs.prepare(params, SIM_DT);
    let steps = 0;
    while (acc >= SIM_DT && steps < (cap ? 3 : 2)) {
      stepWorld(SIM_DT);
      acc -= SIM_DT;
      steps++;
    }
    if (acc > SIM_DT) acc = 0; // too slow to keep up: let the fire run in slow motion instead

    camera.update(canvas.width / canvas.height, dt);
    stepCritters(dt);
    stepKettle(dt);
    renderer.setProps(tools.view(), logs.lighterViews(), critters.views(fireLevel()));
    renderer.render(camera, params, sim.time, dt);
    if (renderer.constellations && renderer.night) showSkyLabels();
    else if (skyLabels.childElementCount) skyLabels.replaceChildren();
    if (params.debugView === MOISTURE_VIEW) {
      moistureTimer += dt;
      if (moistureTimer > 0.5) {
        moistureTimer = 0;
        void logs.measureMoisture();
      }
      showMoisture();
    }
    showKettleLabel();

    // How much the flames radiate, and from where: for the coals and for the sound.
    soundTimer += dt;
    if (soundTimer > 0.1) {
      soundTimer = 0;
      sim.sampleFlamePower();
      soundLogs = logs.sounds();
    }
    if (audio.running) {
      audio.update(
        {
          flame: sim.flamePower / FLAME_REF,
          coals: logs.bed.glow,
          blow: tools.blow ? tools.blow.strength * Math.min(Math.hypot(...tools.blow.vel) / 2, 1) : 0,
          logs: soundLogs.map((l) => ({ pan: pan(l.centre), gas: l.gas, steam: l.steam, wood: l.wood })),
          kettle: kettle ? { warmth: kettle.warmth, boil: kettle.boil, pan: pan(kettle.at) } : undefined,
        },
        dt,
      );
    }

    ui.setHolding(tools.holdingLog);
    if (frames === 0) document.getElementById('loading')!.hidden = true;
    frames++;
    frameTimeAvg += (dt * 1000 - frameTimeAvg) * 0.05;
    if (autoQuality && frames === 90) void pickQuality();
    if (autoQuality && frames === 400) {
      autoQuality = false;
      if (frameTimeAvg > 30 && qualityKey !== 'low') setQuality(qualityKey === 'high' ? 'medium' : 'low');
      startQuality = qualityKey;
      // What this device settled on, and how smoothly it ran on the way.
      const fps = 1000 / frameTimeAvg;
      const band = fps < 15 ? 'under 15' : fps < 25 ? '15-25' : fps < 40 ? '25-40' : '40+';
      countEvent(`quality/${qualityKey}`, `Settled on ${QUALITY[qualityKey].label}${phone ? ' (phone)' : ''}`);
      countEvent(`fps/${band.replace(' ', '-')}`, `${band} frames a second (${QUALITY[qualityKey].label})`);
    }
    statsTimer += dt;
    if (statsTimer > 0.5) {
      statsTimer = 0;
      const [nx, ny, nz] = sim.dims;
      const glowT = logs.bed.glowTemp;
      const fps = (1000 / frameTimeAvg).toFixed(0);
      const coals = `${logs.bed.totalMass.toFixed(2)} kg` + (glowT === null ? '' : ` at ${Math.round(glowT - 273)} °C`);
      ui.setStats(`${fps} fps · ${nx}×${ny}×${nz} grid · ${logs.count} logs · coals ${coals}` + (kettle ? ` · kettle ${kettleText(kettle)}` : ''));
      ui.setReadouts([
        `Grid: ${nx} × ${ny} × ${nz} cells of ${(sim.h * 1000).toFixed(1)} mm (${Math.round((nx * ny * nz) / 1000)} thousand)`,
        `Flames radiate ${(sim.flamePower / 1000).toFixed(1)} kW`,
        `Coals: ${coals}`,
        `On the fire: ${logs.count} ${logs.count === 1 ? 'piece' : 'pieces'} of wood`,
        ...(kettle ? [`Kettle: ${kettleText(kettle)} (boils at ${(kettle.boilingPoint - 273.15).toFixed(1)} °C)`] : []),
        `Gravity: ${params.gravity.toFixed(2)} m/s²`,
        `${fps} frames a second`,
      ]);
      ui.setLogCount(logs.count, MAX_LOGS_ADDED);
      // Once the fire is lit, the hint on how to light it has done its job.
      if (hint.textContent === COLD_HINT && logs.lighterState !== 'unlit') hint.classList.add('faded');
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  showMessage(`Something went wrong starting the fireplace: ${err instanceof Error ? err.message : String(err)}`);
  countEvent('start-error', 'Failed to start');
});
