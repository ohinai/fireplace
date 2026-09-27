import { add, invert, lerp3, lookAt, multiply, normalize, perspective, project, sub, type Mat4, type Vec3 } from './math';

import type { CameraView, Room } from './rooms';

const FOV = 38; // degrees, unless a view says otherwise
const FLIGHT = 1.6; // s to move from one view to another

/** Where the eye is, what it looks at, and how wide it sees (for moving between views). */
interface Pose {
  eye: Vec3;
  target: Vec3;
  fov: number;
}

/**
 * The camera. Usually it circles the fire (orbit), limited to angles that keep a fireplace in
 * view; a view can instead stand it somewhere and let it look about (look), as when lying back
 * to look up at the stars. Changing view glides there.
 */
export class Camera {
  mode: CameraView['kind'] = 'orbit';
  yaw = 0; // orbit: round from the front (+z); look: heading round from -z (north outdoors), to the left
  pitch = 0.14; // orbit: how high the eye is above the target; look: how far up it looks
  distance = 1.75;
  target: Vec3 = [0, 0.3, -0.18]; // orbit: what it circles; look: a point straight ahead
  fovDeg = FOV;
  // Half the width (m) that should stay visible: the opening plus a little of the surround.
  halfWidth = 0.5;
  private place: Vec3 = [0, 0, 0]; // look: where the eye is
  private home = ''; // the room's first view: the one that keeps the whole fire in frame
  private fitting = true;
  private limits: Room['orbit'] = { yaw: 0.6, pitch: [-0.05, 0.5], zoom: [0.8, 2.8] };
  private zoomRange: [number, number] = [0.8, 2.8];
  private flight: { from: Pose; view: CameraView; t: number } | null = null;

  eye: Vec3 = [0, 0, 0];
  viewProj: Mat4 = new Float32Array(16);
  invViewProj: Mat4 = new Float32Array(16);

  get fovY(): number {
    return (this.fovDeg * Math.PI) / 180;
  }

  /** Frames a room's fire from its first view, straight away. */
  frame(room: Room) {
    this.halfWidth = room.frameWidth;
    this.limits = room.orbit;
    this.flight = null;
    this.home = room.views[0].key;
    this.apply(room.views[0]);
  }

  /** Goes to a view: gliding there, or at once. */
  setView(view: CameraView, glide = true) {
    this.flight = glide ? { from: { eye: [...this.eye], target: [...this.target], fov: this.fovDeg }, view, t: 0 } : null;
    if (!glide) this.apply(view);
  }

  /** The view being flown to, or null. */
  get destination(): CameraView | null {
    return this.flight?.view ?? null;
  }

  private apply(view: CameraView) {
    this.mode = view.kind;
    this.fitting = view.key === this.home;
    this.yaw = view.yaw;
    this.pitch = view.pitch;
    this.fovDeg = view.fov ?? FOV;
    if (view.kind === 'orbit') {
      this.target = [...view.target];
      this.distance = view.distance;
      this.zoomRange = [Math.min(this.limits.zoom[0], view.distance), Math.max(this.limits.zoom[1], view.distance)];
    } else {
      this.place = [...view.target];
      this.target = add(this.place, this.lookDir());
    }
  }

  /** Where the view would put the eye and what it would look at (for gliding there). */
  private poseOf(view: CameraView, aspect: number): Pose {
    const fov = view.fov ?? FOV;
    if (view.kind === 'look') {
      return { eye: [...view.target], target: add(view.target, lookDir(view.yaw, view.pitch)), fov };
    }
    const d = view.key === this.home ? this.fit(view.distance, aspect, fov) : view.distance;
    return { eye: orbitEye(view.target, view.yaw, view.pitch, d), target: [...view.target], fov };
  }

  /** On narrow (portrait) screens, back off far enough to keep the whole opening in frame (in the room's first view). */
  private fit(distance: number, aspect: number, fov: number): number {
    const fit = this.halfWidth / (aspect * Math.tan((fov * Math.PI) / 360));
    return Math.min(Math.max(distance, fit), Math.max(distance, 3.6));
  }

