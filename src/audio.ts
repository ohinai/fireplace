// The fire's sound, synthesised with Web Audio and driven by the simulation. Mostly it is the
// wood: crackles as the char splits and fibres snap (more for resinous or wet wood), and now
// and then a sharp pop as a pocket of gas or steam bursts. Under that the flames flutter softly
// (a low flicker that grows with how much gas is burning), wet wood sighs as steam forces its
// way out, the coals tick, and logs thud, snap and crumble as they are moved about and burn
// through. None of the wood's sounds is a tone (real crackles are clicks and bursts of noise),
// and nothing hisses or rattles on and on: the crackles stand out from quiet. Outdoors the
// woods have their own sounds (nature.ts).

import { WOODS } from './config';
import { NatureSounds, type NatureTime, type NatureWild } from './nature';

export interface FireSoundState {
  flame: number; // how much flame there is (1 = a healthy fire)
  coals: number; // how brightly the coal bed glows (0..1)
  blow: number; // someone blowing on the fire (0..1)
  logs: { pan: number; gas: number; steam: number; wood: string }[]; // gas and steam in kg/s
  /** A kettle by the fire: how near the boil it is (0..1), how hard it boils (0..1). */
  kettle?: { warmth: number; boil: number; pan: number };
}

// How much each wood crackles and pops: resin and loose bark crackle, trapped water pops.
const VOICES: Record<string, { crackle: number; pop: number }> = {
  oak: { crackle: 1, pop: 1 },
  birch: { crackle: 1.3, pop: 1.1 },
  pine: { crackle: 1.8, pop: 2.2 },
  damp: { crackle: 0.6, pop: 1.6 },
  encina: { crackle: 0.9, pop: 0.8 },
  olivo: { crackle: 1, pop: 1.2 },
  mesquite: { crackle: 1.3, pop: 1.6 },
  pinon: { crackle: 1.9, pop: 2.2 },
  kindling: { crackle: 2.4, pop: 0.8 },
};

// Water per dry wood above which some of it is free, in the cells' cavities rather than bound in
// their walls. Free water boils and is forced out through the end grain, hissing; bound water
// seeps out as vapour, quietly, which is why seasoned wood doesn't hiss.
const FIBRE_SATURATION = 0.28;

type Grain = 'tick' | 'crackle' | 'pop' | 'bubble';
const GRAINS: Grain[] = ['tick', 'crackle', 'pop', 'bubble'];

export class FireAudio {
  /** A log popped (index into the state's logs): throw a few sparks from it. */
  onPop?: (log: number) => void;

  private ctx: AudioContext | null = null;
  private enabled = true;
  private volume = 0.7;
  private wild: NatureWild | null = null;
  private timeOfDay: NatureTime = 'night';
  private nature: NatureSounds | null = null;
  private out!: GainNode; // master volume
  private bus!: GainNode; // crackles, knocks and such: dry plus a little room
  private send!: GainNode; // how much of that goes to the room's echo
  private flame!: GainNode;
  private flameTone!: BiquadFilterNode;
  private flutter!: GainNode;
  private rumble!: GainNode;
  private breath!: GainNode;
  private sighUntil = 0; // one sigh of steam at a time, with a pause after it
  private grains: Record<Grain, AudioBuffer[]> = { tick: [], crackle: [], pop: [], bubble: [] };
  private simmer!: GainNode; // a kettle's water churning as it boils
  private pans: StereoPannerNode[] = []; // a fixed bank, so that each grain needn't make its own
  private white!: AudioBuffer;

