import { DETAILS, QUALITY, WOODS, type Detail, type Params } from './config';
import type { FireMode } from './layouts';
import type { Lighting, Overlay, TimeOfDay } from './render/Renderer';
import { ROOMS, type Room, type RoomKey } from './rooms';
import type { ToolName } from './tools';

interface Slider {
  key: keyof Params;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  title?: string;
  outdoors?: boolean; // only offered out in the open
  indoors?: boolean; // only offered in a fireplace
}

/** How the picture looks (under More settings). */
const PICTURE_SLIDERS: Slider[] = [
  { key: 'exposure', label: 'Brightness', min: 0.5, max: 12, step: 0.1 },
  { key: 'saturation', label: 'Colour', min: 0, max: 2, step: 0.05, title: 'How rich the colours are' },
  { key: 'bloom', label: 'Glow', min: 0, max: 0.12, step: 0.005, title: 'The glow round bright light' },
  { key: 'sparks', label: 'Sparks', min: 0, max: 150, step: 5 },
  { key: 'haze', label: 'Heat haze', min: 0, max: 40, step: 1 },
  { key: 'starlight', label: 'Starlight', min: 0, max: 2, step: 0.05, title: 'Brings out the stars and the Milky Way (0: as the eye sees them)', outdoors: true },
];

/** The settings that are sliders (they are remembered, and Reset puts them back). */
export const SLIDERS: Slider[] = PICTURE_SLIDERS;

/** How the air moves (Science). */
const AIR_SLIDERS: Slider[] = [
  { key: 'buoyancy', label: 'Lift', min: 0, max: 1.5, step: 0.05, title: 'Buoyancy: how strongly hot air rises for its heat (times gravity)' },
  { key: 'vorticity', label: 'Swirl', min: 0, max: 25, step: 0.5, title: 'Vorticity confinement: puts back the small swirls a grid smears out' },
  { key: 'turbulence', label: 'Flicker', min: 0, max: 20, step: 0.5, title: 'Turbulence in hot gas, finer than the grid' },
  { key: 'damping', label: 'Drag', min: 0, max: 3, step: 0.05, title: 'How fast the air’s motion dies away (standing in for viscosity)' },
  { key: 'draft', label: 'Draft', min: 0, max: 5, step: 0.1, unit: '', title: 'How hard the chimney pulls (m/s through its throat)', indoors: true },
  { key: 'expansion', label: 'Expansion', min: 0, max: 1, step: 0.05, title: 'How much burning gas swells as it heats (1: as an ideal gas)' },
];

/** How the fire burns (Science). */
const BURN_SLIDERS: Slider[] = [
  { key: 'burnSpeed', label: 'Time', min: 1, max: 60, step: 1, unit: '×', title: 'Speeds the burning up, as a time-lapse (1× is real time)' },
  { key: 'burnRate', label: 'Burn rate', min: 20, max: 400, step: 5, title: 'How fast wood gas burns where it meets air' },
  { key: 'ignitionTemp', label: 'Ignition', min: 400, max: 1000, step: 10, title: 'How hot (K) gas must be to catch' },
  { key: 'heatRelease', label: 'Heat', min: 2000, max: 16000, step: 250, title: 'How much burning heats the gas (K per unit of fuel)' },
  { key: 'stoich', label: 'Air needed', min: 1, max: 10, step: 0.25, title: 'Volumes of air a volume of wood gas needs to burn' },
  { key: 'sootYield', label: 'Soot', min: 0, max: 5, step: 0.1, title: 'How much soot burning makes: it is what glows yellow in a flame' },
  { key: 'sootBurn', label: 'Soot burns', min: 0, max: 30, step: 0.5, title: 'How fast soot burns off in hot air (which is what ends a flame)' },
  { key: 'cooling', label: 'Cooling', min: 0, max: 200, step: 5, title: 'How fast hot gas loses its heat by radiating it' },
  { key: 'flameRadiation', label: 'Radiation', min: 0, max: 2, step: 0.05, title: 'How strongly the flames’ radiation heats the logs' },
  { key: 'smokeYield', label: 'Smoke', min: 0, max: 5, step: 0.1, title: 'How readily unburnt gas condenses into white smoke' },
  { key: 'smokeDecay', label: 'Smoke thins', min: 0, max: 1, step: 0.01, title: 'How fast smoke thins out (per second)' },
];

