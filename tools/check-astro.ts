// Checks src/sky/astro.ts against published events and worked examples, and the WORLD-frame
// matrices against the direct formulas. Run: node tools/check-astro.ts (prints a pass/fail table).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  equatorialToHorizontal, equatorialToWorldMatrix, equatorialVector, greenwichSiderealTime, horizontalToWorld, J2000_TO_GALACTIC,
  julianDate, mat3Mul, mat3MulVec, moonPhase, moonPosition, planetPositions, precessionMatrix, refraction, sky, sunPosition, topocentric,
} from '../src/sky/astro.ts';
import type { Mat3 } from '../src/sky/astro.ts';
import type { Vec3 } from '../src/math.ts';
import { parseStars } from '../src/sky/stars.ts';

const DEG = Math.PI / 180;
const TT_DAYS = 69.184 / 86400; // worked examples are given in dynamical time; the API takes UTC
const rows: { name: string; expected: string; got: string; pass: boolean }[] = [];
const check = (name: string, expected: string, got: string, pass: boolean) => rows.push({ name, expected, got, pass });

const jdOf = (iso: string) => julianDate(new Date(iso));
const f = (x: number, digits = 3) => x.toFixed(digits);
const wrapPi = (a: number) => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));
// Angle between unit vectors from their chord, which stays precise for tiny angles (acos does not).
const angle = (a: Vec3, b: Vec3) => 2 * Math.asin(Math.min(1, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) / 2));
const sep = (ra1: number, dec1: number, ra2: number, dec2: number) => angle(equatorialVector(ra1, dec1), equatorialVector(ra2, dec2)) / DEG;
// Sexagesimal text, rounded to 0.01 s first so that 59.999 s does not print as 60.00.
const sexagesimal = (units: number, a: string, b: string, c: string) => {
  const s = Math.round(units * 360000) / 100;
  return `${Math.floor(s / 3600)}${a}${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}${b}${f(s % 60, 2).padStart(5, '0')}${c}`;
};
const hms = (rad: number) => sexagesimal((((rad / DEG / 15) % 24) + 24) % 24, 'h', 'm', 's');
const dms = (rad: number) => (rad < 0 ? '-' : '+') + sexagesimal(Math.abs(rad / DEG), 'd', "'", '"');
const hmsToRad = (h: number, m: number, s: number) => (h + m / 60 + s / 3600) * 15 * DEG;
const dmsToRad = (sign: number, d: number, m: number, s: number) => sign * (d + m / 60 + s / 3600) * DEG;
const utc = (jd: number) => new Date((jd - 2440587.5) * 86400000).toISOString().slice(0, 16).replace('T', ' ');

// Mean ecliptic longitude of an equatorial position of date (for timing new and full moons).
const EPS_2026 = 23.4359 * DEG;
const eclipticLon = (ra: number, dec: number) => {
  const v = equatorialVector(ra, dec);
  return Math.atan2(Math.cos(EPS_2026) * v[1] + Math.sin(EPS_2026) * v[2], v[0]);
};
const moonMinusSun = (jd: number) => {
  const m = moonPosition(jd);
  const s = sunPosition(jd);
  return wrapPi(eclipticLon(m.ra, m.dec) - eclipticLon(s.ra, s.dec));
};
/** Root of g near jd (g increasing through zero), by bisection over jd +- half (days). */
const solve = (g: (jd: number) => number, jd: number, half = 1) => {
  let [a, b] = [jd - half, jd + half];
  for (let i = 0; i < 50; i++) {
    const mid = (a + b) / 2;
    if (g(mid) < 0) a = mid;
    else b = mid;
  }
  return (a + b) / 2;
};

// Time and sidereal time

{
  const jd = jdOf('2000-01-01T12:00:00Z');
  check('JD of 2000-01-01 12:00 UTC', '2451545.0', String(jd), jd === 2451545);
  const gmst = (greenwichSiderealTime(jd) / DEG) / 15;
  check('GMST at J2000.0', '18.697374558 h (1 s)', `${f(gmst, 9)} h`, Math.abs(gmst - 18.697374558) * 3600 < 1);
  for (const [iso, h, m, s, label] of [
    ['1987-04-10T00:00:00Z', 13, 10, 46.3668, 'Meeus 12.a'],
    ['1987-04-10T19:21:00Z', 8, 34, 57.0896, 'Meeus 12.b'],
  ] as const) {
    const got = greenwichSiderealTime(jdOf(iso));
    const err = (wrapPi(got - hmsToRad(h, m, s)) / DEG) * 240;
    check(`GMST ${label}`, `${h}h${m}m${s}s (0.01 s)`, hms(got), Math.abs(err) < 0.01);
  }
}

