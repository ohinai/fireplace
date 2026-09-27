import type { Camera } from './camera';
import { FIREBOX, GRATE, grateFingers } from './config';
import { add, cross, dot, length, normalize, scale, sub, type Vec3 } from './math';
import type { Sparks } from './render/Sparks';
import type { Blow } from './sim/FireSim';
import { LIGHTER, type LogSystem } from './sim/LogSystem';
import { fireCentre, supportIron } from './rooms';

export type ToolName = 'tongs' | 'poker' | 'blow' | 'match';

/** The tool in hand, for drawing. dir points from the working end back toward the hand. */
export type ToolView =
  | { kind: 'poker'; tip: Vec3; dir: Vec3 }
  | { kind: 'tongs'; grip: Vec3; axis: Vec3; radius: number; dir: Vec3 }
  | { kind: 'match'; tip: Vec3; dir: Vec3; lit: boolean; burnt: number };

/** Sounds the tools make themselves (knocks on logs come from the log model). */
export interface ToolSounds {
  clack(pos: Vec3): void; // tongs closing on a log
  clink(pos: Vec3, strength: number): void; // iron on iron
  stir(pos: Vec3, amount: number): void; // poker raking the coals
  strike(pos: Vec3): void; // a match struck
  snuff(pos: Vec3): void; // a match blown out
}

type Ray = { origin: Vec3; dir: Vec3 };
type Plane = { point: Vec3; normal: Vec3 };

const LIFT = 0.03; // the tongs hold a log this far clear of whatever is under it (m)
const TIP_SPEED = 2.5; // m/s: the fastest the poker's tip follows the pointer
const MATCH_SPEED = 1.2; // m/s: a match is held more carefully
const JAB_SPEED = 3;
const JAB_DEPTH = 0.045; // a click with the poker jabs this far in (m)
const JAB_OUT = 0.07; // s
const JAB_BACK = 0.2; // s
const TAP_TIME = 250; // ms: a press shorter than this (without moving) is a jab
const TURN_STEP = Math.PI / 12;
const NUDGE_STEP = 0.02; // m deeper or closer per wheel notch (or W/S press)
const MATCH_TIME = 30; // s a long match burns
const MATCH_CREEP = 0.004; // m/s: how fast the flame eats back along the stick

/**
 * Tongs, poker, blowing and matches. Takes pointer input (in normalised device coordinates) and
 * turns it into forces on the logs, the air and the coals, or a small flame.
 */
export class Tools {
  tool: ToolName = 'tongs';
  /** A log was taken hold of with the tongs. */
  onGrab?: () => void;
  /** Blowing on the fire, for the gas solver. */
  blow: Blow | null = null;
  /** How fast the poker's tip is moving (m/s). */
  tipSpeed = 0;

  private pressed = false;
  private pressAt = 0;
  private pressNdc: [number, number] = [0, 0];
  private moved = 0;
  private ray: Ray | null = null;
  // Tongs: a held log moves in an upright plane facing the viewer.
  private holding: number | null = null;
  private holdPlane: Plane = { point: [0, 0, 0], normal: [0, 0, -1] };
  private holdOffset: Vec3 = [0, 0, 0];
  private aim: Vec3 | null = null; // where the pointer wants the held log
  // Poker (and match): the tip follows the pointer across a plane facing the viewer.
  private pokerOn = false;
  private tip: Vec3 = [0, 0, 0];
  private tipTarget: Vec3 = [0, 0, 0];
  private plane: Plane = { point: [0, 0, 0], normal: [0, 0, 1] };
  private jab = -1; // time into a jab, or -1
  private jabDir: Vec3 = [0, 0, -1];
  private onBar = false;
  private stirTimer = 0;
  // Match.
  private matchOn = false;
  private matchLit = false;
  private matchAge = 0;
  // Blowing.
  private lastBlowPoint: Vec3 | null = null;
  private lastBlowTime = 0;
  private blowSparkTimer = 0;

  constructor(
    private readonly camera: Camera,
    private readonly logs: LogSystem,
    private readonly sparks: Sparks,
    private readonly sounds: ToolSounds,
  ) {}

  setTool(name: ToolName) {
    this.cancel();
    this.tool = name;
  }

  /** Whether the pointer is over something the current tool can take hold of (for the cursor). */
  hover(ndc: [number, number]): 'grab' | 'grabbing' | 'default' | 'crosshair' {
    if (this.tool !== 'tongs') return 'crosshair';
    if (this.holding !== null) return 'grabbing';
    const ray = this.camera.ray(ndc[0], ndc[1]);
    return this.logs.physics.pick(ray.origin, ray.dir) ? 'grab' : 'default';
  }