/** The settings in the Science panel that are sliders (not remembered: each visit starts on Earth). */
export const SCIENCE_SLIDERS: Slider[] = [
  { key: 'gravity', label: 'Gravity', min: 0, max: 25, step: 0.01, title: 'm/s²: what makes hot air rise, logs fall and sparks drop' },
  ...AIR_SLIDERS,
  ...BURN_SLIDERS,
];

/** Where one might light a fire, and its gravity (m/s²). */
const WORLDS: [string, string, number][] = [
  ['earth', 'Earth', 9.81],
  ['moon', 'the Moon', 1.62],
  ['mars', 'Mars', 3.71],
  ['jupiter', 'Jupiter', 24.79],
  ['orbit', 'In orbit (weightless)', 0],
];

/** How wet the logs put on are (Science): as the wood comes, or so much water per dry wood. */
const MOISTURES: [string, string][] = [
  ['', 'As the wood comes'],
  ['0.05', 'Bone dry (5%)'],
  ['0.12', 'Kiln dried (12%)'],
  ['0.2', 'Seasoned (20%)'],
  ['0.35', 'Half seasoned (35%)'],
  ['0.6', 'Green (60%)'],
];

/** What the picture shows (Params.debugView): the fire as it is, or one of its workings. */
export const SHOW: [number, string][] = [
  [0, 'Fire'],
  [8, 'Wood moisture'],
  [1, 'Temperature'],
  [2, 'Fuel gas'],
  [3, 'Oxygen used'],
  [4, 'Soot'],
  [5, 'Air speed'],
  [6, 'Smoke'],
];
export const MOISTURE_VIEW = 8;

const MODES: [FireMode, string][] = [
  ['lit', 'Already burning'],
  ['cold', 'Laid cold: light it'],
];

const TIMES: [TimeOfDay, string][] = [
  ['night', 'Night'],
  ['dusk', 'Dusk'],
  ['day', 'Daytime'],
];

/** A touch screen (no mouse wheel or keys to mention). */
export const TOUCH = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const TOOL_HINTS: Record<ToolName, string> = TOUCH
  ? {
      tongs: 'Drag a log to move it · while you hold it, the buttons below turn it and move it back and forth',
      poker: 'Drag to push logs · tap to jab · rake through the coals to stir them',
      blow: 'Drag across the coals to blow on them',
      match: 'Hold the match to a firelighter (or kindling) until it catches · let go to blow it out',
    }
  : {
      tongs: 'Drag a log to move it · scroll (or W/S) moves it back and forth · Shift+scroll (or Q/E) turns it',
      poker: 'Drag to push logs · click to jab · rake through the coals to stir them',
      blow: 'Drag across the coals to blow on them',
      match: 'Hold the match to a firelighter (or kindling) until it catches · let go to blow it out',
    };

export interface UIHandlers {
  onRoom(key: RoomKey): void;
  onMode(mode: FireMode): void;
  onLighting(lighting: Lighting): void;
  onQuality(key: string): void;
  onDetail(detail: Detail): void;
  /** Smooth the stair-stepped edges (anti-aliasing), or leave them sharp. */
  onSmoothEdges(on: boolean): void;
  onView(key: string): void;
  onShow(view: number): void;
  onSky(sky: SkySettings): void;
  /** Set a kettle down by the fire, or take it away. */
  onKettle(on: boolean): void;
  onRelight(): void;
  /** A slider was let go of (its value is already in the params): remember it. */
  onTweak(): void;
  /** Put every setting back to how it started. */
  onReset(): void;
  /** Science: show (or hide) the grid and the airflow. */
  onOverlay(overlay: Overlay): void;
  /** Science: how wet logs put on are (water per dry wood), or null for as the wood comes. */
  onMoisture(moisture: number | null): void;
  /** Science: everything back to how it is on Earth. */
  onResetScience(): void;
  onAddLog(wood: string): boolean;
  onTool(tool: ToolName): void;
  onTurn(steps: number): void;
  onNudge(steps: number): void;
  /** The sound button was pressed; returns whether sound is now on. */
  onSound(): boolean;
  onVolume(volume: number): void;
}