  get running(): boolean {
    return this.enabled && this.ctx?.state === 'running';
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Starts the sound. Browsers only allow this from a click, tap or key press. */
  start() {
    if (!this.enabled) return;
    if (!this.ctx) this.build();
    void this.ctx!.resume();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    if (on) this.start();
    else void this.ctx?.suspend();
  }

  setVolume(v: number) {
    this.volume = v;
    if (this.ctx) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  /** The page was hidden or shown again. */
  setVisible(visible: boolean) {
    if (!this.ctx || !this.enabled) return;
    void (visible ? this.ctx.resume() : this.ctx.suspend());
  }

  /** Indoors (null: a room's echo) or out (no walls, and the sounds of the woods or the desert at that time of day). */
  setOutdoors(wild: NatureWild | null, time: NatureTime) {
    this.wild = wild;
    this.timeOfDay = time;
    this.applyPlace();
  }

  /** Something moving in the undergrowth, out in the dark (pan -1..1, how loud 0..1). */
  rustle(pan: number, loud: number) {
    if (this.running) this.nature?.rustle(pan, loud);
  }

  /** Knocks on a tree, far off in the woods. */
  woodKnocks(pan: number) {
    if (this.running) this.nature?.woodKnocks(pan);
  }

  private applyPlace() {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    this.send.gain.setTargetAtTime(this.wild ? 0.05 : 0.3, t, 0.2);
    this.nature?.setScene(this.wild, this.timeOfDay);
  }

  /** Follows the fire; call every frame with the real time since the last one. */
  update(state: FireSoundState, dt: number) {
    const ctx = this.ctx;
    if (!ctx || !this.running) return;
    const t = ctx.currentTime;
    const flame = Math.min(Math.max(state.flame, 0), 2.5);
    const level = 0.035 * flame;
    this.flame.gain.setTargetAtTime(level, t, 0.25);
    this.flutter.gain.setTargetAtTime(level * 1.5, t, 0.25);
    this.flameTone.frequency.setTargetAtTime(150 + 170 * Math.min(flame, 2), t, 0.3);
    this.rumble.gain.setTargetAtTime(0.03 * flame * flame, t, 0.5);
    this.breath.gain.setTargetAtTime(0.25 * state.blow, t, 0.04);

    // While wood gives off gas it crackles as the char splits, and pops when pockets of gas or
    // steam burst. Wet wood sighs now and then as steam forces its way out of the end grain.
    state.logs.forEach((log, i) => {
      const voice = VOICES[log.wood] ?? VOICES.oak;
      const gas = log.gas * 1000; // g/s
      const wet = log.steam * 1000;
      for (let n = poisson((10 * gas + 5 * wet) * voice.crackle * dt); n > 0; n--) {
        this.grain('crackle', log.pan, 0.9 * Math.random() ** 2.2, t + 0.02 + Math.random() * dt);
      }
      if (Math.random() < (0.15 * gas + 0.4 * wet) * voice.pop * dt) {
        this.grain('pop', log.pan, 0.55 + 0.45 * Math.random(), t + 0.03);
        this.onPop?.(i);
      }
      if (t > this.sighUntil && Math.random() < 0.6 * wet * freeWater(log.wood) * dt) {
        this.sighUntil = t + this.sigh(t + 0.02, log.pan) + 1 + 2 * Math.random();
      }
    });
    // A kettle: as it nears the boil, the first bubbles tick and burst against its hot bottom;
    // at the boil, the water churns and bubbles away (muffled: it is inside the kettle).
    const k = state.kettle;
    const warm = k ? Math.max(0, (k.warmth - 0.55) / 0.45) : 0;
    this.simmer.gain.setTargetAtTime(k ? 0.012 * k.boil : 0, t, 0.8);
    if (k) {
      for (let n = poisson((1.5 * warm * warm + 22 * k.boil) * dt); n > 0; n--) {
        this.grain('bubble', k.pan, (0.04 + 0.1 * Math.random()) * (0.4 + 0.6 * Math.max(warm, k.boil)), t + 0.02 + Math.random() * dt);
      }
    }
    // Glowing coals tick quietly as they shift and crack.
    for (let n = poisson(state.coals * 3 * dt); n > 0; n--) {
      this.grain('tick', (Math.random() - 0.5) * 0.6, 0.08 * Math.random() ** 2, t + 0.02 + Math.random() * dt);
    }
    this.nature?.update();
  }

  /** A match struck: a scratch, then the flare of the head catching. */
  strike(pan: number) {
    const t = this.now();
    if (t < 0) return;
    for (let i = 0; i < 3; i++) this.noise(t + i * 0.018, pan, 'bandpass', 2600 + 900 * Math.random(), 1.2, 0.12, 0.012);
    this.noise(t + 0.06, pan, 'highpass', 1800, 0.7, 0.16, 0.22, 0.03);
    this.noise(t + 0.08, pan, 'lowpass', 700, 0.7, 0.08, 0.3, 0.05);
  }

  /** A match blown out. */
  snuff(pan: number) {
    const t = this.now();
    if (t < 0) return;
    this.noise(t, pan, 'lowpass', 900, 0.7, 0.12, 0.05, 0.01);
  }

  /** A firelighter catching: a soft whump as its flame takes hold. */
  flare(pan: number) {
    const t = this.now();
    if (t < 0) return;
    this.noise(t, pan, 'lowpass', 260, 0.8, 0.35, 0.35, 0.06);
    this.thump(t, pan, 55, 0.15, 0.2);
  }

  /** A log hit something: the grate, another log, the hearth, or the poker. */
  knock(pan: number, strength: number, against: string, charred: number) {
    const t = this.now();
    if (t < 0) return;
    const s = Math.min(strength, 1.5);
    if (against === 'poker') {
      this.noise(t, pan, 'bandpass', 900 + 300 * Math.random(), 3, 0.3 * s, 0.03);
      this.ring(t, pan, [1650, 4150, 7300], [0.05 * s, 0.03 * s, 0.015 * s], [0.18, 0.1, 0.06]);
    } else if (against === 'iron') {
      this.thump(t, pan, 85, 0.45 * s, 0.12);
      this.noise(t, pan, 'bandpass', 320, 2, 0.45 * s, 0.05);
      this.ring(t, pan, [420, 1130, 2290, 3710], [0.07 * s, 0.045 * s, 0.03 * s, 0.02 * s], [0.5, 0.35, 0.2, 0.12]);
    } else if (against === 'log') {
      this.thump(t, pan, 110, 0.3 * s, 0.1);
      this.noise(t, pan, 'bandpass', 480, 2.5, 0.45 * s, 0.04);
    } else if (against === 'stone') {
      this.thump(t, pan, 95, 0.35 * s, 0.08);
      this.noise(t, pan, 'bandpass', 2300, 1.5, 0.3 * s, 0.012);
    } else if (against === 'ground') {
      this.thump(t, pan, 60, 0.35 * s, 0.12);
      this.noise(t, pan, 'lowpass', 400, 0.8, 0.3 * s, 0.05);
    } else {
      this.thump(t, pan, 70, 0.4 * s, 0.14);
      this.noise(t, pan, 'lowpass', 600, 1, 0.35 * s, 0.05);
    }
    // Charcoal crumbles and coals crunch.
    const crunch = against === 'coals' ? 1 : charred;
    if (crunch > 0.2) this.crunch(t, pan, Math.round(3 + 14 * s * crunch), 0.05 + 0.25 * s, 0.25 * s);
  }

  /** A burnt-through log snapping. */
  snap(pan: number) {
    const t = this.now();
    if (t < 0) return;
    this.noise(t, pan, 'highpass', 1500, 0.7, 0.7, 0.006);
    this.noise(t + 0.004, pan, 'bandpass', 700, 2, 0.35, 0.03);
    this.thump(t + 0.01, pan, 65, 0.35, 0.15);
    this.crunch(t, pan, 22, 0.5, 0.3);
  }

  /** What is left of a log collapsing into the coals. */
  crumble(pan: number, size: number) {
    const t = this.now();
    if (t < 0) return;
    const s = Math.min(size / 0.004, 1);
    this.noise(t, pan, 'lowpass', 350, 0.7, 0.25 * s + 0.05, 0.25, 0.02);
    this.crunch(t, pan, Math.round(10 + 20 * s), 0.8, 0.25);
  }

  /** Iron on iron: the poker against the grate. */
  clink(pan: number, strength: number) {
    const t = this.now();
    if (t < 0) return;
    const f = 780 + 200 * Math.random();
    const s = Math.min(strength, 1);
    this.ring(t, pan, [f, f * 2.76, f * 5.4, f * 8.93], [0.1 * s, 0.06 * s, 0.035 * s, 0.02 * s], [0.7, 0.45, 0.25, 0.12]);
    this.noise(t, pan, 'highpass', 3000, 0.7, 0.12 * s, 0.003);
  }

  /** The tongs closing on a log. */
  clack(pan: number) {
    const t = this.now();
    if (t < 0) return;
    this.ring(t, pan, [1250, 3300, 5200], [0.04, 0.025, 0.015], [0.15, 0.08, 0.05]);
    this.noise(t, pan, 'highpass', 2500, 0.7, 0.1, 0.004);
  }

  /** The poker raking through the coals. */
  stir(pan: number, amount: number) {
    const t = this.now();
    if (t < 0) return;
    this.crunch(t, pan, Math.round(2 + 6 * amount), 0.12, 0.18 * amount + 0.05);
    this.noise(t, pan, 'bandpass', 2200, 0.8, 0.05 * amount, 0.06);
  }

  // ---- Building blocks ----------------------------------------------------------------------

  private now(): number {
    return this.ctx && this.running ? this.ctx.currentTime + 0.01 : -1;
  }

  private build() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;
    const sr = ctx.sampleRate;
    this.white = noiseBuffer(ctx, 2, 'white');
    const pink = noiseBuffer(ctx, 4, 'pink');
    const brown = noiseBuffer(ctx, 4, 'brown');
    for (const kind of GRAINS) {
      for (let i = 0; i < (kind === 'pop' || kind === 'bubble' ? 16 : 24); i++) this.grains[kind].push(grainBuffer(ctx, kind, sr));
    }

    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -8;
    limiter.knee.value = 10;
    limiter.ratio.value = 4;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);
    this.out = gain(ctx, this.volume);
    this.out.connect(limiter);
    // A little of the room: knocks and crackles echo off the walls.
    const room = ctx.createConvolver();
    room.buffer = roomImpulse(ctx);
    this.send = gain(ctx, this.wild ? 0.05 : 0.3);
    this.send.connect(room).connect(this.out);
    this.bus = gain(ctx, 1);
    this.bus.connect(this.out);
    this.bus.connect(this.send);
    for (let i = 0; i <= 8; i++) {
      const p = ctx.createStereoPanner();
      p.pan.value = i / 4 - 1;
      p.connect(this.bus);
      this.pans.push(p);
    }

    const loop = (buffer: AudioBuffer) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      src.start(0, Math.random() * buffer.duration);
      return src;
    };
    const filter = (type: BiquadFilterType, frequency: number, Q = 0.7) => {
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = frequency;
      f.Q.value = Q;
      return f;
    };

