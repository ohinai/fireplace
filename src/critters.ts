import { add, length, normalize, scale, sub, type Vec3 } from './math';
import type { TimeOfDay } from './render/Renderer';
import type { Wild } from './rooms';

// Life round the campfire after dark: fireflies blinking in the grass at the edge of the
// clearing, moths about the lantern, bats hunting over the trees, and now and then a pair of
// eyes catching the firelight from the dark between the trunks (with a rustle of leaves). Very
// rarely, knocks on a tree somewhere, and something big walks across the far side of the meadow,
// stops, looks toward the fire, and walks on into the trees. In the desert: moths at the lantern,
// and a fox's eyes shining out of the dark, low down, far off across the sand.

export interface CritterScene {
  time: TimeOfDay;
  lantern: { pos: Vec3; level: number } | null; // a lamp moths can come to
  fire: number; // how bright the fire is (0..1): eyes shine back its light
  eye: Vec3; // where the viewer is
  forward: Vec3; // which way they look
  ground?: (x: number, z: number) => number; // how high the ground is (m), out in the woods
}

/** What to draw. */
export type CritterView =
  | { kind: 'glow'; pos: Vec3; size: number; bright: number; tint: 'firefly' | 'eyes' }
  | { kind: 'wings'; pos: Vec3; heading: Vec3; span: number; flap: number; pale: boolean }
  | BigfootView;

/** Bigfoot, walking: where its feet are, which way it walks, how far into its stride it is (radians), how far it has turned to look toward the fire (0..1). */
export interface BigfootView {
  kind: 'bigfoot';
  pos: Vec3;
  heading: Vec3;
  stride: number;
  look: number;
  toward: Vec3; // (from it, level, toward the viewer)
}

interface Bigfoot {
  from: Vec3; // where it comes out of the trees
  to: Vec3; // and goes back in
  age: number; // s since it came out
  pause: number; // when it stops to look (s)
  total: number; // s it is out in all
}

const BIGFOOT_SPEED = 1.3; // m/s: unhurried, long strides
const BIGFOOT_STRIDE = 1.7; // m a full stride (two steps)
const BIGFOOT_LOOK = 3.2; // s it stands and looks

interface Firefly {
  home: Vec3;
  pos: Vec3;
  phase: number[]; // wander
  dark: number; // s until its next flash
  flash: number; // s into a flash, or -1
  length: number; // s its flash lasts
  double: boolean;
}

interface Flyer {
  pos: Vec3;
  vel: Vec3;
  target: Vec3;
  retarget: number; // s until it changes course
  flap: number; // phase
  rate: number; // wing beats per second
}