/** Everything the settings panel shows, for bringing it up to date at once (after a reset). */
export interface Settings {
  params: Params;
  lighting: Lighting;
  sky: SkySettings;
  detail: Detail;
  smoothEdges: boolean;
  volume: number;
  quality: string;
  view?: string; // (left as it is if not given)
  overlay: Overlay;
  moisture: number | null;
}

export interface UI {
  /** The fire moved to another room: offer that room's wood, lights and views. */
  setRoom(room: Room): void;
  /** Shows these settings in the panel. */
  refresh(settings: Settings): void;
  setStats(text: string): void;
  /** Readings for the Science panel, a line each. */
  setReadouts(lines: string[]): void;
  setQuality(key: string): void;
  setView(key: string): void;
  setLogCount(count: number, max: number): void;
  setTool(tool: ToolName): void;
  /** Shows a hint for a while. */
  hint(text: string, seconds?: number): void;
  /** Whether the controls are hidden (just the fire showing). */
  readonly bare: boolean;
  /** A log is held in the tongs (or not): offer buttons to turn it and move it back and forth. */
  setHolding(holding: boolean): void;
}

export interface SoundSettings {
  on: boolean;
  volume: number;
}

export interface Choices {
  quality: string;
  detail: Detail;
  smoothEdges: boolean;
  view: string;
  sky: SkySettings;
}

/** The night sky outdoors: the Moon as it is tonight or left out, the constellations drawn or not. */
export interface SkySettings {
  moon: boolean;
  constellations: boolean;
}

/** The Palestine Children's Relief Fund's page for giving (see the credits). */
const DONATE_URL = 'https://www.pcrf.net/donate';

