import type * as RapierModule from '@dimforge/rapier3d-compat';
import type { Collider, RigidBody, World } from '@dimforge/rapier3d-compat';

import { BED_HEIGHT, FIREBOX, GRATE, grateFingers } from '../config';
import { ANDIRONS, ringStones, type Room } from '../rooms';
import { add, cross, dot, length, normalize, quatAxisAngle, quatBetween, quatFromBasis, quatNlerp, quatRotate, scale, sub, type Quat, type Vec3 } from '../math';

type Rapier = typeof RapierModule;

/** A log's collision shape: convex pieces along it, in the log's own frame. */
export interface LogShape {
  pieces: Float32Array[]; // point clouds: x along the axis (from the centre), y along e1, z along e2
  density: number; // kg/m3
}

/** Where a log is and how it moves. Its frame: x = axis (end A to end B), y = e1, z = e2. */
export interface LogPose {
  centre: Vec3; // middle of the axis
  rot: Quat;
  vel: Vec3; // velocity of the centre
  spin: Vec3; // angular velocity
}

export type Surface = 'log' | 'iron' | 'coals' | 'hearth' | 'wall' | 'ground' | 'stone';

export interface Impact {
  id: number;
  pos: Vec3;
  speed: number; // how much the hit changed the log's velocity (m/s)
  energy: number; // J
  against: Surface;
}

export interface Poke {
  id: number;
  pos: Vec3;
}

export interface SceneHit {
  point: Vec3;
  normal: Vec3;
  id: number | null; // log hit, if any
  against: Surface;
}

const GROUP_STATIC = 1;
const GROUP_LOG = 2;
const GROUP_TOOL = 4;
const GROUP_BARRIER = 8;
const groups = (member: number, filter: number) => ((member & 0xffff) << 16) | (filter & 0xffff);

const GRAVITY = 9.81; // (to start with: see setGravity)
const BORDER = 0.003; // logs' pieces are rounded off by this much (m)
const IMPACT_MIN = 0.45; // m/s: smaller knocks go unnoticed
// Physics steps per solver step: short steps keep a light stick of kindling steady under a log
// sixty times its weight, and a leaning log from creeping.
const SUBSTEPS = 4;
// Rough, charred wood doesn't roll or rock by itself: bark, knots and char catch, like rolling
// friction. A log whose surface is barely moving (speed plus spin times radius) comes to a stop
// instead of rattling or rocking on and on; a knock, a fall or a real slide is far faster than
// this and is left alone.
const SETTLE_SPEED = 0.08; // m/s
const SETTLE_RATE = 12; // 1/s: how fast such small motions die away
// A held log follows its target like a careful hand would: steadily, with limited force, so it
// rests on the pile instead of ploughing through it. The tongs take hold gently (their grip
// tightens over a moment), a hand gets up to speed rather than jerking (though it stops when it
// likes), and a log picked up at a slant is brought level slowly, not snapped.
const GRAB_TAU = 0.1;
const GRAB_SPEED = 0.9; // m/s
const GRAB_ACCEL = 3; // m/s2
const GRAB_FORCE = 50;
const GRAB_TIGHTEN = 0.35; // s
const LEVEL_DISTANCE = 0.05; // m: a log picked up at a slant is brought level as it is carried this far and more
const TURN_TAU = 0.12;
const TURN_MOST = 2.5; // rad/s
const TURN_ACCEL = 10; // rad/s2
const RELEASE_SPEED = 1.5;
// The poker: an iron rod whose last stretch inside the firebox pushes logs around.
export const POKER_RADIUS = 0.007;
const POKER_REACH = 0.24;

interface LogBody {
  id: number;
  body: RigidBody;
  colliders: Collider[];
  length: number;
  radius: number; // how far its surface reaches from its axis (m)
  prevVel: Vec3;
  age: number;
  lastImpact: number;
}

interface Grab {
  id: number;
  s: number; // where along the axis it is held (m from the centre)
  target: Vec3;
  heading: number; // wanted direction of the axis (angle in the xz plane)
  pitch: number; // its slant when taken hold of (radians), eased away as it is carried
  from: Vec3; // where its grip point was when taken hold of
  carried: number; // how far it has since been carried (m, across: the farthest yet)
  age: number; // s since it was taken hold of
  speed: number; // how fast the hand is carrying it (m/s)
  spin: number; // and turning it (rad/s)
}