  down(ndc: [number, number]) {
    this.cancel();
    this.pressed = true;
    this.pressAt = performance.now();
    this.pressNdc = ndc;
    this.moved = 0;
    const ray = this.camera.ray(ndc[0], ndc[1]);
    this.ray = ray;
    if (this.tool === 'tongs') this.grab(ray);
    else if (this.tool === 'poker') this.startPoker(ray);
    else if (this.tool === 'match') this.strikeMatch(ray);
    else {
      this.lastBlowPoint = this.blowPoint(ray);
      this.lastBlowTime = performance.now();
    }
  }

  move(ndc: [number, number]) {
    if (!this.pressed) return;
    const ray = this.camera.ray(ndc[0], ndc[1]);
    this.ray = ray;
    this.moved = Math.max(this.moved, Math.hypot(ndc[0] - this.pressNdc[0], ndc[1] - this.pressNdc[1]));
    if (this.tool === 'tongs' && this.holding !== null) this.aimTongs(ray);
    else if (this.tool === 'poker' && this.pokerOn) this.aimPoker(ray);
    else if (this.tool === 'match' && this.matchOn) this.aimMatch(ray);
    else if (this.tool === 'blow') this.moveBlow(ray);
  }

  up() {
    if (!this.pressed) return;
    this.pressed = false;
    if (this.tool === 'tongs') {
      this.logs.physics.releaseGrab();
      this.holding = null;
      this.aim = null;
    } else if (this.tool === 'poker' && this.pokerOn) {
      const tap = performance.now() - this.pressAt < TAP_TIME && this.moved < 0.02;
      if (tap && this.ray) {
        this.jab = 0;
        this.jabDir = this.ray.dir;
      } else {
        this.hidePoker();
      }
    } else if (this.tool === 'match') {
      this.putOutMatch();
    } else {
      this.lastBlowPoint = null;
    }
  }

  /** Lets go of everything (e.g. when a second finger starts a camera gesture). */
  cancel() {
    this.pressed = false;
    if (this.holding !== null) this.logs.physics.releaseGrab();
    this.holding = null;
    this.aim = null;
    this.hidePoker();
    this.putOutMatch();
    this.lastBlowPoint = null;
  }

  /** Whether a log is held in the tongs. */
  get holdingLog(): boolean {
    return this.holding !== null;
  }

  /** Turns a held log about the vertical (Shift+wheel or Q/E). Returns whether a log is held. */
  turn(steps: number): boolean {
    if (this.holding === null) return false;
    this.logs.physics.turnGrab(steps * TURN_STEP);
    return true;
  }

  /** Moves a held log deeper into the fire (or closer, for negative steps: wheel notches or W/S presses). */
  nudge(steps: number): boolean {
    if (this.holding === null) return false;
    const { point, normal } = this.holdPlane;
    this.holdPlane = { point: add(point, scale(normal, steps * NUDGE_STEP)), normal };
    if (this.ray) this.aimTongs(this.ray);
    return true;
  }

  /** Per solver step, before the logs move: steers the held log, the poker or the match. */
  step(dt: number) {
    this.tipSpeed = 0;
    if (this.holding !== null) this.steerTongs();
    if (this.matchOn) {
      this.stepMatch(dt);
      return;
    }
    if (!this.pokerOn) return;
    let target = this.tipTarget;
    let speed = TIP_SPEED;
    if (this.jab >= 0) {
      this.jab += dt;
      target = add(target, scale(this.jabDir, JAB_DEPTH * jabProfile(this.jab)));
      speed = JAB_SPEED;
      if (this.jab > JAB_OUT + JAB_BACK) {
        this.jab = -1;
        if (!this.pressed) {
          this.hidePoker();
          return;
        }
      }
    }
    const d = sub(target, this.tip);
    const most = speed * dt;
    const move = length(d) > most ? scale(d, most / length(d)) : d;
    this.tip = add(this.tip, move);
    this.tipSpeed = length(move) / dt;
    this.logs.physics.movePoker(this.tip, this.handDir(this.tip));
    this.feelAround(dt);
  }