// Precession: Meeus example 21.b, theta Persei from J2000 to 2028 Nov 13.19 TD (proper motion included).

{
  const jdTT = 2462088.69;
  const years = (jdTT - 2451545) / 365.25;
  const ra0 = hmsToRad(2, 44, 11.986 + 0.03425 * years);
  const dec0 = dmsToRad(1, 49, 13, 42.48 - 0.0895 * years);
  const v = mat3MulVec(precessionMatrix(jdTT - TT_DAYS), equatorialVector(ra0, dec0));
  const ra = Math.atan2(v[1], v[0]);
  const dec = Math.asin(v[2]);
  const err = sep(ra, dec, hmsToRad(2, 46, 11.331), dmsToRad(1, 49, 20, 54.54)) * 3600;
  check('Precession (Meeus 21.b)', '2h46m11.331s +49d20\'54.54" (0.5")', `${hms(ra)} ${dms(dec)}`, err < 0.5);
}

// Sun

{
  const s = sunPosition(2448908.5 - TT_DAYS);
  const err = sep(s.ra, s.dec, hmsToRad(13, 13, 31.4), dmsToRad(-1, 7, 47, 6));
  check('Sun 1992-10-13 0h TD (Meeus 25.a)', '13h13m31.4s -7d47\'06" (0.01 deg)', `${hms(s.ra)} ${dms(s.dec)}`, err < 0.01);
  const eq = sunPosition(jdOf('2026-03-20T14:46:00Z'));
  check('Sun dec at March equinox 2026-03-20 14:46', '0 (0.02 deg)', `${f(eq.dec / DEG, 4)} deg`, Math.abs(eq.dec / DEG) < 0.02);
  const sol = sunPosition(jdOf('2026-06-21T08:24:00Z'));
  check('Sun dec at June solstice 2026-06-21 08:24', '+23.436 (0.01 deg)', `${f(sol.dec / DEG, 4)} deg`, Math.abs(sol.dec / DEG - 23.436) < 0.01);

  // Sunrise and sunset at Greenwich on the solstice: the upper limb (semi-diameter 15.7') on the horizon.
  const greenwich = { lat: 51.4769, lon: 0 };
  const limb = (jd: number) => sky(new Date((jd - 2440587.5) * 86400000), greenwich).sun.alt / DEG + 15.7 / 60;
  const rise = solve(limb, jdOf('2026-06-21T03:43:00Z'), 0.1);
  const set = solve((jd) => -limb(jd), jdOf('2026-06-21T20:21:00Z'), 0.1);
  const off = [rise - jdOf('2026-06-21T03:43:00Z'), set - jdOf('2026-06-21T20:21:00Z')].map((d) => Math.abs(d) * 1440);
  check('Greenwich sunrise, sunset 2026-06-21', '03:43, 20:21 UT (2 min)', `${utc(rise).slice(11)}, ${utc(set).slice(11)} UT`, Math.max(...off) < 2);
}

// Moon