const vec = (v: Vec3) => ({ x: v[0], y: v[1], z: v[2] });
const arr = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const rotation = (q: Quat) => ({ x: q[0], y: q[1], z: q[2], w: q[3] });

/**
 * Rigid-body physics for the logs (Rapier): they fall, roll, stack and knock into each other,
 * with collision shapes that follow their burnt-away surfaces. Also the tongs (a held log) and
 * the poker (a kinematic rod).
 */
export class LogPhysics {
  private readonly world: World;
  private readonly logs = new Map<number, LogBody>();
  private readonly owner = new Map<number, number>(); // collider handle -> log id
  private readonly staticKind = new Map<number, Surface>();
  private readonly poker: { body: RigidBody; collider: Collider; active: boolean };
  // Where the poker goes over the next step (spread over its substeps).
  private pokerMove: { from: { centre: Vec3; rot: Quat }; to: { centre: Vec3; rot: Quat } } | null = null;
  private fireplace: RigidBody | null = null;
  private grab: Grab | null = null;
  private time = 0;
  private gravity = GRAVITY; // m/s2
  /** Hits since the last drain. */
  readonly impacts: Impact[] = [];
  /** Logs the poker touched in the latest step. */
  readonly pokes: Poke[] = [];

  static async load(): Promise<LogPhysics> {
    const R = await import('@dimforge/rapier3d-compat');
    await R.init();
    return new LogPhysics(R);
  }