    // Flames: a soft, low flutter, flickering a little several times a second (not a wind).
    this.flameTone = filter('lowpass', 300, 0.5);
    this.flame = gain(ctx, 0);
    loop(pink).connect(filter('highpass', 60)).connect(this.flameTone).connect(this.flame).connect(this.out);
    this.flutter = gain(ctx, 0);
    loop(brown).connect(filter('lowpass', 9)).connect(this.flutter).connect(this.flame.gain);
    // The low rumble of a big fire drawing hard.
    this.rumble = gain(ctx, 0);
    loop(brown).connect(filter('lowpass', 110)).connect(this.rumble).connect(this.out);
    // A kettle boiling: low churning water (only heard at the boil).
    this.simmer = gain(ctx, 0);
    const churn = filter('lowpass', 320, 0.7);
    loop(brown).connect(filter('highpass', 70)).connect(churn).connect(this.simmer).connect(this.out);
    // Breath, while someone blows on the fire.
    this.breath = gain(ctx, 0);
    loop(pink).connect(filter('bandpass', 900, 0.6)).connect(this.breath).connect(this.out);
    // The woods, for outdoors.
    this.nature = new NatureSounds(ctx, this.out);
    this.applyPlace();
  }

  private panned(pan: number): StereoPannerNode {
    const p = this.ctx!.createStereoPanner();
    p.pan.value = Math.min(Math.max(pan, -1), 1);
    p.connect(this.bus);
    return p;
  }

  private grain(kind: Grain, pan: number, level: number, when: number) {
    const ctx = this.ctx!;
    const list = this.grains[kind];
    const src = ctx.createBufferSource();
    src.buffer = list[Math.floor(Math.random() * list.length)];
    src.playbackRate.value = 0.85 + 0.35 * Math.random();
    const p = Math.min(Math.max(pan + (Math.random() - 0.5) * 0.3, -1), 1);
    src.connect(gain(ctx, level)).connect(this.pans[Math.round((p + 1) * 4)]);
    src.start(when);
  }

  /**
   * Steam forcing its way out of wet wood: a soft hiss that swells, then dies away and drops a
   * little as the pocket empties. Smooth, with no flutter. Returns how long it lasts.
   */
  private sigh(when: number, pan: number): number {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    const rise = 0.25 + 0.3 * Math.random();
    const fade = 0.3 + 0.4 * Math.random();
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.9;
    const f0 = 2200 + 1800 * Math.random();
    f.frequency.setValueAtTime(f0, when);
    f.frequency.exponentialRampToValueAtTime(f0 * 0.85, when + rise + fade * 3);
    src.connect(f).connect(envelope(ctx, when, 0.02 + 0.02 * Math.random(), rise, fade)).connect(this.panned(pan));
    src.start(when, Math.random() * 1.5);
    src.stop(when + rise + fade * 7);
    return rise + fade * 3;
  }

  /** A burst of filtered noise with a sharp attack and exponential decay. */
  private noise(when: number, pan: number, type: BiquadFilterType, frequency: number, Q: number, level: number, decay: number, attack = 0.001) {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = Q;
    const env = envelope(ctx, when, level, attack, decay);
    src.connect(f).connect(env).connect(this.panned(pan));
    src.start(when, Math.random() * 1.5);
    src.stop(when + attack + decay * 7);
  }

  /** A low, falling sine: the body of a heavy knock. */
  private thump(when: number, pan: number, frequency: number, level: number, decay: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(frequency * 1.4, when);
    osc.frequency.exponentialRampToValueAtTime(frequency, when + 0.06);
    osc.connect(envelope(ctx, when, level, 0.003, decay)).connect(this.panned(pan));
    osc.start(when);
    osc.stop(when + decay * 7);
  }

  /** Decaying partials: struck iron. */
  private ring(when: number, pan: number, freqs: number[], levels: number[], decays: number[]) {
    const ctx = this.ctx!;
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      osc.frequency.value = f * (1 + (Math.random() - 0.5) * 0.01);
      osc.connect(envelope(ctx, when, levels[i], 0.001, decays[i])).connect(this.panned(pan));
      osc.start(when);
      osc.stop(when + decays[i] * 7);
    });
  }

  /** Charcoal crunching: a quick scatter of crackles. */
  private crunch(when: number, pan: number, count: number, spread: number, level: number) {
    for (let i = 0; i < count; i++) this.grain('crackle', pan, level * (0.2 + 0.8 * Math.random() ** 2), when + Math.random() ** 1.5 * spread);
  }
}