  private lookDir(): Vec3 {
    return lookDir(this.yaw, this.pitch);
  }

  update(aspect: number, dt = 0) {
    let pose: Pose;
    const f = this.flight;
    if (f) {
      f.t = Math.min(f.t + dt / FLIGHT, 1);
      const to = this.poseOf(f.view, aspect);
      const k = f.t * f.t * (3 - 2 * f.t);
      pose = { eye: lerp3(f.from.eye, to.eye, k), target: lerp3(f.from.target, to.target, k), fov: f.from.fov + (to.fov - f.from.fov) * k };
      this.target = pose.target;
      if (f.t >= 1) {
        this.flight = null;
        this.apply(f.view);
      }
    } else if (this.mode === 'look') {
      this.target = add(this.place, this.lookDir());
      pose = { eye: this.place, target: this.target, fov: this.fovDeg };
    } else {
      const d = this.fitting ? this.fit(this.distance, aspect, this.fovDeg) : this.distance;
      pose = { eye: orbitEye(this.target, this.yaw, this.pitch, d), target: this.target, fov: this.fovDeg };
    }
    this.eye = pose.eye;
    this.fovDeg = pose.fov;
    const up: Vec3 = Math.abs(normalize(sub(pose.target, pose.eye))[1]) > 0.999 ? [0, 0, -1] : [0, 1, 0];
    const view = lookAt(pose.eye, pose.target, up);
    // Far enough for the sky and the mountains outdoors.
    const proj = perspective(this.fovY, aspect, 0.05, 260);
    this.viewProj = multiply(proj, view);
    this.invViewProj = invert(this.viewProj);
  }

  /** Dragging: circles the fire, or (looking about) turns the head. */
  orbit(dYaw: number, dPitch: number) {
    this.land();
    if (this.mode === 'look') {
      // The sky moves with the pointer, as if dragged.
      const k = this.fovDeg / FOV;
      this.yaw = (this.yaw - dYaw * k) % (Math.PI * 2);
      this.pitch = Math.min(1.5, Math.max(-0.35, this.pitch + dPitch * k));
      return;
    }
    const { yaw, pitch } = this.limits;
    this.yaw = Number.isFinite(yaw) ? Math.min(yaw, Math.max(-yaw, this.yaw + dYaw)) : (this.yaw + dYaw) % (Math.PI * 2);
    this.pitch = Math.min(pitch[1], Math.max(pitch[0], this.pitch + dPitch));
  }

  /** Zooming: closer or further (looking about: a narrower or wider view). */
  zoom(factor: number) {
    this.land();
    if (this.mode === 'look') {
      this.fovDeg = Math.min(75, Math.max(12, this.fovDeg * factor));
      return;
    }
    this.distance = Math.min(this.zoomRange[1], Math.max(this.zoomRange[0], this.distance * factor));
  }

  /** Ends a glide at once (the viewer took over). */
  private land() {
    if (!this.flight) return;
    const view = this.flight.view;
    this.flight = null;
    this.apply(view);
  }

  /** World-space ray through a point given in normalised device coordinates. */
  ray(ndcX: number, ndcY: number): { origin: Vec3; dir: Vec3 } {
    const far = project(this.invViewProj, ndcX, ndcY, 1);
    return { origin: this.eye, dir: normalize(sub(far, this.eye)) };
  }
}

function orbitEye(target: Vec3, yaw: number, pitch: number, distance: number): Vec3 {
  const cp = Math.cos(pitch);
  return [target[0] + distance * Math.sin(yaw) * cp, target[1] + distance * Math.sin(pitch), target[2] + distance * Math.cos(yaw) * cp];
}

/** Direction of a look: yaw round from -z, turning left; pitch up from level. */
function lookDir(yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  return [-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
}