export function createUI(
  params: Params,
  choices: Choices,
  sound: SoundSettings,
  room: Room,
  mode: FireMode,
  lighting: Lighting,
  handlers: UIHandlers,
): UI {
  const panel = document.getElementById('panel')!;
  const body = document.createElement('div');
  body.className = 'panel-body';
  let current = room;
  let viewKey = choices.view;

  // ---- The main settings: where, how you look at it, the fire, the lights, the sky, sound ----
  const roomSelect = select(
    'Room',
    Object.values(ROOMS).map((r) => [r.key, r.label]),
    room.key,
    (v) => handlers.onRoom(v as RoomKey),
  );
  const viewSelect = select('View', [], viewKey, (v) => chooseView(v));
  const modeSelect = select('Fire', MODES, mode, (v) => handlers.onMode(v as FireMode));
  let wood = room.woods[0];
  const woodSelect = select('Wood', [], wood, (v) => (wood = v), 'What Add a log puts on');
  body.append(roomSelect.row, viewSelect.row, modeSelect.row, woodSelect.row);

  // The room's own lights.
  const lamps = range('Lamps', 0, 1, 0.05, lighting.lamps, percent, (v) => {
    lighting.lamps = v;
    handlers.onLighting(lighting);
  });
  const candles = select('Candles', [['lit', 'Lit'], ['out', 'Out']], lighting.candles ? 'lit' : 'out', (v) => {
    lighting.candles = v === 'lit';
    handlers.onLighting(lighting);
  });
  const time = select('Outside', TIMES, lighting.time, (v) => {
    lighting.time = v as TimeOfDay;
    handlers.onLighting(lighting);
  }, 'The time of day');
  body.append(lamps.row, candles.row, time.row);
  // The sky (outdoors), and a kettle by the fire.
  const sky = { ...choices.sky };
  const moon = select('Moon', [['shown', 'As tonight'], ['hidden', 'Left out']], sky.moon ? 'shown' : 'hidden', (v) => {
    sky.moon = v === 'shown';
    handlers.onSky({ ...sky });
  });
  const figures = select('Stars', [['plain', 'As they are'], ['figures', 'Constellations']], sky.constellations ? 'figures' : 'plain', (v) => {
    sky.constellations = v === 'figures';
    handlers.onSky({ ...sky });
  });
  const kettle = select('Kettle', [['none', 'None'], ['fire', 'By the fire']], 'none', (v) => handlers.onKettle(v === 'fire'));
  body.append(moon.row, figures.row, kettle.row);
  const volume = range('Volume', 0, 1, 0.05, sound.volume, percent, (v) => handlers.onVolume(v));
  body.append(volume.row);

  // ---- More settings: how the picture looks, and speed -----------------------------------------
  const more = document.createElement('details');
  more.className = 'more';
  const summary = document.createElement('summary');
  summary.textContent = 'More settings';
  more.append(summary);
  const sliders = new Map<keyof Params, ReturnType<typeof range>>();
  const outdoorOnly: HTMLElement[] = [];
  const indoorOnly: HTMLElement[] = [];
  more.append(heading('The picture'));
  for (const s of PICTURE_SLIDERS) {
    const r = range(s.label, s.min, s.max, s.step, params[s.key], (v) => format(v) + (s.unit ?? ''), (v) => (params[s.key] = v), handlers.onTweak, s.title);
    sliders.set(s.key, r);
    if (s.outdoors) outdoorOnly.push(r.row);
    more.append(r.row);
  }
  const edgesSelect = select(
    'Edges',
    [
      ['smooth', 'Smoothed'],
      ['sharp', 'Left sharp'],
    ],
    choices.smoothEdges ? 'smooth' : 'sharp',
    (v) => handlers.onSmoothEdges(v === 'smooth'),
    'Smooths the stair-stepped edges of the logs, the grate and the furniture (anti-aliasing)',
  );
  more.append(edgesSelect.row);
  more.append(heading('Performance'));
  const qualitySelect = select(
    'Quality',
    Object.entries(QUALITY).map(([k, q]) => [k, q.label]),
    choices.quality,
    (v) => handlers.onQuality(v),
    'How finely the fire is simulated (chosen for your graphics card to start with)',
  );
  const detailSelect = select('Detail', DETAILS, choices.detail, (v) => handlers.onDetail(v as Detail), 'How much there is round the fire');
  more.append(qualitySelect.row, detailSelect.row);
  const stats = document.createElement('div');
  stats.className = 'stats';
  more.append(stats);
  body.append(more);

  // ---- Start the fire over, or put the settings back -------------------------------------------
  const actions = document.createElement('div');
  actions.className = 'actions';
  const relight = button('Start over', 'A new fire, laid the way Fire says', () => handlers.onRelight());
  const reset = button('Reset settings', 'Put every setting back to how it started (the room and the fire stay as they are)', () => handlers.onReset());
  actions.append(relight, reset);
  body.append(actions);

  // ---- Controls: what the hint at the start said (it fades), and every key ----------------------
  const controls = document.createElement('details');
  controls.className = 'more credits controls';
  const controlsSummary = document.createElement('summary');
  controlsSummary.textContent = 'Controls';
  const keys = document.createElement('ul');
  for (const html of [
    '<b>Tongs</b> <kbd>1</kbd>: drag a log to pick it up and move it; <kbd>W</kbd> <kbd>S</kbd> or the wheel move it back and forth, <kbd>Q</kbd> <kbd>E</kbd> turn it',
    '<b>Poker</b> <kbd>2</kbd>: drag to push logs about, click to jab',
    '<b>Blow</b> <kbd>3</kbd>: drag across the coals',
    '<b>Match</b> <kbd>4</kbd>: press to strike it and hold it to a firelighter',
    '<kbd>L</kbd> or <b>Add a log</b>: another log on the fire',
    'Right-drag (or two fingers) looks around; the wheel (or pinching) zooms',
    '<kbd>M</kbd> sound on or off, <kbd>V</kbd> next view, <kbd>H</kbd> hide the controls (<kbd>Esc</kbd> brings them back), <kbd>X</kbd> science',
    'The house (top left): the main page, to sit somewhere else or read how it works (<kbd>Esc</kbd> comes back to the fire)',
  ]) {
    const item = document.createElement('li');
    item.innerHTML = html;
    keys.append(item);
  }
  controls.append(controlsSummary, keys);
  body.append(controls);

  // ---- Credits --------------------------------------------------------------------------------
  const credits = document.createElement('details');
  credits.className = 'more credits';
  const creditsSummary = document.createElement('summary');
  creditsSummary.textContent = 'Credits';
  const list = document.createElement('ul');
  const author = document.createElement('b');
  author.textContent = 'Omar Al-Hinai';
  const cat = document.createElement('b');
  cat.textContent = 'Macaroni';
  const book = document.createElement('i');
  book.textContent = 'Astronomical Algorithms';
  const charts = document.createElement('i');
  charts.textContent = 'Sky & Telescope';
  for (const parts of [
    ['Made by ', author],
    ['The cat by the hearth: ', cat],
    ['Physics: ', link('Rapier', 'https://rapier.rs'), ' by Dimforge (', link('Apache License 2.0', 'https://www.apache.org/licenses/LICENSE-2.0'), ')'],
    ['Stars: the ', link('Yale Bright Star Catalogue', 'https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50'), ', 5th revised edition (Hoffleit & Warren, 1991), from the CDS, Strasbourg'],
    ['The Sun, the Moon and the turning sky: after Jean Meeus, ', book],
    ['The planets: ', link('JPL’s approximate positions', 'https://ssd.jpl.nasa.gov/planets/approx_pos.html'), ' (E. M. Standish), their brightness after Mallama & Hilton (2018)'],
    ['Constellation figures after the IAU and ', charts, ' charts'],
    ['Coded with Claude Opus 5.5 (Anthropic), in WebGPU, TypeScript and Vite'],
  ]) {
    const item = document.createElement('li');
    item.append(...parts);
    list.append(item);
  }
  const give = document.createElement('p');
  give.append('If the fire warms you, please give to the ', link('Palestine Children’s Relief Fund', DONATE_URL), '.');
  credits.append(creditsSummary, list, give);
  body.append(credits);

  // ---- Science: the fire's workings shown; the air, the burning and gravity changed -------------
  const science = document.getElementById('science')!;
  const scienceButton = document.getElementById('science-button')!;
  const head = document.createElement('div');
  head.className = 'head';
  const title = document.createElement('span');
  title.textContent = 'Science';
  const close = button('×', 'Close (X)', () => setScience(false));
  close.className = 'close';
  head.append(title, close);
  science.append(head);
  const showSelect = select(
    'Show',
    SHOW.map(([v, label]) => [String(v), label]),
    String(params.debugView),
    (v) => handlers.onShow(Number(v)),
    'The fire as it is, or its workings: the moisture in the wood, and the air’s temperature, gas, oxygen, soot, speed and smoke',
  );
  science.append(showSelect.row);
  const overlay: Overlay = { grid: false, flow: false, slice: 0 };
  const changedOverlay = () => {
    slice.row.style.display = overlay.grid || overlay.flow ? '' : 'none';
    handlers.onOverlay({ ...overlay });
  };
  const checks = document.createElement('div');
  checks.className = 'checks';
  const gridCheck = checkbox('Grid', 'The grid of cells the air is worked out on, in a slice through the fire, and the cells it takes to be solid: wood (orange), walls and stones (grey)', (on) => {
    overlay.grid = on;
    changedOverlay();
  });
  const flowCheck = checkbox('Airflow', 'Arrows for the air’s flow across the slice: blue where it is still, through green and yellow, to red at 3 m/s', (on) => {
    overlay.flow = on;
    changedOverlay();
  });
  checks.append(gridCheck.label, flowCheck.label);
  science.append(checks);
  const slice = range('Slice', -1, 1, 0.02, 0, (v) => (Math.abs(v) < 0.01 ? 'mid' : v.toFixed(1)), (v) => {
    overlay.slice = v;
    handlers.onOverlay({ ...overlay });
  }, undefined, 'Where the slice cuts: from the back (or one side) through the middle of the fire to the front');
  slice.row.style.display = 'none';
  science.append(slice.row);

  science.append(heading('Gravity'));
  const worldOf = (g: number) => WORLDS.find(([, , w]) => Math.abs(w - g) < 0.005)?.[0] ?? 'other';
  const world = select('World', [...WORLDS.map(([k, label]) => [k, label] as [string, string]), ['other', 'Somewhere else']], worldOf(params.gravity), (v) => {
    const w = WORLDS.find(([k]) => k === v);
    if (!w) return;
    params.gravity = w[2];
    sciSliders.get('gravity')!.set(w[2]);
  }, 'Light the fire somewhere else');
  science.append(world.row);
  const sciSliders = new Map<keyof Params, ReturnType<typeof range>>();
  const sciRange = (s: Slider) => {
    const r = range(s.label, s.min, s.max, s.step, params[s.key], (v) => format(v) + (s.unit ?? ''), (v) => {
      params[s.key] = v;
      if (s.key === 'gravity') world.input.value = worldOf(v);
    }, undefined, s.title);
    sciSliders.set(s.key, r);
    if (s.indoors) indoorOnly.push(r.row);
    science.append(r.row);
  };
  sciRange(SCIENCE_SLIDERS[0]);
  science.append(heading('The air'));
  AIR_SLIDERS.forEach(sciRange);
  science.append(heading('Burning'));
  BURN_SLIDERS.forEach(sciRange);
  science.append(heading('The wood'));
  const moisture = select('Moisture', MOISTURES, '', (v) => handlers.onMoisture(v === '' ? null : Number(v)), 'How wet the wood is (water for its weight of dry wood): the logs on the fire now (what the fire has dried stays dry), and those you lay (Start over) or put on. Kindling is kept dry.');
  science.append(moisture.row);
  science.append(heading('Readings'));
  const readouts = document.createElement('div');
  readouts.className = 'readouts';
  science.append(readouts);
  const sciActions = document.createElement('div');
  sciActions.className = 'actions';
  sciActions.append(button('Back to Earth', 'Every science setting back to how it is on Earth', () => handlers.onResetScience()));
  science.append(sciActions);

  /** Opens (or closes) the Science panel. On a narrow screen, only one panel at a time. */
  const setScience = (open: boolean) => {
    science.hidden = !open;
    scienceButton.setAttribute('aria-pressed', String(open));
    if (open && innerWidth < 700) {
      panel.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    }
  };
  scienceButton.addEventListener('click', () => setScience(science.hidden !== false));

  const offerRoom = (r: Room) => {
    woodSelect.input.replaceChildren(...r.woods.map((k) => option(k, WOODS[k].label)));
    wood = r.woods[0];
    woodSelect.input.value = wood;
    viewSelect.input.replaceChildren(...r.views.map((v) => option(v.key, v.label)));
    viewSelect.input.value = viewKey;
    for (const row of [moon.row, figures.row, ...outdoorOnly]) row.style.display = r.sky ? '' : 'none';
    for (const row of indoorOnly) row.style.display = r.enclosure === 'open' ? 'none' : '';
    lamps.row.style.display = r.lamps.length ? '' : 'none';
    candles.row.style.display = r.candles.length ? '' : 'none';
    kettle.row.style.display = r.kettle ? '' : 'none';
    kettle.input.value = 'none';
  };
  offerRoom(room);

  const toggle = document.createElement('button');
  toggle.className = 'toggle';
  toggle.textContent = 'Settings';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.addEventListener('click', () => {
    const open = panel.classList.toggle('open');
    toggle.setAttribute('aria-expanded', String(open));
    if (open && innerWidth < 700) setScience(false);
  });
  panel.append(toggle, body);

  // The main action gets its own button, out of the way of the fire.
  const addLog = document.getElementById('add-log') as HTMLButtonElement;
  const add = () => {
    if (!handlers.onAddLog(wood)) flash(addLog);
  };
  addLog.addEventListener('click', add);

  // Tools.
  const toolbar = document.getElementById('toolbar')!;
  const hintEl = document.getElementById('hint')!;
  const toolButtons = [...toolbar.querySelectorAll<HTMLButtonElement>('button[data-tool]')];
  let hintTimer = 0;
  const hint = (text: string, seconds = 4) => {
    hintEl.textContent = text;
    hintEl.classList.remove('faded');
    clearTimeout(hintTimer);
    hintTimer = window.setTimeout(() => hintEl.classList.add('faded'), seconds * 1000);
  };
  const setTool = (tool: ToolName, announce: boolean) => {
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === tool));
    if (announce) hint(TOOL_HINTS[tool]);
  };
  const chooseTool = (tool: ToolName) => {
    setTool(tool, true);
    handlers.onTool(tool);
  };
  for (const b of toolButtons) b.addEventListener('click', () => chooseTool(b.dataset.tool as ToolName));

  // While a log is held: buttons to turn it and push it back or pull it closer (for touch
  // screens, where there is no wheel or keyboard). Held down, they keep going.
  const holdBar = document.getElementById('holding')!;
  let repeat = 0;
  for (const b of holdBar.querySelectorAll<HTMLButtonElement>('button')) {
    const act = () => {
      const [kind, steps] = [b.dataset.act!, Number(b.dataset.steps)];
      if (kind === 'turn') handlers.onTurn(steps);
      else handlers.onNudge(steps);
    };
    b.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      act();
      clearInterval(repeat);
      repeat = window.setInterval(act, 140);
    });
    for (const end of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(end, () => clearInterval(repeat));
  }

  // Views: from the list, or the next one round with the camera button (V).
  function chooseView(key: string) {
    viewKey = key;
    viewSelect.input.value = key;
    handlers.onView(key);
  }
  const nextView = () => {
    const views = current.views;
    const i = views.findIndex((v) => v.key === viewKey);
    const next = views[(i + 1) % views.length];
    chooseView(next.key);
    hint(next.kind === 'look' ? `${next.label} · drag to look around · ${TOUCH ? 'pinch' : 'scroll'} to zoom` : next.label, 2.5);
  };
  document.getElementById('view')!.addEventListener('click', nextView);

  // Sound.
  const soundButton = document.getElementById('sound') as HTMLButtonElement;
  const toggleSound = () => soundButton.setAttribute('aria-pressed', String(handlers.onSound()));
  soundButton.setAttribute('aria-pressed', String(sound.on));
  soundButton.addEventListener('click', toggleSound);

  // Just the fire: every control hidden. Moving the pointer (or a tap) brings up a small button
  // to get them back for a moment; the pointer itself hides when it is still.
  let bare = false;
  let peekTimer = 0;
  const setBare = (on: boolean) => {
    bare = on;
    document.body.classList.toggle('bare', on);
    document.body.classList.remove('peek');
    if (on) hint('Move the pointer or press H to bring the controls back', 3);
  };
  const peek = () => {
    if (!bare) return;
    document.body.classList.add('peek');
    clearTimeout(peekTimer);
    peekTimer = window.setTimeout(() => document.body.classList.remove('peek'), 2500);
  };
  document.getElementById('bare')!.addEventListener('click', () => setBare(true));
  document.getElementById('show-controls')!.addEventListener('click', () => setBare(false));
  window.addEventListener('pointermove', peek);
  window.addEventListener('pointerdown', peek);

  window.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // (Not while the controls are out of use: behind the main page.)
    if (panel.closest('[inert]')) return;
    const key = e.key.toLowerCase();
    if (key === 'h') setBare(!bare);
    if (key === 'x') setScience(science.hidden !== false);
    if (key === 'escape' && bare) setBare(false);
    if (key === 'v') nextView();
    if (key === 'l') add();
    if (key === 'm') toggleSound();
    if (key === '1') chooseTool('tongs');
    if (key === '2') chooseTool('poker');
    if (key === '3') chooseTool('blow');
    if (key === '4') chooseTool('match');
    if (key === 'q') handlers.onTurn(-1);
    if (key === 'e') handlers.onTurn(1);
    if (key === 'w') handlers.onNudge(1);
    if (key === 's') handlers.onNudge(-1);
  });

  return {
    setRoom: (r) => {
      current = r;
      viewKey = r.views[0].key;
      roomSelect.input.value = r.key;
      offerRoom(r);
    },
    refresh: (s) => {
      for (const [key, r] of sliders) r.set(s.params[key]);
      for (const [key, r] of sciSliders) r.set(s.params[key]);
      world.input.value = worldOf(s.params.gravity);
      showSelect.input.value = String(s.params.debugView);
      Object.assign(overlay, s.overlay);
      gridCheck.input.checked = overlay.grid;
      flowCheck.input.checked = overlay.flow;
      slice.set(overlay.slice);
      slice.row.style.display = overlay.grid || overlay.flow ? '' : 'none';
      moisture.input.value = s.moisture === null ? '' : String(s.moisture);
      Object.assign(lighting, s.lighting);
      lamps.set(lighting.lamps);
      candles.input.value = lighting.candles ? 'lit' : 'out';
      time.input.value = lighting.time;
      Object.assign(sky, s.sky);
      moon.input.value = sky.moon ? 'shown' : 'hidden';
      figures.input.value = sky.constellations ? 'figures' : 'plain';
      detailSelect.input.value = s.detail;
      edgesSelect.input.value = s.smoothEdges ? 'smooth' : 'sharp';
      volume.set(s.volume);
      qualitySelect.input.value = s.quality;
      if (s.view) {
        viewKey = s.view;
        viewSelect.input.value = s.view;
      }
    },
    setStats: (text) => (stats.textContent = text),
    setReadouts: (lines) => {
      if (science.hidden) return;
      readouts.replaceChildren(...lines.map((line) => Object.assign(document.createElement('div'), { textContent: line })));
    },
    setQuality: (key) => (qualitySelect.input.value = key),
    setView: (key) => {
      viewKey = key;
      viewSelect.input.value = key;
    },
    setLogCount: (count, max) => {
      addLog.disabled = count >= max;
      addLog.title = count >= max ? 'The fire is full' : 'Put another log on the fire (L)';
    },
    setTool: (tool) => setTool(tool, false),
    hint,
    setHolding: (holding) => {
      if (holdBar.hidden === !holding) return;
      holdBar.hidden = !holding;
      if (!holding) clearInterval(repeat);
    },
    get bare() {
      return bare;
    },
  };
}