  /** Per frame: blowing fades, sparks from gusts, keeping track of the held log. */
  frame(dt: number) {
    const held = this.logs.physics.held;
    if (this.holding !== null && held !== this.holding) this.holding = held; // it broke, or burnt away
    const blow = this.blow;
    if (!blow) return;
    this.blowSparkTimer -= dt;
    const gust = Math.hypot(...blow.vel);
    if (blow.pos[1] < 0.3) this.logs.blowOnCoals(blow.strength * Math.min(gust / 2.5, 1), blow.pos);
    if (this.blowSparkTimer <= 0 && blow.strength > 0.5 && gust > 1.5 && blow.pos[1] < 0.3) {
      this.blowSparkTimer = 0.08;
      this.sparks.burst([blow.pos[0], 0.05, blow.pos[2]], 4, [blow.vel[0] * 0.4, 1.0, blow.vel[2] * 0.4], 0.8, 0.05);
    }
    blow.strength *= Math.exp(-dt / 0.12);
    if (blow.strength < 0.02) this.blow = null;
  }

  /** The tool to draw, if one is in use. */
  view(): ToolView | null {
    if (this.matchOn) {
      return { kind: 'match', tip: this.tip, dir: this.handDir(this.tip), lit: this.matchLit, burnt: Math.min(this.matchAge * MATCH_CREEP, 0.12) };
    }
    if (this.pokerOn) return { kind: 'poker', tip: this.tip, dir: this.handDir(this.tip) };
    const grip = this.holding !== null ? this.logs.physics.grip() : null;
    if (grip) {
      const radius = this.logs.logRadius(grip.id) ?? 0.04;
      return { kind: 'tongs', grip: grip.point, axis: grip.axis, radius, dir: this.handDir(grip.point) };
    }
    return null;
  }

  // ---- Tongs ------------------------------------------------------------------------------

  private grab(ray: Ray) {
    const physics = this.logs.physics;
    const hit = physics.pick(ray.origin, ray.dir);
    if (!hit || !physics.grabLog(hit.id, hit.point)) return;
    const grip = physics.grip()!;
    this.holding = hit.id;
    this.sounds.clack(hit.point);
    this.onGrab?.();
    const forward = sub(this.camera.target, this.camera.eye);
    this.holdPlane = { point: grip.point, normal: normalize([forward[0], 0, forward[2]]) };
    this.holdOffset = sub(grip.point, onPlane(ray, this.holdPlane) ?? grip.point);
    // Lift it a little where it is to start with.
    this.aim = add(grip.point, [0, LIFT, 0]);
  }

  /** The held log follows the pointer across its plane. */
  private aimTongs(ray: Ray) {
    const p = onPlane(ray, this.holdPlane);
    if (!p) return;
    const radius = this.logs.logRadius(this.holding!) ?? 0.04;
    // Keep it over the grate (in depth), inside the walls (or the ring of stones), below the lintel.
    const open = this.logs.room.enclosure === 'open';
    this.aim = this.inside(add(p, this.holdOffset), radius + 0.01, [radius + (open ? 0.02 : 0.045), open ? 0.6 : 0.45], GRATE.maxZ - 0.01);
  }

  /**
   * Carries the held log toward the aim the way a person would: up clear of the pile first,
   * across, then down, rather than ploughing through the other logs.
   */
  private steerTongs() {
    const physics = this.logs.physics;
    const grip = physics.grip();
    if (!grip || !this.aim) return;
    const radius = this.logs.logRadius(grip.id) ?? 0.04;
    const logLength = this.logs.logLength(grip.id) ?? 0.4;
    const heading = Math.atan2(grip.axis[2], grip.axis[0]);
    // Lowest the grip can be with the log clear of what is below it there: not of the logs lying
    // on it, though, or taking a log from under another would wrench it up over the top of that
    // one, knocking it flying.
    const riders = physics.ridersOf(grip.id);
    const clear = (p: Vec3) =>
      physics.restHeight(p[0] - grip.axis[0] * grip.s, p[2] - grip.axis[2] * grip.s, heading, logLength, radius, grip.id, riders) + LIFT;
    const aim = this.aim;
    const here = grip.point;
    // Kept clear of what is below only lying across, the way the tongs carry a log: one standing
    // steep (in a teepee, say) is just lifted and moved, and levels off as it is carried.
    const lying = Math.abs(grip.axis[1]) < 0.5;
    let target: Vec3 = lying ? [aim[0], Math.max(aim[1], clear(aim)), aim[2]] : aim;
    if (lying && Math.hypot(aim[0] - here[0], aim[2] - here[2]) > 0.03) {
      const mid: Vec3 = [(aim[0] + here[0]) / 2, 0, (aim[2] + here[2]) / 2];
      const over = Math.max(target[1], clear(mid), clear(here));
      target = here[1] < over - 0.015 ? [here[0], over + 0.01, here[2]] : [aim[0], over, aim[2]];
    }
    physics.moveGrab(target);
  }