function gain(ctx: AudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function envelope(ctx: AudioContext, when: number, level: number, attack: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level, when + attack);
  g.gain.setTargetAtTime(0, when + attack, decay);
  return g;
}

function noiseBuffer(ctx: AudioContext, seconds: number, colour: 'white' | 'pink' | 'brown'): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    if (colour === 'white') {
      d[i] = w * 0.5;
    } else if (colour === 'pink') {
      // Paul Kellet's filter.
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  }
  // Cross-fade the end into the start so the loop has no seam.
  const fade = 2048;
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    d[i] = d[i] * k + d[n - fade + i] * (1 - k);
  }
  const out = ctx.createBuffer(1, n - fade, ctx.sampleRate);
  out.copyToChannel(d.subarray(0, n - fade), 0);
  return out;
}

/** Share of the steam from this wood that is free water, forced out hissing (see FIBRE_SATURATION). */
function freeWater(wood: string): number {
  const m = WOODS[wood]?.moisture ?? 0;
  return m > FIBRE_SATURATION ? 1 - FIBRE_SATURATION / m : 0;
}

/**
 * One grain of fire sound, made of clicks: short bursts of noise, as wood fibres snapping and
 * gas bursting out are. A tick is a coal cracking; a crackle, a few cracks in quick succession
 * with a little of the wood's broad colour; a pop, a pocket of gas or steam bursting: a sharp
 * crack (often doubled), a dull thud in the wood, a scatter of smaller cracks as it splits, and
 * sometimes a breath of escaping gas.
 */
