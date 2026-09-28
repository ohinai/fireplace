import type { Vec3 } from './math';

// World space is in metres, y up. In the fireplaces the opening sits in the z = 0 plane and the
// firebox extends toward -z; the camera looks at it from +z. The campfire is centred on the origin.

// The firebox behind the opening (the opening itself depends on the room: see rooms.ts).
export const FIREBOX = {
  frontHalfWidth: 0.42, // half width at the front
  backHalfWidth: 0.3, // side walls splay inward toward the back
  depth: 0.42,
  height: 0.84, // top of the firebox (throat to the flue)
};

// The throat: the only way out at the top of the firebox, a slot just behind the lintel. Its
// size limits how much air the fire can pull through (about 1/10 of the opening area, as in real
// fireplaces). depth is measured back from the front of the grid.
export const THROAT = { halfWidth: 0.3, depth: 0.12 };

export interface Quality {
  label: string;
  cells: number; // grid cells to spend on the air (the grid's shape follows the room)
  pressureIterations: number;
  pixels: number; // most pixels to draw (the picture is scaled up beyond that)
  smooth?: boolean; // draw the fire from its grid with a smooth (tricubic) filter, not a trilinear one
  traceCells?: number; // trace the flow back in steps of at most this many cells (unset: in one step)
  fps?: number; // the most frames a second to draw (the fire is still worked out sixty times a second)
  logEvery?: number; // work out the insides of the logs every this many steps (every step unless given)
  flameDetail?: number; // how much fine detail to draw into the flames, finer than the grid (0..1: see volume.wgsl)
}

/** The fire's time step (s): it is simulated sixty times a second of its own time. */
export const SIM_DT = 1 / 60;

export const QUALITY: Record<string, Quality> = {
  // For phones and weak graphics cards: a coarse grid (15 mm cells in a fireplace), fewer pressure
  // sweeps to match, a small picture (scaled up to fill the screen) drawn thirty times a second,
  // and the insides of the logs worked out every fourth step (they change slowly). About a tenth
  // of the work of Medium. (Not fewer physics steps: with fewer, a teepee of logs slowly slumps.)
  low: { label: 'Low', cells: 48 * 54 * 24, pressureIterations: 12, pixels: 400_000, fps: 30, logEvery: 4, flameDetail: 1 },
  medium: { label: 'Medium', cells: 96 * 108 * 48, pressureIterations: 20, pixels: 2_400_000 },
  high: { label: 'High', cells: 128 * 144 * 64, pressureIterations: 24, pixels: 2_400_000 },
  // For the fastest graphics cards there are (and those to come): nearly seven times the cells of
  // High (3 mm across, in a fireplace), drawn with a smooth filter so that close up no trace of
  // the grid shows in the flames; sharp on a 4K screen. About a gigabyte of graphics memory.
  // (As many cells as a WebGPU buffer of the per-cell swirl allows without asking for more:
  // 128 MiB at 16 bytes a cell.)
  ultra: { label: 'Ultra', cells: 240 * 270 * 120, pressureIterations: 44, pixels: 8_300_000, smooth: true, traceCells: 2.5 },
};

/**
 * How much there is round the fire (furniture, ornaments, trees): less is quicker to draw.
 * The fire itself is the same at every level.
 */
export type Detail = 'low' | 'medium' | 'high';
export const DETAILS: [Detail, string][] = [
  ['low', 'Simple'],
  ['medium', 'Furnished'],
  ['high', 'Full'],
];

// Log model resolution (must match logs_shared.wgsl).
export const LOG_GRID = { nx: 24, ns: 48, nt: 32, maxLogs: 24 };

export interface Wood {
  label: string;
  short: string; // (for a reading on a log)
  density: number; // dry wood, kg/m3
  moisture: number; // water per dry wood, by mass
  charYield: number; // share of dry wood left as charcoal after the gas is driven off
  bark: [number, number, number];
  heart: number; // how dark its heartwood is, 0 (pale right through) to 1
  /** Sticks rather than logs: radius and length (m) of a piece put on the fire. */
  size?: { radius: [number, number]; length: [number, number] };
  crooked?: number; // how much it twists and kinks along its length (0 straight)
}