  private constructor(private readonly R: Rapier) {
    this.world = new R.World({ x: 0, y: -GRAVITY, z: 0 });
    // Everything here is a few centimetres to half a metre across.
    this.world.lengthUnit = 0.2;
    this.world.numSolverIterations = 8;
    const body = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(0, -2, 0));
    const collider = this.world.createCollider(
      R.ColliderDesc.capsule(POKER_REACH / 2, POKER_RADIUS).setFriction(0.3).setCollisionGroups(groups(GROUP_TOOL, GROUP_LOG)),
      body,
    );
    collider.setEnabled(false);
    this.poker = { body, collider, active: false };
  }

  // ---- The fireplace ----------------------------------------------------------------------

  /** Builds the fireplace of a room (clear the logs first). */
  setRoom(room: Room) {
    const R = this.R;
    if (this.fireplace) this.world.removeRigidBody(this.fireplace);
    this.staticKind.clear();
    const fixed = this.world.createRigidBody(R.RigidBodyDesc.fixed());
    this.fireplace = fixed;
    const addStatic = (desc: RapierModule.ColliderDesc, kind: Surface, group = GROUP_STATIC) => {
      desc.setFriction(kind === 'iron' ? 0.45 : kind === 'ground' ? 0.9 : 0.7).setRestitution(0.1).setCollisionGroups(groups(group, GROUP_LOG));
      this.staticKind.set(this.world.createCollider(desc, fixed).handle, kind);
    };
    const box = (min: Vec3, max: Vec3, kind: Surface, group = GROUP_STATIC) =>
      addStatic(
        R.ColliderDesc.cuboid((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2).setTranslation(
          (min[0] + max[0]) / 2,
          (min[1] + max[1]) / 2,
          (min[2] + max[2]) / 2,
        ),
        kind,
        group,
      );
    const bar = (a: Vec3, b: Vec3, radius: number) => {
      const d = sub(b, a);
      const q = quatBetween([0, 1, 0], normalize(d));
      const c = scale(add3(a, b), 0.5);
      addStatic(R.ColliderDesc.capsule(length(d) / 2, radius).setTranslation(c[0], c[1], c[2]).setRotation(rotation(q)), 'iron');
    };
    const { frontHalfWidth: fw, backHalfWidth: bw, depth: D, height: H } = FIREBOX;
    const bed = room.bed;

    if (room.enclosure === 'open') {
      // A fire pit: the ground, the coals, a ring of stones, and an invisible fence just
      // outside the ring so logs stay in the pit.
      box([-4, -0.3, -4], [4, 0, 4], 'ground');
      // The heap of coals in the middle (clear of where logs stand their feet).
      box([bed.minX * 0.4, 0, bed.minZ * 0.4], [bed.maxX * 0.4, BED_HEIGHT * 0.4, bed.maxZ * 0.4], 'coals');
      if (room.ring) {
        for (const s of ringStones(room.ring)) {
          const points: number[] = [];
          for (let i = 0; i <= 4; i++) {
            const lat = (i / 4) * Math.PI - Math.PI / 2;
            for (let j = 0; j < 8; j++) {
              const lon = (j / 8) * Math.PI * 2 + (i % 2) * 0.4;
              points.push(Math.cos(lat) * Math.cos(lon) * s.radius, (Math.sin(lat) * 0.5 + 0.5) * s.height - s.height * 0.35, Math.cos(lat) * Math.sin(lon) * s.radius);
            }
          }
          const desc = R.ColliderDesc.convexHull(new Float32Array(points));
          if (desc) addStatic(desc.setTranslation(s.centre[0], s.centre[1], s.centre[2]).setRotation(rotation(quatAxisAngle([0, 1, 0], s.turn))), 'stone');
        }
      }
      {
        const fence = room.ring ? room.ring.outer + 0.05 : room.pit ?? 0.5;
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          const q = quatAxisAngle([0, 1, 0], -a);
          addStatic(
            R.ColliderDesc.cuboid(0.05, 0.4, fence * Math.tan(Math.PI / 16) + 0.02)
              .setTranslation(Math.cos(a) * (fence + 0.05), 0.4, Math.sin(a) * (fence + 0.05))
              .setRotation(rotation(q)),
            'wall',
            GROUP_BARRIER,
          );
        }
      }
      for (const log of this.logs.values()) log.body.wakeUp();
      return;
    }

    box([-0.9, -0.3, -0.7], [0.9, 0, 0.6], 'hearth');
    box([bed.minX, 0, bed.minZ], [bed.maxX, BED_HEIGHT * 0.7, bed.maxZ], 'coals');
    if (room.support === 'grate') {
      // The grate's bars, as one slab: logs are far wider than the gaps between them.
      box([GRATE.minX, 0, GRATE.minZ], [GRATE.maxX, GRATE.top, GRATE.maxZ], 'iron');
      // Its bars turn up at the ends, which keeps logs from rolling off.
      for (const [a, b] of grateFingers()) bar(a, b, 0.007);
    } else {
      // Andirons: the logs lie across their bars; the uprights keep them from rolling out.
      const a = ANDIRONS;
      for (const x of a.x) {
        bar([x, a.barY, a.back], [x, a.barY, a.front], a.barRadius);
        bar([x, 0, a.postZ], [x, a.postTop, a.postZ], a.postRadius);
      }
    }
    box([-0.9, -0.3, -D - 0.3], [0.9, H + 0.3, -D], 'wall');
    box([-0.9, H, -D - 0.3], [0.9, H + 0.3, 0.1], 'wall');
    // Side walls, splayed toward the back.
    for (const side of [-1, 1]) {
      const front: Vec3 = [side * fw, 0, 0];
      const back: Vec3 = [side * bw, 0, -D];
      const along = normalize(sub(back, front));
      const outward = normalize([side * D, 0, bw - fw]);
      const q = quatFromBasis(along, [0, 1, 0], cross(along, [0, 1, 0]));
      const c = add3(scale(add3(front, back), 0.5), add3(scale(outward, 0.15), [0, H / 2, 0]));
      const len = length(sub(back, front));
      addStatic(R.ColliderDesc.cuboid(len / 2 + 0.3, H / 2 + 0.3, 0.15).setTranslation(c[0], c[1], c[2]).setRotation(rotation(q)), 'wall');
    }
    // An invisible screen across the opening: logs stay in the fireplace.
    box([-0.9, 0, 0], [0.9, room.opening.apex, 0.3], 'wall', GROUP_BARRIER);
    for (const log of this.logs.values()) log.body.wakeUp();
  }

  /**
   * Adds something fixed for logs to lean on or knock against (a convex hull): an invisible prop,
   * or a kettle; returns a handle to remove it by.
   */
  addSupport(points: Vec3[], kind: Surface = 'wall'): number {
    const fixed = this.fireplace;
    const desc = this.R.ColliderDesc.convexHull(new Float32Array(points.flat()));
    if (!fixed || !desc) return -1;
    desc.setFriction(0.8).setRestitution(0).setCollisionGroups(groups(GROUP_STATIC, GROUP_LOG));
    const c = this.world.createCollider(desc, fixed);
    this.staticKind.set(c.handle, kind);
    return c.handle;
  }

  removeSupport(handle: number) {
    const c = this.world.getCollider(handle);
    if (!c) return;
    this.staticKind.delete(handle);
    this.world.removeCollider(c, true);
    for (const log of this.logs.values()) log.body.wakeUp();
  }

  // ---- Logs ---------------------------------------------------------------------------------

  addLog(id: number, pose: LogPose, logLength: number, shape: LogShape) {
    const R = this.R;
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(...pose.centre)
        .setRotation(rotation(pose.rot))
        .setLinvel(...pose.vel)
        .setAngvel(vec(pose.spin))
        .setLinearDamping(0.1)
        .setAngularDamping(1.5)
        .setCcdEnabled(true),
    );
    const colliders = shape.pieces.map((points) => {
      const desc = (R.ColliderDesc.roundConvexHull(points, BORDER) ?? R.ColliderDesc.ball(0.01))
        .setDensity(shape.density)
        .setFriction(0.8)
        .setRestitution(0)
        .setCollisionGroups(groups(GROUP_LOG, GROUP_STATIC | GROUP_LOG | GROUP_TOOL | GROUP_BARRIER));
      const c = this.world.createCollider(desc, body);
      this.owner.set(c.handle, id);
      return c;
    });
    this.logs.set(id, { id, body, colliders, length: logLength, radius: reach(shape), prevVel: [...pose.vel], age: 0, lastImpact: -1 });
  }

  /** New collision shape for a log that has burnt away (the pieces must match in number). */
  setShape(id: number, shape: LogShape) {
    const log = this.logs.get(id);
    if (!log) return;
    shape.pieces.forEach((points, i) => {
      const c = log.colliders[i];
      if (!c) return;
      c.setShape(new this.R.RoundConvexPolyhedron(points, null, BORDER));
      c.setDensity(shape.density);
    });
    log.radius = reach(shape);
    // It, and whatever rests on it, may now settle. (The rest of the fire sleeps on.)
    this.wakeAround(log);
  }

  removeLog(id: number) {
    const log = this.logs.get(id);
    if (!log) return;
    this.wakeAround(log);
    for (const c of log.colliders) this.owner.delete(c.handle);
    this.world.removeRigidBody(log.body);
    this.logs.delete(id);
    if (this.grab?.id === id) this.grab = null;
  }

  /** Wakes a log and the logs touching it. */
  private wakeAround(log: LogBody) {
    log.body.wakeUp();
    for (const c of log.colliders) {
      this.world.contactPairsWith(c, (other) => {
        const id = this.owner.get(other.handle);
        if (id !== undefined) this.logs.get(id)?.body.wakeUp();
      });
    }
  }

  has(id: number): boolean {
    return this.logs.has(id);
  }

  pose(id: number): LogPose | null {
    const log = this.logs.get(id);
    if (!log) return null;
    const b = log.body;
    const t = b.translation();
    const q = b.rotation();
    return { centre: arr(t), rot: [q.x, q.y, q.z, q.w], vel: arr(b.velocityAtPoint(t)), spin: arr(b.angvel()) };
  }

  mass(id: number): number {
    return this.logs.get(id)?.body.mass() ?? 0;
  }

  /** Gives a log a push (an impulse in N s at a world point). */
  push(id: number, impulse: Vec3, at: Vec3) {
    this.logs.get(id)?.body.applyImpulseAtPoint(vec(impulse), vec(at), true);
  }

  /** Changes gravity (m/s2, down): 9.81 on Earth, 1.62 on the Moon, 0 in orbit. */
  setGravity(g: number) {
    if (g === this.gravity) return;
    this.gravity = g;
    this.world.gravity = { x: 0, y: -g, z: 0 };
    for (const log of this.logs.values()) log.body.wakeUp();
  }

  // ---- Simulation ---------------------------------------------------------------------------

  step(dt: number) {
    this.time += dt;
    const h = dt / SUBSTEPS;
    this.world.timestep = h;
    const move = this.pokerMove;
    for (let i = 0; i < SUBSTEPS; i++) {
      this.steerHeldLog(h);
      if (move && this.poker.active) {
        const f = (i + 1) / SUBSTEPS;
        this.poker.body.setNextKinematicTranslation(vec(add3(move.from.centre, scale(sub(move.to.centre, move.from.centre), f))));
        this.poker.body.setNextKinematicRotation(rotation(quatNlerp(move.from.rot, move.to.rot, f)));
      }
      this.world.step();
    }
    this.pokerMove = null;
    this.settle(dt);
    this.findImpacts(dt);
    this.findPokes();
  }

  /** Brings a log that is barely moving to a stop (see SETTLE_SPEED). */
  private settle(dt: number) {
    const keep = Math.exp(-SETTLE_RATE * dt);
    for (const log of this.logs.values()) {
      const b = log.body;
      if (b.isSleeping() || this.grab?.id === log.id) continue;
      const v = b.linvel();
      const w = b.angvel();
      if (Math.hypot(v.x, v.y, v.z) + Math.hypot(w.x, w.y, w.z) * log.radius > SETTLE_SPEED) continue;
      b.setLinvel({ x: v.x * keep, y: v.y * keep, z: v.z * keep }, false);
      b.setAngvel({ x: w.x * keep, y: w.y * keep, z: w.z * keep }, false);
    }
  }

  private findImpacts(dt: number) {
    for (const log of this.logs.values()) {
      const v = arr(log.body.linvel());
      const expected = add3(log.prevVel, [0, -this.gravity * log.body.gravityScale() * dt, 0]);
      const dv = sub(v, expected);
      log.prevVel = v;
      if (log.age++ < 2 || this.grab?.id === log.id) continue;
      const speed = length(dv);
      if (speed < IMPACT_MIN || this.time - log.lastImpact < 0.12) continue;
      log.lastImpact = this.time;
      // Where: the contact that took the largest impulse. (The poker's pushes are reported as
      // pokes instead.)
      const hit: { impulse: number; pos: Vec3; against: Surface | 'poker' } = { impulse: -1, pos: arr(log.body.worldCom()), against: 'log' };
      for (const c of log.colliders) {
        this.world.contactPairsWith(c, (other) => {
          this.world.contactPair(c, other, (m) => {
            let impulse = 0;
            for (let i = 0; i < m.numContacts(); i++) impulse += m.contactImpulse(i);
            const n = m.numSolverContacts();
            if (n === 0 || impulse <= hit.impulse) return;
            let p: Vec3 = [0, 0, 0];
            for (let i = 0; i < n; i++) p = add3(p, arr(m.solverContactPoint(i)!));
            hit.impulse = impulse;
            hit.pos = scale(p, 1 / n);
            hit.against =
              other.handle === this.poker.collider.handle
                ? 'poker'
                : this.owner.has(other.handle)
                  ? 'log'
                  : (this.staticKind.get(other.handle) ?? 'wall');
          });
        });
      }
      if (hit.against === 'poker') continue;
      this.impacts.push({ id: log.id, pos: hit.pos, speed, energy: 0.5 * log.body.mass() * speed * speed, against: hit.against });
    }
  }

  private findPokes() {
    this.pokes.length = 0;
    if (!this.poker.active) return;
    this.world.contactPairsWith(this.poker.collider, (other) => {
      const id = this.owner.get(other.handle);
      if (id === undefined) return;
      this.world.contactPair(this.poker.collider, other, (m) => {
        if (m.numSolverContacts() > 0 && !this.pokes.some((p) => p.id === id)) this.pokes.push({ id, pos: arr(m.solverContactPoint(0)!) });
      });
    });
  }

  // ---- Queries ------------------------------------------------------------------------------

  /** The log a ray hits first. */
  pick(origin: Vec3, dir: Vec3, maxDist = 6): { id: number; point: Vec3 } | null {
    const hit = this.world.castRay(new this.R.Ray(vec(origin), vec(dir)), maxDist, true, undefined, groups(0xffff, GROUP_LOG));
    if (!hit) return null;
    const id = this.owner.get(hit.collider.handle);
    return id === undefined ? null : { id, point: add3(origin, scale(dir, hit.timeOfImpact)) };
  }

  /** What a ray hits first among the logs and the fireplace (optionally ignoring one log). */
  castScene(origin: Vec3, dir: Vec3, ignore?: number, maxDist = 6): SceneHit | null {
    const skip = ignore !== undefined ? this.logs.get(ignore)?.body : undefined;
    const hit = this.world.castRayAndGetNormal(
      new this.R.Ray(vec(origin), vec(dir)),
      maxDist,
      true,
      undefined,
      groups(0xffff, GROUP_STATIC | GROUP_LOG),
      undefined,
      skip,
    );
    if (!hit) return null;
    const id = this.owner.get(hit.collider.handle) ?? null;
    return {
      point: add3(origin, scale(dir, hit.timeOfImpact)),
      normal: arr(hit.normal),
      id,
      against: id !== null ? 'log' : (this.staticKind.get(hit.collider.handle) ?? 'wall'),
    };
  }

  /**
   * Height a log (as a capsule) would come to rest at if lowered at (x, z) along `heading`, on
   * whatever is below it (except log `ignore`, and the logs in `leaveOut`).
   */
  restHeight(x: number, z: number, heading: number, logLength: number, radius: number, ignore?: number, leaveOut?: Set<number>): number {
    const shape = new this.R.Capsule(Math.max(logLength / 2 - radius, 0.01), radius);
    const q = quatBetween([0, 1, 0], [Math.cos(heading), 0, Math.sin(heading)]);
    const top = 0.7;
    const skip = ignore !== undefined ? this.logs.get(ignore)?.body : undefined;
    const hit = this.world.castShape(
      { x, y: top, z },
      rotation(q),
      { x: 0, y: -1, z: 0 },
      shape,
      0,
      top,
      true,
      undefined,
      groups(0xffff, GROUP_STATIC | GROUP_LOG),
      undefined,
      skip,
      // (The walls are beside it, not under it.)
      (c) => this.staticKind.get(c.handle) !== 'wall' && !leaveOut?.has(this.owner.get(c.handle) ?? -1),
    );
    return hit ? top - hit.time_of_impact : radius;
  }

  /**
   * The logs lying on log `id`, and on those in turn: what it would lift if it were raised, not
   * anything it could rest on or be carried over. (Where two logs touch, the one lying on the
   * other is the higher of the two there.)
   */
  ridersOf(id: number): Set<number> {
    const riders = new Set<number>();
    const segment = (log: LogBody): [Vec3, Vec3] => {
      const pose = this.pose(log.id)!;
      const half = scale(quatRotate(pose.rot, [1, 0, 0]), log.length / 2);
      return [sub(pose.centre, half), add3(pose.centre, half)];
    };
    const under = [id];
    while (under.length) {
      const base = this.logs.get(under.pop()!);
      if (!base) continue;
      const [a0, a1] = segment(base);
      for (const log of this.logs.values()) {
        if (log.id === id || riders.has(log.id)) continue;
        const [b0, b1] = segment(log);
        const [pa, pb] = closestPoints(a0, a1, b0, b1);
        const touching = length(sub(pb, pa)) < base.radius + log.radius + 0.01;
        if (touching && pb[1] - pa[1] > 0.3 * Math.min(base.radius, log.radius)) {
          riders.add(log.id);
          under.push(log.id);
        }
      }
    }
    return riders;
  }

  /**
   * Whether a log (as a capsule) placed here would run into another log or the stones and iron
   * of the fireplace (the ground and the coals it may touch).
   */
  overlaps(centre: Vec3, rot: Quat, logLength: number, radius: number): boolean {
    const shape = new this.R.Capsule(Math.max(logLength / 2 - radius, 0.01), radius);
    const q = quatBetween([0, 1, 0], quatRotate(rot, [1, 0, 0]));
    const hit = this.world.intersectionWithShape(vec(centre), rotation(q), shape, undefined, groups(0xffff, GROUP_STATIC | GROUP_LOG), undefined, undefined, (c) => {
      const kind = this.staticKind.get(c.handle);
      return kind !== 'ground' && kind !== 'coals' && kind !== 'hearth';
    });
    return hit !== null;
  }

  // ---- Tongs ------------------------------------------------------------------------------

  get held(): number | null {
    return this.grab?.id ?? null;
  }

  /** Picks up a log at a point on (or near) it. */
  grabLog(id: number, point: Vec3): boolean {
    const log = this.logs.get(id);
    if (!log) return false;
    const pose = this.pose(id)!;
    const axis = quatRotate(pose.rot, [1, 0, 0]);
    const reach = Math.max(log.length / 2 - 0.03, 0);
    const s = Math.min(Math.max(dot(sub(point, pose.centre), axis), -reach), reach);
    const grip = add3(pose.centre, scale(axis, s));
    this.grab = { id, s, target: grip, heading: Math.atan2(axis[2], axis[0]), pitch: Math.asin(Math.max(-1, Math.min(1, axis[1]))), from: grip, carried: 0, age: 0, speed: 0, spin: 0 };
    return true;
  }

  /** Where the held log's grip point (on its axis) should go. */
  moveGrab(target: Vec3) {
    if (this.grab) this.grab.target = target;
  }

  turnGrab(angle: number) {
    if (this.grab) this.grab.heading += angle;
  }

  /** The held log, its grip point and axis, and where along it (m from the middle) it is held. */
  grip(): { id: number; point: Vec3; axis: Vec3; s: number } | null {
    const g = this.grab;
    const pose = g && this.pose(g.id);
    if (!g || !pose) return null;
    const axis = quatRotate(pose.rot, [1, 0, 0]);
    return { id: g.id, point: add3(pose.centre, scale(axis, g.s)), axis, s: g.s };
  }

  releaseGrab() {
    const g = this.grab;
    this.grab = null;
    const log = g && this.logs.get(g.id);
    if (!log) return;
    const b = log.body;
    b.setGravityScale(1, true);
    const v = arr(b.linvel());
    const sp = length(v);
    if (sp > RELEASE_SPEED) b.setLinvel(vec(scale(v, RELEASE_SPEED / sp)), true);
    const w = arr(b.angvel());
    if (length(w) > 4) b.setAngvel(vec(scale(w, 4 / length(w))), true);
    log.prevVel = arr(b.linvel());
  }

  private steerHeldLog(dt: number) {
    const g = this.grab;
    const log = g && this.logs.get(g.id);
    if (!g || !log) return;
    const b = log.body;
    const pose = this.pose(g.id)!;
    const axis = quatRotate(pose.rot, [1, 0, 0]);
    const grip = add3(pose.centre, scale(axis, g.s));

    g.age += dt;
    const hold = Math.min(1, g.age / GRAB_TIGHTEN);
    // (The tongs take its weight as their grip tightens: it isn't weightless the moment they close.)
    b.setGravityScale(1 - hold, true);
    // Turn the axis toward the wanted heading, and from the slant it was picked up at toward level
    // as it is carried away (lifted where it lies, a log leaning in a pile or a teepee keeps its
    // slant, rather than swinging round through the logs about it); let it hang on to its roll.
    // Never faster than a hand turns.
    g.carried = Math.max(g.carried, Math.hypot(grip[0] - g.from[0], grip[2] - g.from[2]));
    const pitch = g.pitch * Math.exp(-g.carried / LEVEL_DISTANCE);
    let wanted: Vec3 = [Math.cos(g.heading) * Math.cos(pitch), Math.sin(pitch), Math.sin(g.heading) * Math.cos(pitch)];
    if (dot(wanted, axis) < 0) wanted = scale(wanted, -1);
    const roll = dot(pose.spin, axis);
    let omega = sub(scale(cross(axis, wanted), 1 / TURN_TAU), scale(axis, roll * 0.5));
    const turning = length(omega);
    const turnMost = Math.min(TURN_MOST, g.spin + TURN_ACCEL * dt);
    if (turning > turnMost) omega = scale(omega, turnMost / turning);
    g.spin = Math.min(turning, turnMost);
    omega = scale(omega, 0.3 + 0.7 * hold);
    b.setAngvel(vec(omega), true);

    // Move the grip point toward the target, with limited force (building up as the grip tightens).
    let want = scale(sub(g.target, grip), 1 / GRAB_TAU);
    const sp = length(want);
    const speedMost = Math.min(GRAB_SPEED, g.speed + GRAB_ACCEL * dt);
    if (sp > speedMost) want = scale(want, speedMost / sp);
    g.speed = Math.min(sp, speedMost);
    const com = arr(b.worldCom());
    const vCom = sub(want, cross(omega, sub(grip, com)));
    let impulse = scale(sub(vCom, arr(b.linvel())), b.mass());
    const most = GRAB_FORCE * dt * hold;
    if (length(impulse) > most) impulse = scale(impulse, most / length(impulse));
    b.applyImpulse(vec(impulse), true);
  }

  // ---- Poker --------------------------------------------------------------------------------

  /** Puts the poker's tip at `tip`, its rod running back along `dir` (unit, toward the hand). */
  showPoker(tip: Vec3, dir: Vec3) {
    const { centre, rot } = pokerPose(tip, dir);
    this.poker.body.setTranslation(vec(centre), true);
    this.poker.body.setRotation(rotation(rot), true);
    this.poker.collider.setEnabled(true);
    this.poker.active = true;
  }

  /** Moves the poker over the next step (it pushes whatever is in the way). */
  movePoker(tip: Vec3, dir: Vec3) {
    const t = this.poker.body.translation();
    const r = this.poker.body.rotation();
    this.pokerMove = { from: { centre: arr(t), rot: [r.x, r.y, r.z, r.w] }, to: pokerPose(tip, dir) };
  }

  hidePoker() {
    this.poker.collider.setEnabled(false);
    this.poker.body.setTranslation({ x: 0, y: -2, z: 0 }, false);
    this.poker.active = false;
    this.pokerMove = null;
  }

  /** Clears everything (logs and tools). */
  clear() {
    for (const id of [...this.logs.keys()]) this.removeLog(id);
    this.grab = null;
    this.hidePoker();
    this.impacts.length = 0;
  }
}

