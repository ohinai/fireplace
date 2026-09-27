// The woods round the campfire, synthesised: a breeze in the pines with now and then a gust,
// rustles and twig snaps in the undergrowth; after dark crickets and katydids close by, a chorus
// of spring peepers and a bullfrog off by the water, a great horned owl, and once in a long
// while wolves howling far away; by day songbirds, a woodpecker and a crow. Distant calls are
// sent through a long forest echo. The desert is quieter still: only a breath of wind now and
// then over the sand.

export type NatureTime = 'night' | 'dusk' | 'day';
export type NatureWild = 'woods' | 'desert';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

interface Caller {
  next: number; // context time of its next call
  pitch: number;
  pan: number;
  level: number;
}

export class NatureSounds {
  private readonly near: GainNode; // close by: mostly dry
  private readonly far: GainNode; // across the clearing and beyond: mostly echo
  private readonly breeze: GainNode;
  private readonly white: AudioBuffer;
  private outdoors = false;
  private wild: NatureWild = 'woods';
  private time: NatureTime = 'night';
  private crickets: Caller[] = [];
  private katydids: Caller[] = [];
  private peepers: Caller[] = [];
  private next: Record<string, number> = {};

  constructor(
    private readonly ctx: AudioContext,
    destination: AudioNode,
  ) {
    const out = gain(ctx, 1);
    out.connect(destination);
    const echo = ctx.createConvolver();
    echo.buffer = forestImpulse(ctx);
    echo.connect(out);
    this.near = gain(ctx, 1);
    this.near.connect(out);
    this.near.connect(gain(ctx, 0.12)).connect(echo);
    this.far = gain(ctx, 0.3);
    this.far.connect(out);
    const farSend = gain(ctx, 0.9);
    this.far.connect(farSend).connect(echo);
    this.white = whiteNoise(ctx, 2);

    // The breeze in the pines, a quiet hush rising and falling gently (under the fire, not over it).
    this.breeze = gain(ctx, 0);
    const gusts = gain(ctx, 1);
    const air = ctx.createBufferSource();
    air.buffer = pinkNoise(ctx, 4);
    air.loop = true;
    air.start(0, Math.random() * 3);
    air.connect(filter(ctx, 'bandpass', 520, 0.5)).connect(gusts).connect(this.breeze).connect(out);
    const swell = ctx.createBufferSource();
    swell.buffer = pinkNoise(ctx, 4);
    swell.loop = true;
    swell.playbackRate.value = 0.03;
    swell.start();
    swell.connect(filter(ctx, 'lowpass', 1.5, 0.7)).connect(gain(ctx, 2.5)).connect(gusts.gain);

    const now = ctx.currentTime;
    this.crickets = [0, 1, 2, 3].map((i) => ({ next: now + Math.random(), pitch: rand(4200, 4900), pan: -0.8 + 0.53 * i + rand(-0.1, 0.1), level: rand(0.004, 0.009) }));
    this.katydids = [0, 1].map((i) => ({ next: now + 0.55 * i + Math.random() * 0.2, pitch: rand(5200, 6400), pan: i ? 0.6 : -0.5, level: rand(0.01, 0.016) }));
    this.peepers = [0, 1, 2, 3, 4, 5].map(() => ({ next: now + Math.random() * 1.5, pitch: rand(2650, 3000), pan: rand(-0.9, 0.9), level: rand(0.006, 0.014) }));
    for (const k of ['owl', 'howl', 'frog', 'rustle', 'gust', 'bird', 'woodpecker', 'crow']) this.next[k] = now + rand(5, 30);
    this.next.howl = now + rand(90, 240);
  }

  /** Indoors (null: quiet) or out in the woods or the desert, and at what time of day. */
  setScene(wild: NatureWild | null, time: NatureTime) {
    this.outdoors = wild !== null;
    this.wild = wild ?? 'woods';
    this.time = time;
    // Over open sand the breeze is only a breath: nothing to sigh through.
    const level = !wild ? 0 : wild === 'desert' ? 0.004 : time === 'day' ? 0.011 : 0.007;
    this.breeze.gain.setTargetAtTime(level, this.ctx.currentTime, 1);
  }