export const WOODS: Record<string, Wood> = {
  oak: { short: 'Oak', label: 'Oak, seasoned', density: 650, moisture: 0.15, charYield: 0.26, bark: [0.2, 0.15, 0.11], heart: 0.7 },
  birch: { short: 'Birch', label: 'Birch, seasoned', density: 600, moisture: 0.17, charYield: 0.24, bark: [0.66, 0.64, 0.6], heart: 0.12 },
  pine: { short: 'Pine', label: 'Pine, dry', density: 450, moisture: 0.12, charYield: 0.2, bark: [0.3, 0.18, 0.1], heart: 0.45 },
  damp: { short: 'Damp', label: 'Damp wood', density: 550, moisture: 0.45, charYield: 0.25, bark: [0.15, 0.12, 0.09], heart: 0.55 },
  // Spanish and Mexican firewood: dense holm oak and olive burn slow and hot; mesquite leaves
  // fierce coals; resinous piñon crackles and smells wonderful.
  encina: { short: 'Encina', label: 'Holm oak (encina)', density: 820, moisture: 0.15, charYield: 0.28, bark: [0.19, 0.17, 0.15], heart: 0.8 },
  olivo: { short: 'Olive', label: 'Olive wood', density: 800, moisture: 0.14, charYield: 0.27, bark: [0.34, 0.31, 0.25], heart: 0.6 },
  mesquite: { short: 'Mesquite', label: 'Mesquite', density: 780, moisture: 0.12, charYield: 0.29, bark: [0.24, 0.13, 0.08], heart: 0.92 },
  pinon: { short: 'Piñon', label: 'Piñon pine', density: 560, moisture: 0.12, charYield: 0.21, bark: [0.33, 0.26, 0.2], heart: 0.5 },
  // Thin sticks of split, bone-dry softwood: they catch from a small flame and burn out fast.
  kindling: { short: 'Kindling', label: 'Kindling', density: 440, moisture: 0.08, charYield: 0.18, bark: [0.6, 0.46, 0.31], heart: 0.25 },
  // Desert wood, gathered as dead branches: thin, twisted, bleached grey and bone dry. Acacia is
  // dense and burns hot; tamarisk lighter and quicker; ghada (saxaul), the Bedouin's favourite,
  // is heavy as coal and burns long, leaving fierce embers.
  acacia: {
    short: 'Acacia', label: 'Acacia branches', density: 830, moisture: 0.07, charYield: 0.28, bark: [0.42, 0.38, 0.33], heart: 0.85,
    size: { radius: [0.014, 0.024], length: [0.34, 0.42] }, crooked: 1,
  },
  tamarisk: {
    short: 'Tamarisk', label: 'Tamarisk branches', density: 620, moisture: 0.08, charYield: 0.24, bark: [0.47, 0.42, 0.37], heart: 0.5,
    size: { radius: [0.012, 0.02], length: [0.32, 0.4] }, crooked: 0.8,
  },
  ghada: {
    short: 'Ghada', label: 'Ghada (saxaul)', density: 950, moisture: 0.06, charYield: 0.3, bark: [0.55, 0.52, 0.46], heart: 0.7,
    size: { radius: [0.018, 0.028], length: [0.3, 0.38] }, crooked: 1.2,
  },
};

// Height of the coal layer the air above it feels (m).
export const BED_HEIGHT = 0.02;

// The grate the logs rest on.
export const GRATE = { minX: -0.24, maxX: 0.24, minZ: -0.33, maxZ: -0.09, top: 0.039 };

/**
 * The grate's bars turn up at both ends, which keeps logs from rolling off: (bottom, top) of each
 * upturned end, taller at the back.
 */
export function grateFingers(): [Vec3, Vec3][] {
  const out: [Vec3, Vec3][] = [];
  for (let i = 0; i < 8; i++) {
    const x = -0.21 + i * 0.06;
    out.push([[x, 0.034, GRATE.maxZ + 0.004], [x, 0.16, GRATE.maxZ + 0.02]]);
    out.push([[x, 0.034, GRATE.minZ - 0.004], [x, 0.14, GRATE.minZ - 0.018]]);
  }
  return out;
}

export interface Params {
  gravity: number; // m/s2: what makes hot air rise, logs fall and sparks drop
  // air
  draft: number; // speed at which the chimney pulls gas through the throat (m/s)
  expansion: number; // how much burning gas expands (1 = ideal gas)
  buoyancy: number;
  vorticity: number;
  turbulence: number;
  damping: number;
  // combustion
  burnRate: number;
  ignitionTemp: number;
  heatRelease: number;
  stoich: number;
  sootYield: number;
  sootBurn: number;
  cooling: number;
  smokeYield: number;
  smokeDecay: number;
  // logs
  burnSpeed: number; // time-lapse for the logs and coals (1 = real time)
  flameRadiation: number; // scales the flames' radiation onto the logs
  // look
  emission: number;
  absorption: number;
  smoke: number;
  blueGlow: number;
  glowBoost: number; // K added to glowing surfaces for display (see Renderer)
  haze: number; // heat haze strength
  sparks: number; // sparks thrown off hot char per second
  smoothing: number; // how much the fire is averaged over frames (0..1)
  exposure: number;
  lightGain: number;
  bloom: number;
  saturation: number; // colour: 0 grey, 1 as it is, 2 richer
  starlight: number; // outdoors: how much the stars and the Milky Way are brought out (0 as the eye sees them)
  debugView: number;
}

export const DEFAULT_PARAMS: Params = {
  gravity: 9.81,
  draft: 2.1,
  expansion: 0,
  buoyancy: 0.6,
  vorticity: 8,
  turbulence: 6,
  damping: 0.2,
  // Wood gas needs ~4 volumes of air to burn and a stoichiometric mix heats by ~1600 K.
  // Burning is fast, so it happens in thin sheets where fuel meets air (mixing-limited).
  burnRate: 150,
  ignitionTemp: 620,
  heatRelease: 8000,
  stoich: 4,
  sootYield: 1.5,
  sootBurn: 8,
  cooling: 60,
  smokeYield: 1.5,
  smokeDecay: 0.15,
  burnSpeed: 1,
  flameRadiation: 0.8,
  emission: 30,
  absorption: 3,
  smoke: 25,
  blueGlow: 0.3,
  glowBoost: 100,
  haze: 14,
  sparks: 40,
  smoothing: 1,
  exposure: 4,
  lightGain: 0.25,
  bloom: 0.03,
  saturation: 1,
  starlight: 1.3,
  debugView: 0,
};

export const AMBIENT_TEMP = 300;
