// Positional astronomy for the outdoor night sky: time, precession, the Sun, Moon and naked-eye
// planets, and the rotations that carry catalogue coordinates into the scene. It aims at what the
// eye can see (an arcminute or so), not at almanac precision.
//
// Conventions:
// - Angles are radians. A Place gives latitude and longitude in degrees, east positive.
// - WORLD frame: x = east, y = up (zenith), z = south. Azimuth runs from north through east.
// - Matrices are 3x3, row-major, applied to column vectors: out = M v.
// - Julian dates are UTC-based, as julianDate() makes them. The ephemerides convert to dynamical
//   time themselves (TT = UTC + 69.184 s, fixed since the 2017 leap second).
// - Positions of date are referred to the mean equator and equinox of date. Nutation (under 20")
//   is left out everywhere, so stars, Sun, Moon and planets share one frame and mean sidereal time.

import type { Vec3 } from '../math';

export interface Place {
  lat: number;
  lon: number;
}

/** 3x3 matrix, row-major. */
export type Mat3 = number[];

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;
const TAU = 2 * Math.PI;
const AU_KM = 149597870.7;
const EARTH_RADIUS_KM = 6378.14;
const LIGHT_DAYS_PER_AU = 0.0057755183;
const TT_MINUS_UTC_DAYS = 69.184 / 86400;
const J2000_OBLIQUITY = 84381.448 * ARCSEC;

const wrap = (a: number) => a - TAU * Math.floor(a / TAU);
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const angleBetween = (a: Vec3, b: Vec3) => Math.acos(Math.min(1, Math.max(-1, dot(a, b) / (norm(a) * norm(b)))));
const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

/** Julian centuries of dynamical time since J2000.0. */
const centuries = (jd: number) => (jd + TT_MINUS_UTC_DAYS - 2451545) / 36525;

export function mat3Mul(a: Mat3, b: Mat3): Mat3 {
  const out: Mat3 = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out.push(a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c]);
  }
  return out;
}

export function mat3MulVec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/**
 * Unit vector toward (ra, dec): x toward ra 0 on the equator, y toward ra 6h, z toward the north
 * pole. It serves ecliptic longitude and latitude in the same way.
 */
export function equatorialVector(ra: number, dec: number): Vec3 {
  const c = Math.cos(dec);
  return [c * Math.cos(ra), c * Math.sin(ra), Math.sin(dec)];
}

function toSpherical(v: Vec3): { ra: number; dec: number; dist: number } {
  const dist = norm(v);
  return { ra: wrap(Math.atan2(v[1], v[0])), dec: Math.asin(v[2] / dist), dist };
}

/** Mean obliquity of the ecliptic (IAU 1980). */
function obliquity(t: number): number {
  return (84381.448 - (46.815 + (0.00059 - 0.001813 * t) * t) * t) * ARCSEC;
}

function eclipticToEquatorial(v: Vec3, eps: number): Vec3 {
  const c = Math.cos(eps);
  const s = Math.sin(eps);
  return [v[0], c * v[1] - s * v[2], s * v[1] + c * v[2]];
}

// Time