function flash(el: HTMLElement) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function option(value: string, text: string): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

/** A link that opens in a new tab. */
function link(text: string, href: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.textContent = text;
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function heading(text: string): HTMLElement {
  const h = document.createElement('div');
  h.className = 'section';
  h.textContent = text;
  return h;
}

function checkbox(text: string, title: string, onChange: (on: boolean) => void) {
  const label = document.createElement('label');
  label.className = 'check';
  label.title = title;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.addEventListener('change', () => onChange(input.checked));
  label.append(input, text);
  return { label, input };
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function percent(v: number): string {
  return `${Math.round(v * 100)}%`;
}

function range(
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  show: (v: number) => string,
  onInput: (v: number) => void,
  onCommit?: () => void,
  title?: string,
) {
  const row = document.createElement('label');
  row.className = 'row';
  if (title) row.title = title;
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  // The value as it reads (70%, 1.0×...): shown beside the slider, and what a screen reader says for
  // it. (A span, not an output: a label may hold only one control.)
  const out = document.createElement('span');
  out.className = 'value';
  out.setAttribute('aria-hidden', 'true');
  const shown = (v: number) => {
    const text = show(v);
    out.textContent = text;
    input.setAttribute('aria-valuetext', text);
  };
  shown(value);
  input.addEventListener('input', () => {
    const v = Number(input.value);
    shown(v);
    onInput(v);
  });
  if (onCommit) input.addEventListener('change', onCommit);
  row.append(name, input, out);
  const set = (v: number) => {
    input.value = String(v);
    shown(v);
  };
  return { row, input, set };
}

function select(label: string, options: [string, string][], value: string, onChange: (v: string) => void, title?: string) {
  const row = document.createElement('label');
  row.className = 'row';
  if (title) row.title = title;
  const name = document.createElement('span');
  name.textContent = label;
  const input = document.createElement('select');
  for (const [v, text] of options) input.append(option(v, text));
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  row.append(name, input);
  return { row, input };
}

function format(v: number): string {
  return Math.abs(v) >= 10 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toFixed(2);
}