  /** Something moving in the undergrowth (pan -1..1, how loud 0..1). */
  rustle(pan: number, loud: number) {
    if (!this.outdoors || this.wild !== 'woods') return;
    const t = this.ctx.currentTime + 0.02;
    const n = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      this.noise(t + Math.random() * 0.9, rand(0.04, 0.12), loud * rand(0.015, 0.04), 'bandpass', rand(1800, 4200), 0.9, pan + rand(-0.1, 0.1), this.near);
    }
    if (Math.random() < 0.45) this.snap(t + rand(0.1, 0.8), pan, loud);
  }

  /** Knocks on a tree, far off in the woods: two or three, slow and deliberate. (Something big.) */
  woodKnocks(pan: number) {
    if (!this.outdoors || this.wild !== 'woods') return;
    const t = this.ctx.currentTime + 0.05;
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const at = t + i * rand(0.55, 0.85);
      this.tone(at, 230, 140, 0.1, 0.06, pan, 'sine', this.far, 0.002);
      this.noise(at, 0.035, 0.045, 'bandpass', 850, 2.5, pan, this.far);
    }
  }

  /** Call every frame. */
  update() {
    if (!this.outdoors) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (this.wild === 'desert') {
      if (this.due('gust', t)) {
        this.gust(t + 0.05);
        this.next.gust = t + rand(40, 100);
      }
      return;
    }
    const soon = t + 0.25;
    const night = this.time === 'night';
    const dusk = this.time === 'dusk';

    if (night || dusk) {
      const crickets = dusk ? this.crickets.slice(0, 2) : this.crickets;
      for (const c of crickets) {
        if (c.next > soon) continue;
        const at = Math.max(c.next, t + 0.02);
        this.chirp(at, c);
        c.next = at + rand(0.45, 1.05) + (Math.random() < 0.06 ? rand(2, 6) : 0);
      }
      for (const p of this.peepers) {
        if (p.next > soon) continue;
        const at = Math.max(p.next, t + 0.02);
        this.tone(at, p.pitch * 0.92, p.pitch * 1.06, 0.13, p.level, p.pan, 'sine', this.far, 0.02);
        p.next = at + rand(0.8, 1.6) + (Math.random() < 0.1 ? rand(3, 8) : 0);
      }
    }
    if (night) {
      for (const k of this.katydids) {
        if (k.next > soon) continue;
        const at = Math.max(k.next, t + 0.02);
        for (let i = 0; i < 3; i++) this.noise(at + i * 0.11, 0.045, k.level, 'bandpass', k.pitch, 6, k.pan, this.near);
        k.next = at + rand(1.0, 1.25);
      }
      if (this.due('owl', t)) {
        this.owl(t + 0.05, rand(-0.8, 0.8));
        this.next.owl = t + rand(40, 120);
      }
      if (this.due('frog', t)) {
        this.bullfrog(t + 0.05, rand(-0.9, 0.9));
        this.next.frog = t + rand(25, 70);
      }
      if (this.due('howl', t)) {
        this.howl(t + 0.05, rand(-0.9, 0.9));
        this.next.howl = t + rand(180, 420);
      }
    }
    if (!night && this.due('bird', t)) {
      this.songbird(t + 0.05, rand(-0.9, 0.9), dusk);
      this.next.bird = t + (dusk ? rand(8, 20) : rand(2.5, 8));
    }
    if (this.time === 'day') {
      if (this.due('woodpecker', t)) {
        this.woodpecker(t + 0.05, rand(-0.9, 0.9));
        this.next.woodpecker = t + rand(30, 90);
      }
      if (this.due('crow', t)) {
        this.crow(t + 0.05, rand(-0.9, 0.9));
        this.next.crow = t + rand(40, 120);
      }
    }
    if (this.due('rustle', t)) {
      this.rustle(rand(-0.9, 0.9), rand(0.3, 0.8));
      this.next.rustle = t + rand(20, 60);
    }
    if (this.due('gust', t)) {
      this.gust(t + 0.05);
      this.next.gust = t + rand(50, 110);
    }
  }

  private due(what: string, t: number): boolean {
    return (this.next[what] ?? 0) <= t;
  }

  // ---- The creatures ---------------------------------------------------------------------

  /** A cricket's chirp: a few quick pulses of one pure, high tone. */
  private chirp(when: number, c: Caller) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.value = c.pitch * (1 + rand(-0.002, 0.002));
    const env = ctx.createGain();
    env.gain.setValueAtTime(0, when);
    const pulses = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < pulses; i++) {
      const at = when + i * 0.03;
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(c.level, at + 0.003);
      env.gain.setValueAtTime(c.level, at + 0.014);
      env.gain.linearRampToValueAtTime(0, at + 0.018);
    }
    osc.connect(env).connect(panner(ctx, c.pan)).connect(this.near);
    osc.start(when);
    osc.stop(when + pulses * 0.03 + 0.02);
  }

  /** A great horned owl: hoo, h'hoo-hoo, hoo, hoo. */
  private owl(when: number, pan: number) {
    const f = rand(270, 320);
    const notes: [number, number][] = [[0, 0.42], [0.62, 0.12], [0.8, 0.13], [1.28, 0.46], [2.2, 0.48]];
    for (const [at, dur] of notes) {
      this.tone(when + at, f * 1.02, f * 0.95, dur, 0.05, pan, 'sine', this.far, 0.05);
      this.tone(when + at, f * 2.04, f * 1.9, dur, 0.008, pan, 'sine', this.far, 0.05);
    }
  }

  /** A bullfrog by the water: jug-o-rum, low and buzzing. */
  private bullfrog(when: number, pan: number) {
    const ctx = this.ctx;
    const notes: [number, number, number][] = [[0, 0.22, 120], [0.3, 0.16, 105], [0.52, 0.45, 95]];
    for (const [at, dur, f] of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = f;
      const buzz = ctx.createGain();
      buzz.gain.value = 0.5;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 32;
      const depth = gain(ctx, 0.5);
      lfo.connect(depth).connect(buzz.gain);
      const env = envelope(ctx, when + at, 0.05, 0.03, dur);
      osc.connect(filter(ctx, 'lowpass', 420, 1.2)).connect(buzz).connect(env).connect(panner(ctx, pan)).connect(this.far);
      for (const o of [osc, lfo]) {
        o.start(when + at);
        o.stop(when + at + dur + 0.2);
      }
    }
  }

  /** Wolves, far off: one howl, sometimes a second joining in. */
  private howl(when: number, pan: number) {
    const voice = (at: number, base: number, level: number) => {
      const ctx = this.ctx;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      const f = osc.frequency;
      f.setValueAtTime(base * 0.62, at);
      f.exponentialRampToValueAtTime(base, at + 0.7);
      f.setValueAtTime(base, at + 0.7);
      f.linearRampToValueAtTime(base * 0.97, at + 2.3);
      f.exponentialRampToValueAtTime(base * 0.66, at + 3.2);
      const vib = ctx.createOscillator();
      vib.frequency.value = 5.3;
      const vibDepth = gain(ctx, base * 0.012);
      vib.connect(vibDepth).connect(f);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(level, at + 0.5);
      env.gain.setValueAtTime(level, at + 2.2);
      env.gain.linearRampToValueAtTime(0, at + 3.3);
      osc.connect(filter(ctx, 'lowpass', 1400, 0.7)).connect(env).connect(panner(ctx, pan)).connect(this.far);
      for (const o of [osc, vib]) {
        o.start(at);
        o.stop(at + 3.5);
      }
    };
    const base = rand(520, 600);
    voice(when, base, 0.03);
    if (Math.random() < 0.4) voice(when + rand(0.8, 1.6), base * rand(1.12, 1.26), 0.022);
  }

  /** A songbird's phrase: quick whistled notes, slurred up or down. By dusk, slower and fewer. */
  private songbird(when: number, pan: number, dusk: boolean) {
    const base = rand(2400, 4200);
    const notes = dusk ? 2 + Math.floor(Math.random() * 3) : 3 + Math.floor(Math.random() * 6);
    let at = when;
    for (let i = 0; i < notes; i++) {
      const dur = rand(0.05, 0.14);
      const f0 = base * rand(0.8, 1.3);
      this.tone(at, f0, f0 * rand(0.7, 1.4), dur, rand(0.006, 0.014), pan, 'sine', this.far, 0.008);
      at += dur + rand(0.02, 0.09);
    }
  }

  /** A woodpecker drumming on a dead trunk somewhere. */
  private woodpecker(when: number, pan: number) {
    const n = 14 + Math.floor(Math.random() * 8);
    for (let i = 0; i < n; i++) {
      this.noise(when + i / 17, 0.012, 0.05 * (1 - (i / n) * 0.6), 'bandpass', 1300, 3, pan, this.far);
    }
  }

  /** A crow, cawing a few times. */
  private crow(when: number, pan: number) {
    const n = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const at = when + i * rand(0.45, 0.6);
      this.tone(at, 780, 620, 0.28, 0.02, pan, 'sawtooth', this.far, 0.02, 1400);
      this.noise(at, 0.28, 0.01, 'bandpass', 900, 1.5, pan, this.far);
    }
  }

  /** A gust through the pines: a rising and falling hush of needles. */
  private gust(when: number) {
    const dur = rand(2, 4);
    const src = this.ctx.createBufferSource();
    src.buffer = this.white;
    src.loop = true;
    const env = this.ctx.createGain();
    const level = this.time === 'day' ? 0.008 : 0.005;
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(level, when + dur * 0.45);
    env.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(filter(this.ctx, 'bandpass', rand(2500, 4500), 0.6)).connect(env).connect(panner(this.ctx, rand(-0.6, 0.6))).connect(this.far);
    src.start(when, Math.random());
    src.stop(when + dur + 0.1);
  }

  /** A dry twig snapping underfoot. */
  private snap(when: number, pan: number, loud: number) {
    this.noise(when, 0.008, 0.08 * loud, 'bandpass', 2200, 2, pan, this.near);
    this.noise(when + 0.004, 0.03, 0.03 * loud, 'bandpass', 900, 3, pan, this.near);
  }

  // ---- Building blocks -------------------------------------------------------------------

  /** A tone gliding from f0 to f1. */
  private tone(when: number, f0: number, f1: number, dur: number, level: number, pan: number, type: OscillatorType, dest: AudioNode, attack: number, lowpass?: number) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), when + dur);
    let src: AudioNode = osc;
    if (lowpass) src = osc.connect(filter(ctx, 'lowpass', lowpass, 0.8));
    src.connect(envelope(ctx, when, level, attack, dur)).connect(panner(ctx, pan)).connect(dest);
    osc.start(when);
    osc.stop(when + dur + attack + 0.05);
  }

  private noise(when: number, dur: number, level: number, type: BiquadFilterType, frequency: number, Q: number, pan: number, dest: AudioNode) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.white;
    src.connect(filter(ctx, type, frequency, Q)).connect(envelope(ctx, when, level, 0.002, dur)).connect(panner(ctx, pan)).connect(dest);
    src.start(when, Math.random() * 1.5);
    src.stop(when + dur + 0.05);
  }
}

