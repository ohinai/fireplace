import type { Vec3 } from '../math';
import type { TimeOfDay } from '../render/Renderer';
import { sky, type Mat3, type Place, type Sky } from './astro';

// What the sky over an outdoor scene is doing: the real sky for the place, at a moment that fits
// the time of day chosen. At night that is now, if it is night there now, else later tonight;
// at dusk, today's dusk; by day, now if it is day there, else this afternoon. It runs on in real
// time from there. From it: where the stars, the Milky Way, the Moon and the Sun are, how much
// light the Moon gives, and how bright the sky is (which decides the faintest stars one sees).

const MINUTE = 60_000;
const DEG = Math.PI / 180;

export interface NightSky {
  sky: Sky;
  starsToWorld: Mat3; // J2000 star directions to the world
  worldToGalaxy: Mat3; // world directions to galactic ones (for the Milky Way)
  moon: { dir: Vec3; lit: number; sunDir: Vec3; radius: number; up: boolean };
  sunDir: Vec3;
  sunAlt: number; // radians
  /** Light from the Moon or the Sun (direction, colour) and from the sky all round. */
  light: { dir: Vec3; colour: Vec3; ambient: Vec3 };
  faintest: number; // magnitude of the faintest stars to be seen
  milkyWay: number; // how brightly the Milky Way shows (0..1)
  skyGlow: number; // how much moonlight brightens the sky (0..1)
}

export class SkyClock {
  private start = Date.now();
  private key = '';
  private moment = 0; // ms: the sky's time when this time of day was chosen
  /** Leave the Moon out (as on a moonless night): the stars and the Milky Way at their best. */
  moonless = false;

  /** The sky over `place` for the time of day chosen (the moment is kept until either changes). */
  now(place: Place, time: TimeOfDay): NightSky {
    const key = `${place.lat},${place.lon},${time}`;
    if (key !== this.key) {
      this.key = key;
      this.start = Date.now();
      this.moment = pickMoment(place, time, this.start);
    }
    return describe(sky(new Date(this.moment + Date.now() - this.start), place), this.moonless);
  }
}

/** A moment that fits the time of day chosen, as near to now as it can be. */
function pickMoment(place: Place, time: TimeOfDay, now: number): number {
  const sunAlt = (t: number) => sky(new Date(t), place).sun.alt / DEG;
  const alt = sunAlt(now);
  if (time === 'night' && alt < -15) return now;
  if (time === 'day' && alt > 12) return now;
  // Local noon at the place (mean solar time), today.
  const day = 86_400_000;
  const noon = Math.floor((now + (place.lon / 360) * day) / day) * day + day / 2 - (place.lon / 360) * day;
  if (time === 'day') return noon + 2.5 * 60 * MINUTE;
  if (time === 'night') return noon + 10.5 * 60 * MINUTE;
  // Dusk: after sunset, when the Sun is five degrees down.
  let t = noon;
  while (t < noon + 12 * 60 * MINUTE && sunAlt(t) > -5) t += 5 * MINUTE;
  return t;
}

function describe(s: Sky, moonless: boolean): NightSky {
  const moonUp = !moonless && s.moon.alt > -0.01;
  const moonHigh = moonUp ? smooth(-0.01, 0.2, s.moon.alt) : 0;
  // A full moon is far brighter than twice a half moon: the lit surface faces us squarely.
  const moonBright = Math.pow(s.moon.illuminated, 2.3) * moonHigh;
  const sunAlt = s.sun.alt;
  const daylight = smooth(-0.12, 0.1, sunAlt); // 0 at night, 1 by day
  const twilight = smooth(-0.32, -0.05, sunAlt) * (1 - daylight);
  const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  // The Moon lights the scene at night; by day and at dusk the Sun (below the horizon at dusk,
  // it lights the sky rather than the ground).
  const moonLight: Vec3 = [0.012 * moonBright, 0.0135 * moonBright, 0.018 * moonBright];
  const sunLight: Vec3 = [0.35 * daylight, 0.33 * daylight, 0.29 * daylight];
  const useSun = daylight > 0.02;
  const ambient: Vec3 = [
    0.0012 + 0.003 * moonBright + 0.014 * twilight + 0.07 * daylight,
    0.0016 + 0.0038 * moonBright + 0.018 * twilight + 0.08 * daylight,
    0.0032 + 0.0065 * moonBright + 0.036 * twilight + 0.1 * daylight,
  ];
  // The faintest stars: about 6.3 on a dark night, fewer by moonlight, only the brightest at dusk.
  const faintest = 6.3 - 1.8 * moonBright - 5 * twilight - 12 * daylight;
  return {
    sky: s,
    starsToWorld: s.j2000ToWorld,
    worldToGalaxy: transpose(s.galacticToWorld),
    moon: { dir: s.moon.dir, lit: s.moon.illuminated, sunDir: s.moon.sunDir, radius: (1737.4 / s.moon.distKm), up: moonUp },
    sunDir: s.sun.dir,
    sunAlt,
    light: { dir: useSun ? s.sun.dir : s.moon.dir, colour: useSun ? sunLight : moonLight, ambient },
    faintest,
    milkyWay: Math.max(0, 1 - 0.85 * moonBright - 2 * twilight - 3 * daylight),
    skyGlow: moonBright,
  };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(Math.max((x - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
}