{
  const m = moonPosition(2448724.5 - TT_DAYS);
  const err = sep(m.ra, m.dec, 134.68847 * DEG, 13.768368 * DEG);
  check('Moon 1992-04-12 0h TD (Meeus 47.a)', 'ra 134.6885 dec 13.7684 (0.02 deg)', `ra ${f(m.ra / DEG, 4)} dec ${f(m.dec / DEG, 4)}`, err < 0.02);
  check('Moon distance (Meeus 47.a)', '368409.7 km (50 km)', `${f(m.distKm, 1)} km`, Math.abs(m.distKm - 368409.7) < 50);

  // Total solar eclipse of 2026-08-12, greatest eclipse 17:46 UT at 65.2 N 25.2 W (gamma 0.898).
  const jdSolar = jdOf('2026-08-12T17:46:00Z');
  const ms = moonPosition(jdSolar);
  const ss = sunPosition(jdSolar);
  const geo = sep(ms.ra, ms.dec, ss.ra, ss.dec);
  // With gamma 0.898 the shadow axis passes 0.898 Earth radii from the centre, so seen from there
  // the Moon stands about gamma x (lunar - solar parallax) off the Sun's centre.
  const expected = 0.898 * (Math.asin(6378.14 / ms.distKm) / DEG - 8.794 / 3600 / ss.distAU);
  check('Solar eclipse 2026-08-12 17:46: geocentric Moon-Sun', `< 1 deg, ~${f(expected, 2)} from gamma`, `${f(geo)} deg`,
    geo < 1 && Math.abs(geo - expected) < 0.05);
  const lat = 65.2 * DEG;
  const lst = greenwichSiderealTime(jdSolar) - 25.2 * DEG;
  const mt = topocentric(ms.ra, ms.dec, ms.distKm, lat, lst);
  const topo = sep(mt.ra, mt.dec, ss.ra, ss.dec);
  check('  same, topocentric at 65.2 N 25.2 W', '< 0.05 deg (Sun covered)', `${f(topo)} deg`, topo < 0.05);

  // Total lunar eclipse of 2026-03-03, greatest 11:34 UT.
  const jdLunar = jdOf('2026-03-03T11:34:00Z');
  const ml = moonPosition(jdLunar);
  const sl = sunPosition(jdLunar);
  const anti = sep(ml.ra, ml.dec, sl.ra + Math.PI, -sl.dec);
  check('Lunar eclipse 2026-03-03 11:34: Moon from anti-Sun', '< 1 deg', `${f(anti)} deg`, anti < 1);

  const jdNew = jdOf('2026-01-18T19:52:00Z');
  const kNew = moonPhase(jdNew).illuminated;
  check('New moon 2026-01-18 19:52: illuminated', '~0 (< 0.01)', f(kNew, 4), kNew < 0.01);
  const tNew = solve(moonMinusSun, jdNew);
  check('  time of new moon', '19:52 UT (3 min)', `${utc(tNew)} UT`, Math.abs(tNew - jdNew) * 1440 < 3);

  const jdFull = jdOf('2026-09-26T16:49:00Z');
  const kFull = moonPhase(jdFull).illuminated;
  check('Full moon 2026-09-26 16:49: illuminated', '~1 (> 0.99)', f(kFull, 4), kFull > 0.99);
  const tFull = solve((jd) => wrapPi(moonMinusSun(jd) - Math.PI), jdFull);
  check('  time of full moon', '16:49 UT (3 min)', `${utc(tFull)} UT`, Math.abs(tFull - jdFull) * 1440 < 3);

  // First quarter 2026-09-18: the lit limb faces the Sun, west of the Moon in the evening sky.
  const q = moonPhase(jdOf('2026-09-18T20:44:00Z'));
  check('First quarter 2026-09-18 20:44', 'illum 0.5, limb PA ~270 (west)', `illum ${f(q.illuminated, 3)}, PA ${f(q.brightLimbAngle / DEG, 1)}`,
    Math.abs(q.illuminated - 0.5) < 0.02 && Math.abs(q.brightLimbAngle / DEG - 270) < 30);

  // Parallax on the horizon: an equatorial observer 6 h west of the Moon has it rising.
  const mp = moonPosition(jdFull);
  const hp = topocentric(mp.ra, mp.dec, mp.distKm, 0, mp.ra - Math.PI / 2);
  const altTopo = equatorialToHorizontal(hp.ra, hp.dec, 0, mp.ra - Math.PI / 2).alt / DEG;
  const parallax = Math.asin(6378.14 / mp.distKm) / DEG;
  check('Moon parallax at the horizon', `alt -${f(parallax, 4)} (0.001 deg)`, f(altTopo, 4), Math.abs(altTopo + parallax) < 0.001);
}

// Planets

const planet = (jd: number, name: string) => planetPositions(jd).find((p) => p.name === name)!;
const elongation = (jd: number, name: string) => {
  const p = planet(jd, name);
  const s = sunPosition(jd);
  return sep(p.ra, p.dec, s.ra, s.dec);
};