interface Eyes {
  pos: Vec3; // between them
  across: Vec3; // from one to the other
  size: number;
  age: number;
  life: number;
  blinkAt: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Critters {
  /** Something moved in the undergrowth at pos (for a rustle of leaves). */
  onRustle?: (pos: Vec3, loud: number) => void;

  private fireflies: Firefly[] = [];
  private moths: Flyer[] = [];
  private bats: Flyer[] = [];
  private eyes: Eyes | null = null;
  private nextEyes = rand(20, 50);
  private bigfoot: Bigfoot | null = null;
  private nextBigfoot = rand(420, 900); // s: the first chance of one comes some minutes in
  /** Knocks on a tree, far off (Bigfoot is about). */
  onKnocks?: (pos: Vec3) => void;
  private time = 0;
  private wild: Wild | null = null;

  /** What lives round the fire outdoors (null: indoors, where there is nothing to show). */
  setWild(wild: Wild | null) {
    this.wild = wild;
    this.fireflies = [];
    this.moths = [];
    this.bats = [];
    this.eyes = null;
    this.bigfoot = null;
  }

  /** Bigfoot comes by at the next chance (for testing). */
  soon() {
    this.nextBigfoot = 0;
  }

  update(dt: number, s: CritterScene) {
    if (!this.wild) return;
    this.time += dt;
    const night = s.time === 'night';
    const dusk = s.time === 'dusk';
    const woods = this.wild === 'woods';
    this.populate(woods ? (night ? 30 : dusk ? 16 : 0) : 0, this.fireflies, () => this.newFirefly());
    this.populate(s.lantern && s.lantern.level > 0.05 && s.time !== 'day' ? 4 : 0, this.moths, () => this.newMoth(s.lantern!.pos));
    this.populate(woods && (night || dusk) ? 2 : 0, this.bats, () => this.newBat());
    for (const f of this.fireflies) this.stepFirefly(f, dt);
    if (s.lantern) for (const m of this.moths) this.stepMoth(m, dt, s.lantern.pos);
    for (const b of this.bats) this.stepBat(b, dt);
    this.stepEyes(dt, s, night);
    this.stepBigfoot(dt, s, woods && (night || dusk));
  }

  views(fire: number): CritterView[] {
    const out: CritterView[] = [];
    for (const f of this.fireflies) {
      const b = this.fireflyBrightness(f);
      if (b > 0.01) out.push({ kind: 'glow', pos: f.pos, size: 0.004, bright: b, tint: 'firefly' });
    }
    for (const m of this.moths) out.push({ kind: 'wings', pos: m.pos, heading: normalize(m.vel), span: 0.035, flap: Math.sin(m.flap), pale: true });
    for (const b of this.bats) out.push({ kind: 'wings', pos: b.pos, heading: normalize(b.vel), span: 0.28, flap: Math.sin(b.flap), pale: false });
    const e = this.eyes;
    if (e) {
      const open = this.eyeOpen(e) * (0.25 + 0.75 * fire);
      if (open > 0.01) {
        for (const side of [-0.5, 0.5]) out.push({ kind: 'glow', pos: add(e.pos, scale(e.across, side)), size: e.size, bright: open, tint: 'eyes' });
      }
    }
    const b = this.bigfootView();
    if (b) {
      out.push(b);
      // Its eyes catch the firelight when it looks this way.
      if (b.look > 0.6) {
        // (Its face: see bigfoot() in toolMesh.ts.)
        const head = add(b.pos, [b.heading[0] * 0.12 + b.toward[0] * 0.14, 2.09, b.heading[2] * 0.12 + b.toward[2] * 0.14]);
        const across: Vec3 = [-b.toward[2] * 0.036, 0, b.toward[0] * 0.036];
        const shine = (b.look - 0.6) / 0.4 * (0.35 + 0.65 * fire);
        for (const side of [-1, 1]) out.push({ kind: 'glow', pos: add(head, scale(across, side)), size: 0.011, bright: shine, tint: 'eyes' });
      }
    }
    return out;
  }

  // ---- Bigfoot ----------------------------------------------------------------------------

  /**
   * Very rarely (once in twenty minutes to three quarters of an hour of night or dusk, the first
   * some minutes in): knocks on a tree, then something big walks out of the trees across the
   * meadow, a stone's throw off, across where the viewer is looking; stops, turns to look toward
   * the fire, and walks on and away.
   */
  private stepBigfoot(dt: number, s: CritterScene, able: boolean) {
    this.viewer = s.eye;
    const b = this.bigfoot;
    if (b) {
      b.age += dt;
      if (b.age > b.total) this.bigfoot = null;
      return;
    }
    if (!able || (this.nextBigfoot -= dt) > 0) return;
    this.nextBigfoot = rand(1200, 2700);
    const f = normalize([s.forward[0], 0, s.forward[2]]);
    const side: Vec3 = [-f[2], 0, f[0]];
    const dist = rand(22, 30);
    const centre = add([s.eye[0], 0, s.eye[2]], scale(f, dist));
    const way = Math.random() < 0.5 ? 1 : -1;
    const half = rand(7, 10);
    const ground = (p: Vec3): Vec3 => [p[0], s.ground ? s.ground(p[0], p[2]) : 0, p[2]];
    const from = ground(add(centre, scale(side, -half * way)));
    const to = ground(add(centre, scale(side, half * way)));
    const walk = (2 * half) / BIGFOOT_SPEED;
    this.bigfoot = { from, to, age: 0, pause: walk * rand(0.4, 0.55), total: walk + BIGFOOT_LOOK };
    this.onKnocks?.(from);
    this.onRustle?.(from, 1);
  }
  private viewer: Vec3 = [0, 0, 0];

  private bigfootView(): BigfootView | null {
    const b = this.bigfoot;
    if (!b) return null;
    // Walking, then standing to look (its head and shoulders turning), then walking on.
    const walked = BIGFOOT_SPEED * (b.age < b.pause ? b.age : b.age < b.pause + BIGFOOT_LOOK ? b.pause : b.age - BIGFOOT_LOOK);
    const path = sub(b.to, b.from);
    const len = length(path);
    const t = Math.min(walked / len, 1);
    const pos: Vec3 = [b.from[0] + path[0] * t, b.from[1] + path[1] * t, b.from[2] + path[2] * t];
    const heading = normalize([path[0], 0, path[2]]);
    const since = b.age - b.pause;
    const look = since < 0 || since > BIGFOOT_LOOK ? 0 : Math.min(1, since / 0.7, (BIGFOOT_LOOK - since) / 0.7);
    return { kind: 'bigfoot', pos, heading, stride: (walked / BIGFOOT_STRIDE) * Math.PI * 2, look, toward: normalize([this.viewer[0] - pos[0], 0, this.viewer[2] - pos[2]]) };
  }

  // ---- Fireflies --------------------------------------------------------------------------

  private newFirefly(): Firefly {
    const a = Math.random() * Math.PI * 2;
    const r = rand(1.8, 7);
    const home: Vec3 = [Math.cos(a) * r, rand(0.15, 1.8), Math.sin(a) * r];
    return { home, pos: [...home], phase: [0, 1, 2, 3, 4, 5].map(() => Math.random() * 100), dark: rand(0.5, 6), flash: -1, length: rand(0.35, 0.7), double: Math.random() < 0.3 };
  }

  private stepFirefly(f: Firefly, dt: number) {
    const t = this.time;
    const p = f.phase;
    // A slow, looping drift about its patch of grass.
    const drift: Vec3 = [
      0.5 * Math.sin(t * 0.21 + p[0]) + 0.3 * Math.sin(t * 0.53 + p[1]),
      0.25 * Math.sin(t * 0.33 + p[2]) + 0.12 * Math.sin(t * 0.91 + p[3]),
      0.5 * Math.sin(t * 0.19 + p[4]) + 0.3 * Math.sin(t * 0.47 + p[5]),
    ];
    f.pos = add(f.home, drift);
    if (f.flash >= 0) {
      f.flash += dt;
      if (f.flash > f.length * (f.double ? 2.2 : 1)) {
        f.flash = -1;
        f.dark = rand(1.5, 6);
      }
    } else if ((f.dark -= dt) <= 0) {
      f.flash = 0;
      f.double = Math.random() < 0.3;
    }
  }

  private fireflyBrightness(f: Firefly): number {
    if (f.flash < 0) return 0;
    const pulse = (t: number) => (t < 0 || t > f.length ? 0 : Math.sin((t / f.length) * Math.PI) ** 1.5);
    return f.double ? Math.max(pulse(f.flash), pulse(f.flash - f.length * 1.2)) : pulse(f.flash);
  }

  // ---- Moths and bats ---------------------------------------------------------------------

  private newMoth(at: Vec3): Flyer {
    return { pos: add(at, [rand(-0.2, 0.2), rand(-0.1, 0.2), rand(-0.2, 0.2)]), vel: [rand(-1, 1), 0, rand(-1, 1)], target: at, retarget: 0, flap: Math.random() * 6, rate: rand(14, 20) };
  }

  /** Moths spiral round the light, darting in and bumping off it. */
  private stepMoth(m: Flyer, dt: number, light: Vec3) {
    if ((m.retarget -= dt) <= 0) {
      m.retarget = rand(0.15, 0.6);
      m.target = add(light, [rand(-0.14, 0.14), rand(-0.06, 0.16), rand(-0.14, 0.14)]);
    }
    const toward = sub(m.target, m.pos);
    m.vel = add(scale(m.vel, Math.exp(-dt * 3)), scale(toward, dt * 40));
    const sp = length(m.vel);
    if (sp > 1.4) m.vel = scale(m.vel, 1.4 / sp);
    m.pos = add(m.pos, scale(m.vel, dt));
    m.flap += dt * m.rate * Math.PI * 2;
  }

  private newBat(): Flyer {
    const a = Math.random() * Math.PI * 2;
    return { pos: [Math.cos(a) * 4, rand(3.5, 6), Math.sin(a) * 4], vel: [Math.sin(a) * 4, 0, -Math.cos(a) * 4], target: [0, 5, 0], retarget: 0, flap: Math.random() * 6, rate: rand(8, 11) };
  }

  /** Bats hunt over the clearing: fast, jinking after insects, never quite still. */
  private stepBat(b: Flyer, dt: number) {
    if ((b.retarget -= dt) <= 0) {
      b.retarget = rand(0.3, 1.4);
      const a = Math.random() * Math.PI * 2;
      const r = rand(1.5, 6.5);
      b.target = [Math.cos(a) * r, rand(2.5, 7), Math.sin(a) * r];
    }
    const toward = normalize(sub(b.target, b.pos));
    b.vel = add(scale(b.vel, Math.exp(-dt * 1.5)), scale(toward, dt * 14));
    const sp = length(b.vel);
    if (sp > 6) b.vel = scale(b.vel, 6 / sp);
    if (sp < 3) b.vel = scale(b.vel, 3 / Math.max(sp, 1e-3));
    b.pos = add(b.pos, scale(b.vel, dt));
    b.flap += dt * b.rate * Math.PI * 2;
  }

  // ---- Eyes in the dark ------------------------------------------------------------------

  private stepEyes(dt: number, s: CritterScene, night: boolean) {
    const e = this.eyes;
    if (e) {
      e.age += dt;
      if (e.age > e.life) {
        this.eyes = null;
        if (this.wild === 'woods') this.onRustle?.(e.pos, 0.6);
      }
      return;
    }
    if (!night || (this.nextEyes -= dt) > 0) return;
    const desert = this.wild === 'desert';
    this.nextEyes = desert ? rand(30, 90) : rand(45, 140);
    // Somewhere at the edge of the firelight the viewer is looking toward.
    const f = normalize([s.forward[0], 0, s.forward[2]]);
    const turn = rand(-0.6, 0.6);
    const dir: Vec3 = [f[0] * Math.cos(turn) - f[2] * Math.sin(turn), 0, f[0] * Math.sin(turn) + f[2] * Math.cos(turn)];
    // A deer or a fox between the trees; out on the sand, a fox (a fennec's eyes sit low).
    const dist = desert ? rand(7, 13) : rand(5.5, 8.5);
    const deer = !desert && Math.random() < 0.35;
    const pos: Vec3 = [s.eye[0] + dir[0] * dist, deer ? rand(1.2, 1.45) : desert ? rand(0.2, 0.3) : rand(0.3, 0.5), s.eye[2] + dir[2] * dist];
    if (Math.hypot(pos[0], pos[2]) < 4) return; // (not out in the clearing, nor in the camp)
    if (desert && Math.abs(pos[0]) < 3.6 && pos[2] < -1.8 && pos[2] > -5.5) return; // (nor in the tent)
    const toViewer = normalize(sub(s.eye, pos));
    const across = normalize([-toViewer[2], 0, toViewer[0]]);
    this.eyes = { pos, across: scale(across, deer ? 0.09 : desert ? 0.035 : 0.045), size: deer ? 0.012 : 0.008, age: 0, life: rand(3, 9), blinkAt: rand(1.5, 3.5) };
    if (!desert) this.onRustle?.(pos, 1);
  }

  private eyeOpen(e: Eyes): number {
    const fadeIn = Math.min(e.age / 0.6, 1);
    const fadeOut = Math.min((e.life - e.age) / 0.8, 1);
    const blink = Math.abs(e.age - e.blinkAt) < 0.08 ? 0 : 1;
    return Math.max(0, fadeIn * fadeOut * blink);
  }

  private populate<T>(count: number, list: T[], make: () => T) {
    while (list.length < count) list.push(make());
    if (list.length > count) list.length = count;
  }
}