function gain(ctx: AudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function filter(ctx: AudioContext, type: BiquadFilterType, frequency: number, Q: number): BiquadFilterNode {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  return f;
}

function panner(ctx: AudioContext, pan: number): StereoPannerNode {
  const p = ctx.createStereoPanner();
  p.pan.value = Math.min(Math.max(pan, -1), 1);
  return p;
}

/** Rise to level, hold, and fade: for a sound lasting dur. */
function envelope(ctx: AudioContext, when: number, level: number, attack: number, dur: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(level, when + attack);
  g.gain.setValueAtTime(level, when + Math.max(dur - attack, attack));
  g.gain.linearRampToValueAtTime(0, when + dur + attack);
  return g;
}

function whiteNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function pinkNoise(ctx: AudioContext, seconds: number): AudioBuffer {
  const n = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  // Cross-fade the end into the start so the loop has no seam.
  const fade = 4096;
  for (let i = 0; i < fade; i++) d[i] = d[i] * (i / fade) + d[n - fade + i] * (1 - i / fade);
  return buf;
}

/** Echo of a wood: a soft, diffuse tail a couple of seconds long, a little late. */
function forestImpulse(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 2.6);
  const buf = ctx.createBuffer(2, n, sr);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      lp += (Math.random() * 2 - 1 - lp) * 0.18; // the trees soak up the highs
      d[i] = t < 0.03 ? 0 : lp * Math.exp(-(t - 0.03) / 0.7) * Math.min((t - 0.03) / 0.08, 1);
    }
  }
  return buf;
}