{
  const jd = jdOf('2020-12-21T18:20:00Z');
  const j = planet(jd, 'Jupiter');
  const s = planet(jd, 'Saturn');
  const d = sep(j.ra, j.dec, s.ra, s.dec);
  check('Jupiter-Saturn 2020-12-21 18:20: separation', '0.102 deg (0.03)', `${f(d)} deg`, Math.abs(d - 0.102) < 0.03);
  let best = { jd, d };
  for (let t = jd - 3; t < jd + 3; t += 1 / 96) {
    const a = planet(t, 'Jupiter');
    const b = planet(t, 'Saturn');
    const dd = sep(a.ra, a.dec, b.ra, b.dec);
    if (dd < best.d) best = { jd: t, d: dd };
  }
  check('  closest approach', '2020-12-21 18:20 UT (12 h)', `${utc(best.jd)} UT, ${f(best.d)} deg`, Math.abs(best.jd - jd) < 0.5);
  // Published places are J2000 (astrometric), so undo the precession to compare.
  const toJ2000 = (p: typeof j) => {
    const m = precessionMatrix(jd);
    const v = mat3MulVec([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]], equatorialVector(p.ra, p.dec));
    return { ra: Math.atan2(v[1], v[0]), dec: Math.asin(v[2]) };
  };
  const [jj, sj] = [toJ2000(j), toJ2000(s)];
  const near = (p: { ra: number; dec: number }) => sep(p.ra, p.dec, hmsToRad(20, 10, 0), -20.5 * DEG);
  check('  both near ra 20h10m dec -20.5 (J2000)', '< 0.25 deg', `J ${hms(jj.ra)} ${f(jj.dec / DEG, 2)}, S ${hms(sj.ra)} ${f(sj.dec / DEG, 2)}`,
    near(jj) < 0.25 && near(sj) < 0.25);
}
{
  const jd = jdOf('2020-10-13T23:20:00Z');
  const e = elongation(jd, 'Mars');
  const m = planet(jd, 'Mars').mag;
  check('Mars opposition 2020-10-13: elongation', '> 175 deg', `${f(e, 2)} deg`, e > 175);
  check('  magnitude', '-2.6 (0.15)', f(m, 2), Math.abs(m + 2.6) < 0.15);
}
{
  const jd = jdOf('2023-06-04T11:00:00Z');
  const e = elongation(jd, 'Venus');
  const m = planet(jd, 'Venus').mag;
  const peak = Math.max(elongation(jd - 3, 'Venus'), elongation(jd + 3, 'Venus')) < e;
  check('Venus greatest elongation 2023-06-04', '45.4 deg (0.3), a maximum', `${f(e, 2)} deg${peak ? ', max' : ', NOT max'}`, Math.abs(e - 45.4) < 0.3 && peak);
  check('  magnitude', '-4.4 (0.15)', f(m, 2), Math.abs(m + 4.4) < 0.15);
}

// Horizon and WORLD frame, using the catalogue the renderer draws