function grainBuffer(ctx: AudioContext, kind: Grain, sr: number): AudioBuffer {
  const dur = { tick: 0.015, crackle: 0.07, pop: 0.35, bubble: 0.06 }[kind];
  const n = Math.floor(sr * dur);
  const d = new Float32Array(n);
  const click = (buf: Float32Array, at: number, amp: number, decay: number) => {
    for (let i = Math.floor(at * sr); i < n; i++) {
      const e = Math.exp(-(i / sr - at) / decay);
      if (e < 1e-3) break;
      buf[i] += amp * (Math.random() * 2 - 1) * e;
    }
  };
  const peakOf = (buf: Float32Array) => buf.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-6);
  if (kind === 'bubble') {
    // A bubble bursting in hot water, heard through the kettle's side: a soft, dull blup.
    click(d, 0.001, 1, 0.012 + 0.012 * Math.random());
    biquad(d, sr, 'bandpass', 260 + 380 * Math.random(), 4);
    biquad(d, sr, 'lowpass', 900, 0.7);
  } else if (kind === 'tick') {
    click(d, 0.0005, 1, 0.0004 + 0.0004 * Math.random());
    biquad(d, sr, 'bandpass', 2500 + 4500 * Math.random(), 2);
  } else if (kind === 'crackle') {
    const count = 2 + Math.floor(Math.random() ** 1.5 * 8);
    let at = 0.0005;
    for (let c = 0; c < count && at < dur - 0.012; c++) {
      click(d, at, c === 0 ? 1 : 0.2 + 0.7 * Math.random(), 0.00008 + 0.0005 * Math.random());
      at += 0.0008 + Math.random() ** 2 * 0.012;
    }
    // The wood's own colour: broad (low Q), so it tints the cracks without ringing a note.
    const body = d.slice();
    biquad(body, sr, 'bandpass', 900 + 1800 * Math.random(), 0.9);
    for (let i = 0; i < n; i++) d[i] = 0.7 * d[i] + 0.8 * body[i];
    biquad(d, sr, 'highpass', 350, 0.7);
  } else {
    click(d, 0.0005, 1, 0.0012 + 0.0015 * Math.random());
    if (Math.random() < 0.6) click(d, 0.0015 + 0.004 * Math.random(), 0.6, 0.0008);
    const thud = new Float32Array(n);
    click(thud, 0.0005, 1, 0.006 + 0.006 * Math.random());
    biquad(thud, sr, 'lowpass', 180 + 220 * Math.random(), 0.7);
    const thudPeak = peakOf(thud);
    for (let i = 0; i < n; i++) d[i] += (0.45 * thud[i]) / thudPeak;
    for (let c = 3 + Math.floor(Math.random() * 10); c > 0; c--) {
      click(d, 0.01 + Math.random() ** 1.6 * 0.25, 0.08 + 0.3 * Math.random(), 0.0002 + 0.0006 * Math.random());
    }
    if (Math.random() < 0.5) {
      const breath = new Float32Array(n);
      click(breath, 0.004, 1, 0.06 + 0.08 * Math.random());
      biquad(breath, sr, 'highpass', 2000 + 2000 * Math.random(), 0.7);
      const breathPeak = peakOf(breath);
      for (let i = 0; i < n; i++) d[i] += (0.07 * breath[i]) / breathPeak;
    }
    biquad(d, sr, 'highpass', 60, 0.7);
  }
  const peak = peakOf(d);
  for (let i = 0; i < n; i++) d[i] *= 0.9 / peak;
  const buf = ctx.createBuffer(1, n, sr);
  buf.copyToChannel(d, 0);
  return buf;
}

/** In-place biquad filter (RBJ cookbook). */
function biquad(d: Float32Array, sr: number, type: 'bandpass' | 'highpass' | 'lowpass', f: number, Q: number) {
  const w0 = (2 * Math.PI * f) / sr;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Q);
  const a0 = 1 + alpha;
  const [b0, b1, b2] =
    type === 'bandpass' ? [alpha, 0, -alpha] : type === 'highpass' ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2] : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    d[i] = y;
  }
}

/** Impulse response of a small, soft room. */
function roomImpulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 1.2);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      lp += (Math.random() * 2 - 1 - lp) * 0.3;
      d[i] = lp * Math.exp(-t / 0.25) * Math.min(t / 0.006, 1);
    }
  }
  return buf;
}

function poisson(lambda: number): number {
  if (lambda <= 0) return 0;
  if (lambda > 30) return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * (Math.random() + Math.random() + Math.random() - 1.5) * 2));
  const limit = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= Math.random();
  } while (p > limit);
  return k - 1;
}