/** Julian date of a moment, on the UTC time scale. */
export function julianDate(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

/** Greenwich mean sidereal time (IAU 1982, Meeus 12.4), treating UTC as UT1 (within 0.9 s). */
export function greenwichSiderealTime(jd: number): number {
  const d = jd - 2451545;
  const t = d / 36525;
  return wrap((280.46061837 + 360.98564736629 * d + (0.000387933 - t / 38710000) * t * t) * DEG);
}

export function localSiderealTime(jd: number, lonDeg: number): number {
  return wrap(greenwichSiderealTime(jd) + lonDeg * DEG);
}

/** Rotation from the J2000 mean equator and equinox to the mean equator and equinox of date (IAU 1976). */
export function precessionMatrix(jd: number): Mat3 {
  const t = centuries(jd);
  const zeta = (2306.2181 + (0.30188 + 0.017998 * t) * t) * t * ARCSEC;
  const z = (2306.2181 + (1.09468 + 0.018203 * t) * t) * t * ARCSEC;
  const theta = (2004.3109 - (0.42665 + 0.041833 * t) * t) * t * ARCSEC;
  const [cZeta, sZeta, cZ, sZ, cTheta, sTheta] = [Math.cos(zeta), Math.sin(zeta), Math.cos(z), Math.sin(z), Math.cos(theta), Math.sin(theta)];
  return [
    cZeta * cTheta * cZ - sZeta * sZ, -sZeta * cTheta * cZ - cZeta * sZ, -sTheta * cZ,
    cZeta * cTheta * sZ + sZeta * cZ, -sZeta * cTheta * sZ + cZeta * cZ, -sTheta * sZ,
    cZeta * sTheta, -sZeta * sTheta, cTheta,
  ];
}

// Sun

export interface SunPosition {
  ra: number;
  dec: number;
  /** Ecliptic longitude of date. */
  lon: number;
  distAU: number;
}

/** Apparent geocentric Sun (aberration included) of date, to about 0.01 deg (Meeus ch. 25). */
export function sunPosition(jd: number): SunPosition {
  const t = centuries(jd);
  const M = (357.52911 + (35999.05029 - 0.0001537 * t) * t) * DEG;
  const e = 0.016708634 - (0.000042037 + 0.0000001267 * t) * t;
  const C = (1.914602 - (0.004817 + 0.000014 * t) * t) * Math.sin(M) + (0.019993 - 0.000101 * t) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const distAU = (1.000001018 * (1 - e * e)) / (1 + e * Math.cos(M + C * DEG));
  const lon = wrap((280.46646 + (36000.76983 + 0.0003032 * t) * t + C) * DEG - (20.4898 * ARCSEC) / distAU);
  const { ra, dec } = toSpherical(eclipticToEquatorial(equatorialVector(lon, 0), obliquity(t)));
  return { ra, dec, lon, distAU };
}

// Moon

export interface MoonPosition {
  ra: number;
  dec: number;
  distKm: number;
}

// Meeus ch. 47 (ELP-2000/82 truncated to terms of 0.001 deg or 10 km): multiples of the arguments
// D, M, M', F, then the sine coefficient of longitude (1e-6 deg) and cosine coefficient of distance (m).
const MOON_LR = [
  [0, 0, 1, 0, 6288774, -20905355], [2, 0, -1, 0, 1274027, -3699111], [2, 0, 0, 0, 658314, -2955968], [0, 0, 2, 0, 213618, -569925],
  [0, 1, 0, 0, -185116, 48888], [0, 0, 0, 2, -114332, -3149], [2, 0, -2, 0, 58793, 246158], [2, -1, -1, 0, 57066, -152138],
  [2, 0, 1, 0, 53322, -170733], [2, -1, 0, 0, 45758, -204586], [0, 1, -1, 0, -40923, -129620], [1, 0, 0, 0, -34720, 108743],
  [0, 1, 1, 0, -30383, 104755], [2, 0, 0, -2, 15327, 10321], [0, 0, 1, 2, -12528, 0], [0, 0, 1, -2, 10980, 79661],
  [4, 0, -1, 0, 10675, -34782], [0, 0, 3, 0, 10034, -23210], [4, 0, -2, 0, 8548, -21636], [2, 1, -1, 0, -7888, 24208],
  [2, 1, 0, 0, -6766, 30824], [1, 0, -1, 0, -5163, -8379], [1, 1, 0, 0, 4987, -16675], [2, -1, 1, 0, 4036, -12831],
  [2, 0, 2, 0, 3994, -10445], [4, 0, 0, 0, 3861, -11650], [2, 0, -3, 0, 3665, 14403], [0, 1, -2, 0, -2689, -7003],
  [2, 0, -1, 2, -2602, 0], [2, -1, -2, 0, 2390, 10056], [1, 0, 1, 0, -2348, 6322], [2, -2, 0, 0, 2236, -9884],
  [0, 1, 2, 0, -2120, 5751], [0, 2, 0, 0, -2069, 0], [2, -2, -1, 0, 2048, -4950], [2, 0, 1, -2, -1773, 4130],
  [2, 0, 0, 2, -1595, 0], [4, -1, -1, 0, 1215, -3958], [0, 0, 2, 2, -1110, 0],
];

// The same for latitude: arguments, then the sine coefficient (1e-6 deg).
const MOON_B = [
  [0, 0, 0, 1, 5128122], [0, 0, 1, 1, 280602], [0, 0, 1, -1, 277693], [2, 0, 0, -1, 173237], [2, 0, -1, 1, 55413],
  [2, 0, -1, -1, 46271], [2, 0, 0, 1, 32573], [0, 0, 2, 1, 17198], [2, 0, 1, -1, 9266], [0, 0, 2, -1, 8822],
  [2, -1, 0, -1, 8216], [2, 0, -2, -1, 4324], [2, 0, 1, 1, 4200], [2, 1, 0, -1, -3359], [2, -1, -1, 1, 2463],
  [2, -1, 0, 1, 2211], [2, -1, -1, -1, 2065], [0, 1, -1, -1, -1870], [4, 0, -1, -1, 1828], [0, 1, 0, 1, -1794],
  [0, 0, 0, 3, -1749], [0, 1, -1, 1, -1565], [1, 0, 0, 1, -1491], [0, 1, 1, 1, -1475], [0, 1, 1, -1, -1410],
  [0, 1, 0, -1, -1344], [1, 0, 0, -1, -1335], [0, 0, 3, 1, 1107], [4, 0, 0, -1, 1021],
];

/** Geocentric Moon of date, within about 0.01 deg and 30 km of the full Meeus series (itself good to 10"). */
export function moonPosition(jd: number): MoonPosition {
  const t = centuries(jd);
  // Mean longitude, elongation, the Sun's and Moon's mean anomalies and argument of latitude (deg).
  const Lp = 218.3164477 + (481267.88123421 + (-0.0015786 + (1 / 538841 - t / 65194000) * t) * t) * t;
  const D = 297.8501921 + (445267.1114034 + (-0.0018819 + (1 / 545868 - t / 113065000) * t) * t) * t;
  const M = 357.5291092 + (35999.0502909 + (-0.0001536 + t / 24490000) * t) * t;
  const Mp = 134.9633964 + (477198.8675055 + (0.0087414 + (1 / 69699 - t / 14712000) * t) * t) * t;
  const F = 93.272095 + (483202.0175233 + (-0.0036539 + (-1 / 3526000 + t / 863310000) * t) * t) * t;
  // Terms in the Sun's anomaly shrink with the Earth's slowly decreasing eccentricity.
  const E = 1 - (0.002516 + 0.0000074 * t) * t;
  let l = 3958 * Math.sin((119.75 + 131.849 * t) * DEG) + 1962 * Math.sin((Lp - F) * DEG);
  let b = -2235 * Math.sin(Lp * DEG);
  let r = 0;
  for (const [d, m, mp, f, cl, cr] of MOON_LR) {
    const arg = (d * D + m * M + mp * Mp + f * F) * DEG;
    const e = E ** Math.abs(m);
    l += cl * e * Math.sin(arg);
    r += cr * e * Math.cos(arg);
  }
  for (const [d, m, mp, f, cb] of MOON_B) b += cb * E ** Math.abs(m) * Math.sin((d * D + m * M + mp * Mp + f * F) * DEG);
  const ecliptic = equatorialVector((Lp + l / 1e6) * DEG, (b / 1e6) * DEG);
  const { ra, dec } = toSpherical(eclipticToEquatorial(ecliptic, obliquity(t)));
  return { ra, dec, distKm: 385000.56 + r / 1000 };
}

/** Position seen from a place at sea level rather than the Earth's centre: the Moon shifts by up to 1 deg. */
export function topocentric(ra: number, dec: number, distKm: number, latRad: number, lstRad: number): MoonPosition {
  // The observer on the reference ellipsoid (flattening 1/298.257).
  const u = Math.atan(0.99664719 * Math.tan(latRad));
  const rhoCos = EARTH_RADIUS_KM * Math.cos(u);
  const observer: Vec3 = [rhoCos * Math.cos(lstRad), rhoCos * Math.sin(lstRad), EARTH_RADIUS_KM * 0.99664719 * Math.sin(u)];
  const s = toSpherical(sub(scale(equatorialVector(ra, dec), distKm), observer));
  return { ra: s.ra, dec: s.dec, distKm: s.dist };
}

export interface MoonPhase {
  /** Fraction of the disc that is lit, 0..1. */
  illuminated: number;
  /** Angle Sun-Moon-Earth: 0 at full moon, pi at new moon. */
  phaseAngle: number;
  /** Position angle of the middle of the bright limb, from the disc's north point (toward the celestial pole) through east. */
  brightLimbAngle: number;
}

/** The Moon's phase as seen from the Earth's centre (sky() gives it for a place, and the Sun direction for shading). */
export function moonPhase(jd: number): MoonPhase {
  const sun = sunPosition(jd);
  const moon = moonPosition(jd);
  const moonDir = equatorialVector(moon.ra, moon.dec);
  const toSun = sub(scale(equatorialVector(sun.ra, sun.dec), sun.distAU * AU_KM), scale(moonDir, moon.distKm));
  const phaseAngle = angleBetween(toSun, scale(moonDir, -1));
  const dRa = sun.ra - moon.ra;
  const brightLimbAngle = wrap(
    Math.atan2(Math.cos(sun.dec) * Math.sin(dRa), Math.sin(sun.dec) * Math.cos(moon.dec) - Math.cos(sun.dec) * Math.sin(moon.dec) * Math.cos(dRa)),
  );
  return { illuminated: (1 + Math.cos(phaseAngle)) / 2, phaseAngle, brightLimbAngle };
}

// Planets

// JPL Keplerian elements for approximate positions of the major planets (Standish, table 1, valid
// 1800-2050), mean ecliptic and equinox of J2000: a (AU), e, I, L, longitude of perihelion and
// longitude of the ascending node (deg) at J2000, then the rate of each per Julian century.
const EARTH_MOON_BARYCENTRE = [
  1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0,
  0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0,
];

interface Planet {
  name: string;
  elements: number[];
  /** Magnitude at 1 AU from the Sun and the Earth for phase angle i (deg); sinB is the sine of Saturn's ring tilt to our line of sight. */
  mag: (i: number, sinB: number) => number;
}

// Magnitudes after Mallama & Hilton 2018 (the Astronomical Almanac's formulae).
const PLANETS: Planet[] = [
  {
    name: 'Mercury',
    elements: [
      0.38709927, 0.20563593, 7.00497902, 252.2503235, 77.45779628, 48.33076593,
      0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081,
    ],
    mag: (i) => -0.613 + i * (6.328e-2 + i * (-1.6336e-3 + i * (3.3644e-5 + i * (-3.4265e-7 + i * (1.6893e-9 - 3.0334e-12 * i))))),
  },
  {
    name: 'Venus',
    elements: [
      0.72333566, 0.00677672, 3.39467605, 181.9790995, 131.60246718, 76.67984255,
      0.0000039, -0.00004107, -0.0007889, 58517.81538729, 0.00268329, -0.27769418,
    ],
    // Near inferior conjunction forward scattering by the clouds brightens the thin crescent.
    mag: (i) => (i < 163.7 ? -4.384 + i * (-1.044e-3 + i * (3.687e-4 + i * (-2.814e-6 + 8.938e-9 * i))) : 236.05828 + i * (-2.81914 + 8.39034e-3 * i)),
  },
  {
    name: 'Mars',
    elements: [
      1.52371034, 0.0933941, 1.84969142, -4.55343205, -23.94362959, 49.55953891,
      0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343,
    ],
    // Valid to a phase angle of 50 deg; from the Earth it never exceeds 47.
    mag: (i) => -1.601 + i * (2.267e-2 - 1.302e-4 * i),
  },
  {
    name: 'Jupiter',
    elements: [
      5.202887, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909,
      -0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106,
    ],
    mag: (i) => -9.395 + i * (-3.7e-4 + 6.16e-4 * i),
  },
  {
    name: 'Saturn',
    elements: [
      9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448,
      -0.0012506, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794,
    ],
    // Globe and rings: open rings add light, with a surge in brightness right at opposition.
    mag: (i, sinB) => -8.914 - 1.825 * sinB + 0.026 * i - 0.378 * sinB * Math.exp(-2.25 * i),
  },
];

// Saturn's north pole (J2000), the axis of its rings.
const SATURN_POLE = equatorialVector(40.589 * DEG, 83.537 * DEG);

/** Heliocentric position (AU, J2000 equatorial) from orbital elements, t in Julian centuries of TT. */
function heliocentric(el: number[], t: number): Vec3 {
  const [a, e, incl, L, peri, node] = el.slice(0, 6).map((v, k) => v + el[k + 6] * t);
  const M = wrap((L - peri) * DEG + Math.PI) - Math.PI;
  // Kepler's equation by Newton's method; a few steps suffice for these small eccentricities.
  let E = M + e * Math.sin(M);
  for (let k = 0; k < 5; k++) E -= (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
  const x = a * (Math.cos(E) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  const w = (peri - node) * DEG;
  const [cw, sw, cO, sO, cI, sI] = [Math.cos(w), Math.sin(w), Math.cos(node * DEG), Math.sin(node * DEG), Math.cos(incl * DEG), Math.sin(incl * DEG)];
  const ecliptic: Vec3 = [
    (cw * cO - sw * sO * cI) * x - (sw * cO + cw * sO * cI) * y,
    (cw * sO + sw * cO * cI) * x + (cw * cO * cI - sw * sO) * y,
    sw * sI * x + cw * sI * y,
  ];
  return eclipticToEquatorial(ecliptic, J2000_OBLIQUITY);
}

export interface PlanetPosition {
  name: string;
  ra: number;
  dec: number;
  distAU: number;
  mag: number;
}

/** Apparent geocentric places of date and visual magnitudes of Mercury, Venus, Mars, Jupiter and Saturn. */
export function planetPositions(jd: number): PlanetPosition[] {
  const t = centuries(jd);
  const toDate = precessionMatrix(jd);
  return PLANETS.map(({ name, elements, mag }) => {
    // We see the planet where it was when its light left. Taking the Earth back by the same
    // light time as well adds the aberration from the Earth's motion.
    const lightDays = norm(sub(heliocentric(elements, t), heliocentric(EARTH_MOON_BARYCENTRE, t))) * LIGHT_DAYS_PER_AU;
    const tl = t - lightDays / 36525;
    const helio = heliocentric(elements, tl);
    const geo = sub(helio, heliocentric(EARTH_MOON_BARYCENTRE, tl));
    const phase = angleBetween(helio, geo) / DEG;
    const sinB = Math.abs(dot(SATURN_POLE, geo)) / norm(geo);
    const { ra, dec, dist } = toSpherical(mat3MulVec(toDate, geo));
    return { name, ra, dec, distAU: dist, mag: 5 * Math.log10(norm(helio) * dist) + mag(phase, sinB) };
  });
}

// The observer's frame

/** Altitude and azimuth (from north through east) of a position of date. */
export function equatorialToHorizontal(ra: number, dec: number, latRad: number, lstRad: number): { alt: number; az: number } {
  const ha = lstRad - ra;
  const sinAlt = Math.sin(latRad) * Math.sin(dec) + Math.cos(latRad) * Math.cos(dec) * Math.cos(ha);
  const az = Math.atan2(-Math.cos(dec) * Math.sin(ha), Math.cos(latRad) * Math.sin(dec) - Math.sin(latRad) * Math.cos(dec) * Math.cos(ha));
  return { alt: Math.asin(Math.min(1, Math.max(-1, sinAlt))), az: wrap(az) };
}

export function horizontalToWorld(alt: number, az: number): Vec3 {
  return [Math.cos(alt) * Math.sin(az), Math.sin(alt), -Math.cos(alt) * Math.cos(az)];
}

/** Rotation from equatorial coordinates of date to WORLD, for a latitude and local sidereal time. */
export function equatorialToWorldMatrix(latRad: number, lstRad: number): Mat3 {
  const [cl, sl, ct, st] = [Math.cos(latRad), Math.sin(latRad), Math.cos(lstRad), Math.sin(lstRad)];
  return [
    -st, ct, 0,
    cl * ct, cl * st, sl,
    sl * ct, sl * st, -cl,
  ];
}

/** J2000 equatorial to galactic coordinates (rows: toward the galactic centre, toward l = 90 deg, toward the north galactic pole). */
export const J2000_TO_GALACTIC: Mat3 = [
  -0.0548755604, -0.8734370902, -0.4838350155,
  0.4941094279, -0.44482963, 0.7469822445,
  -0.867666149, -0.1980763734, 0.4559837762,
];

/**
 * Refraction to add to a true altitude (Saemundsson 1986, at 10 C and 1010 hPa): 29' at the
 * horizon, 1' at 45 deg. Below -1 deg it fades out by -5 deg, keeping the lift continuous and
 * monotonic while a Sun in twilight keeps its true depression.
 */
export function refraction(altRad: number): number {
  const h = Math.max(altRad / DEG, -1);
  const fade = Math.min(1, Math.max(0, (altRad / DEG + 5) / 4));
  return Math.max(0, 1.02 / Math.tan((h + 10.3 / (h + 5.11)) * DEG)) * fade * (DEG / 60);
}

// Everything for one moment

export interface Sky {
  jd: number;
  lst: number;
  /** J2000 unit vectors (the star catalogue) to WORLD: precession, then the observer's frame; no refraction. */
  j2000ToWorld: Mat3;
  /** Galactic unit vectors (x toward the centre, z toward the north galactic pole) to WORLD. */
  galacticToWorld: Mat3;
  sun: { dir: Vec3; alt: number };
  /** dir is topocentric; sunDir points from the Moon toward the Sun, for lighting its disc; distKm is from the observer. */
  moon: { dir: Vec3; alt: number; illuminated: number; sunDir: Vec3; distKm: number };
  planets: { name: string; dir: Vec3; alt: number; mag: number }[];
}

/** The sky over a place at a moment. Directions and altitudes of the Sun, Moon and planets are apparent: refraction included. */
export function sky(date: Date, place: Place): Sky {
  const jd = julianDate(date);
  const lat = place.lat * DEG;
  const lst = localSiderealTime(jd, place.lon);
  const toWorld = equatorialToWorldMatrix(lat, lst);
  const j2000ToWorld = mat3Mul(toWorld, precessionMatrix(jd));
  const seen = (ra: number, dec: number) => {
    const h = equatorialToHorizontal(ra, dec, lat, lst);
    const alt = h.alt + refraction(h.alt);
    return { dir: horizontalToWorld(alt, h.az), alt };
  };
  const sun = sunPosition(jd);
  const moon = moonPosition(jd);
  const topo = topocentric(moon.ra, moon.dec, moon.distKm, lat, lst);
  // The lit half of the Moon faces the Sun; how much of it we see depends on our line of sight.
  const toSun = sub(scale(equatorialVector(sun.ra, sun.dec), sun.distAU * AU_KM), scale(equatorialVector(moon.ra, moon.dec), moon.distKm));
  const sunDir = scale(toSun, 1 / norm(toSun));
  const illuminated = (1 - dot(sunDir, equatorialVector(topo.ra, topo.dec))) / 2;
  return {
    jd,
    lst,
    j2000ToWorld,
    galacticToWorld: mat3Mul(j2000ToWorld, transpose(J2000_TO_GALACTIC)),
    sun: seen(sun.ra, sun.dec),
    moon: { ...seen(topo.ra, topo.dec), illuminated, sunDir: mat3MulVec(toWorld, sunDir), distKm: topo.distKm },
    planets: planetPositions(jd).map((p) => ({ name: p.name, ...seen(p.ra, p.dec), mag: p.mag })),
  };
}