  // ---- Poker --------------------------------------------------------------------------------

  private startPoker(ray: Ray) {
    this.tip = this.inside(sub(this.reach(ray), scale(ray.dir, 0.012)), 0.015, [0.008, 0.6]);
    this.tipTarget = this.tip;
    this.plane = { point: this.tip, normal: scale(ray.dir, -1) };
    this.jab = -1;
    this.pokerOn = true;
    this.logs.physics.showPoker(this.tip, this.handDir(this.tip));
  }

  /** The tip moves in the plane facing the viewer where it first went in. */
  private aimPoker(ray: Ray) {
    const p = onPlane(ray, this.plane);
    if (p) this.tipTarget = this.inside(p, 0.015, [0.008, 0.6]);
  }

  private hidePoker() {
    if (!this.pokerOn) return;
    this.pokerOn = false;
    this.jab = -1;
    this.logs.physics.hidePoker();
  }

  /** Raking the coals, and knocking against the grate's bars. */
  private feelAround(dt: number) {
    const [x, y, z] = this.tip;
    const bed = this.logs.room.bed;
    const inBed = x > bed.minX && x < bed.maxX && z > bed.minZ && z < bed.maxZ;
    this.stirTimer -= dt;
    if (inBed && y < 0.045 && this.tipSpeed > 0.15) {
      const amount = Math.min(this.tipSpeed / 1.2, 1);
      this.logs.stirCoals(amount, this.tip, dt);
      if (this.stirTimer <= 0) {
        this.stirTimer = 0.07;
        this.sparks.burst([x, 0.035, z], Math.round(2 + 7 * amount), [0, 0.9, 0], 0.7, 0.03);
        this.sounds.stir(this.tip, amount);
      }
    }
    // Iron on iron: the grate's bars or the andirons.
    const onBar = supportIron(this.logs.room.support, grateFingers()).some(([a, b, r]) => distanceToSegment(this.tip, a, b) < r + 0.008);
    if (onBar && !this.onBar && this.tipSpeed > 0.15) this.sounds.clink(this.tip, Math.min(this.tipSpeed / 1.5, 1));
    this.onBar = onBar;
  }

  // ---- Match --------------------------------------------------------------------------------

  /** Strikes a match and holds it where the pointer is (on a firelighter, if near one). */
  private strikeMatch(ray: Ray) {
    this.tip = this.matchSpot(ray);
    this.tipTarget = this.tip;
    this.plane = { point: this.tip, normal: scale(ray.dir, -1) };
    this.matchOn = true;
    this.matchLit = true;
    this.matchAge = 0;
    this.sounds.strike(this.tip);
  }

  private aimMatch(ray: Ray) {
    const lighter = this.lighterNear(ray);
    if (lighter) {
      this.tipTarget = lighter;
      return;
    }
    const p = onPlane(ray, this.plane);
    if (p) this.tipTarget = this.inside(p, 0.005, [0.01, 0.6]);
  }

  private stepMatch(dt: number) {
    const d = sub(this.tipTarget, this.tip);
    const most = MATCH_SPEED * dt;
    this.tip = add(this.tip, length(d) > most ? scale(d, most / length(d)) : d);
    if (this.matchLit) {
      this.matchAge += dt;
      if (this.matchAge > MATCH_TIME) {
        this.matchLit = false;
        this.sounds.snuff(this.tip);
      }
    }
    this.logs.holdMatch(this.matchLit ? add(this.tip, [0, 0.006, 0]) : null);
  }

  private putOutMatch() {
    if (!this.matchOn) return;
    if (this.matchLit) this.sounds.snuff(this.tip);
    this.matchOn = false;
    this.matchLit = false;
    this.logs.holdMatch(null);
  }

  /** Where the match goes for a pointer ray: a firelighter it passes close to, or what it hits. */
  private matchSpot(ray: Ray): Vec3 {
    return this.lighterNear(ray) ?? this.inside(sub(this.reach(ray), scale(ray.dir, 0.01)), 0.005, [0.01, 0.6]);
  }

  /**
   * The top of a firelighter the ray passes within several centimetres of (the match's place to
   * light it): they sit tucked under the logs, where they can't always be seen.
   */
  private lighterNear(ray: Ray): Vec3 | null {
    let best: Vec3 | null = null;
    let bestDist = 0.08;
    for (const l of this.logs.lighterViews()) {
      if (l.spent >= 1) continue;
      const top = add(l.pos, [LIGHTER.size * 0.1, l.height + 0.012, 0]);
      const t = Math.max(dot(sub(top, ray.origin), ray.dir), 0);
      const d = length(sub(add(ray.origin, scale(ray.dir, t)), top));
      if (d < bestDist) {
        bestDist = d;
        best = top;
      }
    }
    return best;
  }