/** How far a log's collision shape reaches from its axis (m). */
function reach(shape: LogShape): number {
  let most = 0;
  for (const points of shape.pieces) {
    for (let i = 0; i < points.length; i += 3) most = Math.max(most, Math.hypot(points[i + 1], points[i + 2]));
  }
  return most + BORDER;
}

/** The closest points of the segments p0-p1 and q0-q1 (one on each). */
function closestPoints(p0: Vec3, p1: Vec3, q0: Vec3, q1: Vec3): [Vec3, Vec3] {
  const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
  const d1 = sub(p1, p0);
  const d2 = sub(q1, q0);
  const r = sub(p0, q0);
  const a = dot(d1, d1);
  const e = dot(d2, d2);
  const f = dot(d2, r);
  let s = 0;
  let t = 0;
  if (a > 1e-12 && e > 1e-12) {
    const b = dot(d1, d2);
    const c = dot(d1, r);
    const denom = a * e - b * b;
    s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0;
    t = (b * s + f) / e;
    if (t < 0) {
      t = 0;
      s = clamp01(-c / a);
    } else if (t > 1) {
      t = 1;
      s = clamp01((b - c) / a);
    }
  } else if (e > 1e-12) {
    t = clamp01(f / e);
  } else if (a > 1e-12) {
    s = clamp01(-dot(d1, r) / a);
  }
  return [add3(p0, scale(d1, s)), add3(q0, scale(d2, t))];
}

function pokerPose(tip: Vec3, dir: Vec3): { centre: Vec3; rot: Quat } {
  return { centre: add3(tip, scale(dir, POKER_REACH / 2 + POKER_RADIUS)), rot: quatBetween([0, 1, 0], dir) };
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return add(a, b);
}