const cat = parseStars(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../src/sky/stars.bin'))).buffer);
const star = (hr: number) => {
  const i = cat.hr.indexOf(hr);
  return equatorialVector(cat.ra[i], cat.dec[i]);
};
const altitudes = (v: Vec3, lat: number, lon: number, date: string) => {
  const out: number[] = [];
  for (let k = 0; k < 288; k++) {
    const s = sky(new Date(Date.parse(date) + k * 300000), { lat, lon });
    out.push(Math.asin(mat3MulVec(s.j2000ToWorld, v)[1]) / DEG);
  }
  return out;
};
{
  const alts = altitudes(star(424), 45, 10, '2026-12-01T00:00:00Z');
  const worst = Math.max(...alts.map((a) => Math.abs(a - 45)));
  check('Polaris from 45 N over a day', 'alt within 1 deg of 45', `${f(Math.min(...alts), 2)}..${f(Math.max(...alts), 2)}`, worst < 1);
  const top = Math.max(...altitudes(star(2491), 31, -100, '2026-01-15T00:00:00Z'));
  check('Sirius transit from 31 N', '42.25 (90 - 31 - 16.75), 0.05', `${f(top, 3)} deg (+${f(refraction(top * DEG) / DEG * 60, 2)}' refraction)`,
    Math.abs(top - 42.25) < 0.05);
}
{
  // Matrices against the direct formulas, for random stars, times and places.
  let worst = 0;
  let seed = 12345;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < 200; k++) {
    const i = Math.floor(rnd() * cat.count);
    const place = { lat: rnd() * 180 - 90, lon: rnd() * 360 - 180 };
    const date = new Date(Date.UTC(1990, 0, 1) + rnd() * 60 * 365.25 * 86400000);
    const s = sky(date, place);
    const v = equatorialVector(cat.ra[i], cat.dec[i]);
    const ofDate = mat3MulVec(precessionMatrix(s.jd), v);
    const h = equatorialToHorizontal(Math.atan2(ofDate[1], ofDate[0]), Math.asin(ofDate[2]), place.lat * DEG, s.lst);
    worst = Math.max(worst, angle(mat3MulVec(s.j2000ToWorld, v), horizontalToWorld(h.alt, h.az)));
    const direct = equatorialToWorldMatrix(place.lat * DEG, s.lst);
    worst = Math.max(worst, angle(mat3MulVec(direct, ofDate), horizontalToWorld(h.alt, h.az)));
  }
  check('j2000ToWorld = alt/az formulas (200 stars)', '< 1e-9 rad', `${worst.toExponential(1)} rad`, worst < 1e-9);

  const s = sky(new Date('2026-07-15T03:00:00Z'), { lat: 40, lon: -105 });
  const gc = mat3MulVec(s.j2000ToWorld, equatorialVector(hmsToRad(17, 45, 37.224), dmsToRad(-1, 28, 56, 10.23)));
  const ngp = mat3MulVec(s.j2000ToWorld, equatorialVector(hmsToRad(12, 51, 26.28), dmsToRad(1, 27, 7, 42.0)));
  const eGc = angle(mat3MulVec(s.galacticToWorld, [1, 0, 0]), gc) / DEG;
  const eNgp = angle(mat3MulVec(s.galacticToWorld, [0, 0, 1]), ngp) / DEG;
  check('galacticToWorld: centre and north pole', '< 0.001 deg', `${f(eGc, 5)}, ${f(eNgp, 5)} deg`, eGc < 0.001 && eNgp < 0.001);
  const orth = (m: Mat3) => Math.max(...mat3Mul(m, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]).map((x, i) => Math.abs(x - (i % 4 === 0 ? 1 : 0))));
  const e = Math.max(orth(J2000_TO_GALACTIC), orth(s.j2000ToWorld), orth(s.galacticToWorld));
  check('Matrices orthonormal', '< 1e-9', e.toExponential(1), e < 1e-9);

  const r0 = (refraction(0) / DEG) * 60;
  const r45 = (refraction(45 * DEG) / DEG) * 60;
  check('Refraction at 0 and 45 deg', "~29' and ~1.0'", `${f(r0, 2)}' ${f(r45, 2)}'`, Math.abs(r0 - 29) < 1 && Math.abs(r45 - 1) < 0.05);
  let monotonic = true;
  let jump = 0;
  for (let a = -10; a < 90; a += 0.01) {
    const [lo, hi] = [a * DEG, (a + 0.01) * DEG];
    monotonic &&= hi + refraction(hi) > lo + refraction(lo);
    jump = Math.max(jump, Math.abs(refraction(hi) - refraction(lo)) / DEG);
  }
  check('Refraction continuous and monotonic', "steps < 0.01 deg, none at -6", `max step ${f(jump, 4)} deg, ${f(refraction(-6 * DEG), 1)} at -6`,
    monotonic && jump < 0.01 && refraction(-6 * DEG) === 0);

  const sunAlt = Math.asin(s.sun.dir[1]);
  const k = moonPhase(s.jd).illuminated;
  check('sky(): alt matches dir, phase matches', 'alt = asin(dir.y); illum ~ moonPhase',
    `d ${Math.abs(sunAlt - s.sun.alt).toExponential(1)}, illum ${f(s.moon.illuminated)} vs ${f(k)}`,
    Math.abs(sunAlt - s.sun.alt) < 1e-12 && Math.abs(s.moon.illuminated - k) < 0.01 && s.planets.length === 5);
  // Seen from the Moon the Sun is at most 0.15 deg from where we see it (the Moon is 390 times nearer).
  const sp = sunPosition(s.jd);
  const trueSun = equatorialToHorizontal(sp.ra, sp.dec, 40 * DEG, s.lst);
  const moonSun = angle(s.moon.sunDir, horizontalToWorld(trueSun.alt, trueSun.az)) / DEG;
  check('sky(): moon.sunDir toward the Sun', '< 0.2 deg from the true Sun', `${f(moonSun)} deg`, moonSun < 0.2);
}

// Report

const width = [0, 1, 2].map((c) => Math.max(...rows.map((r) => [r.name, r.expected, r.got][c].length)));
for (const r of rows) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width[0])}  ${r.expected.padEnd(width[1])}  ${r.got}`);
const failed = rows.filter((r) => !r.pass).length;
console.log(`\n${rows.length - failed}/${rows.length} passed`);
process.exitCode = failed ? 1 : 0;