  // ---- Blowing ------------------------------------------------------------------------------

  private blowPoint(ray: Ray): Vec3 | null {
    return onPlane(ray, this.firePlane());
  }

  private moveBlow(ray: Ray) {
    if (!this.lastBlowPoint) return;
    const p = this.blowPoint(ray);
    const now = performance.now();
    const dt = Math.max((now - this.lastBlowTime) / 1000, 1 / 240);
    if (!p) return;
    let v = scale(sub(p, this.lastBlowPoint), 1 / dt);
    const speed = Math.hypot(...v);
    if (speed > 4) v = scale(v, 4 / speed);
    // Air comes from the viewer's side.
    const toward = this.firePlane().normal;
    v = add(v, scale(toward, 0.3));
    this.blow = { pos: p, radius: 0.06, vel: v, strength: 1 };
    this.lastBlowPoint = p;
    this.lastBlowTime = now;
  }

  // ---- Helpers ------------------------------------------------------------------------------

  /** An upright plane through the middle of the fire, facing the viewer (its normal points away). */
  private firePlane(): Plane {
    const c = this.camera;
    const f = sub(c.target, c.eye);
    return { point: fireCentre(this.logs.room), normal: normalize([f[0], 0, f[2]]) };
  }

  /** Where a pointer ray reaches into the fire: what it hits there, else the plane through the fire. */
  private reach(ray: Ray): Vec3 {
    const hit = this.logs.physics.castScene(ray.origin, ray.dir);
    const room = this.logs.room;
    const c = fireCentre(room);
    const inFire = hit && (room.enclosure === 'open' ? Math.hypot(hit.point[0] - c[0], hit.point[2] - c[2]) < (room.ring?.inner ?? 0.3) : hit.point[2] < 0);
    return inFire ? hit.point : (onPlane(ray, this.firePlane()) ?? add(ray.origin, scale(ray.dir, 1.5)));
  }

  /**
   * Keeps a point inside the firebox (margin m from the walls; no further forward than zMax) or
   * inside the ring of stones, between heights y[0] and y[1].
   */
  private inside(p: Vec3, margin: number, y: [number, number], zMax = -0.02 - margin): Vec3 {
    const room = this.logs.room;
    const py = Math.min(Math.max(p[1], y[0]), y[1]);
    if (room.enclosure === 'open') {
      const c = fireCentre(room);
      const R = (room.ring?.inner ?? 0.3) - margin;
      let dx = p[0] - c[0];
      let dz = p[2] - c[2];
      const d = Math.hypot(dx, dz);
      if (d > R) {
        dx *= R / d;
        dz *= R / d;
      }
      return [c[0] + dx, py, c[2] + dz];
    }
    const { frontHalfWidth: fw, backHalfWidth: bw, depth: D } = FIREBOX;
    const z = Math.min(Math.max(p[2], -D + margin), zMax);
    const half = bw + (fw - bw) * (1 + z / D) - margin;
    return [Math.min(Math.max(p[0], -half), half), py, z];
  }

  /** Direction from a point in the fire back toward the hand holding the tool. */
  private handDir(p: Vec3): Vec3 {
    const c = this.camera;
    const forward = normalize(sub(c.target, c.eye));
    const right = normalize(cross(forward, [0, 1, 0]));
    const up = cross(right, forward);
    const hand = add(add(add(c.eye, scale(forward, 0.55)), scale(right, 0.3)), scale(up, -0.3));
    return normalize(sub(hand, p));
  }
}

function distanceToSegment(p: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const t = Math.min(Math.max(dot(sub(p, a), ab) / dot(ab, ab), 0), 1);
  return length(sub(p, add(a, scale(ab, t))));
}

/** Where a ray meets a plane (in front of the ray's origin), if it does. */
function onPlane(ray: Ray, plane: Plane): Vec3 | null {
  const den = dot(ray.dir, plane.normal);
  if (Math.abs(den) < 1e-4) return null;
  const t = dot(sub(plane.point, ray.origin), plane.normal) / den;
  return t > 0 ? add(ray.origin, scale(ray.dir, t)) : null;
}

/** How far in a jab is (0..1), t seconds after it started. */
function jabProfile(t: number): number {
  const s = (x: number) => x * x * (3 - 2 * x);
  if (t < JAB_OUT) return s(t / JAB_OUT);
  return 1 - s(Math.min((t - JAB_OUT) / JAB_BACK, 1));
}
