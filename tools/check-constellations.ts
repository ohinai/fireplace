// Reviews src/sky/constellations.ts: every star must be in stars.bin, no segment may repeat, and
// segments should be short and between naked-eye stars. With the catalogue it also prints each
// figure by Bayer/Flamsteed designation, to compare with a star chart.
//
// Usage: node tools/check-constellations.ts [path to catalog.gz]

import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { CONSTELLATION_LINES, CONSTELLATION_NAMES } from '../src/sky/constellations.ts';
import { parseStars } from '../src/sky/stars.ts';

const LONG_DEG = 25;
const FAINT_V = 5;

const cat = parseStars(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../src/sky/stars.bin'))).buffer);
const index = new Map<number, number>();
cat.hr.forEach((hr, i) => index.set(hr, i));

// Designations from the catalogue's Name field (Flamsteed number, Bayer letter, constellation).
const names = new Map<number, string>();
if (process.argv[2]) {
  for (const l of gunzipSync(readFileSync(process.argv[2])).toString('latin1').split(/\r?\n/)) {
    if (l.length > 14) names.set(Number(l.slice(0, 4)), l.slice(7, 11).trim() ? l.slice(7, 14) : `${l.slice(4, 7).trim()} ${l.slice(11, 14)}`);
  }
}

// The figures are grouped under a comment naming each constellation.
const source = readFileSync(resolve(import.meta.dirname, '../src/sky/constellations.ts'), 'utf8');
const block = source.slice(source.indexOf('CONSTELLATION_LINES'), source.indexOf('CONSTELLATION_NAMES'));
const groups: { name: string; pairs: [number, number][] }[] = [];
for (const line of block.split('\n')) {
  const comment = line.match(/^\s*\/\/ (.+)$/);
  if (comment) groups.push({ name: comment[1], pairs: [] });
  for (const m of line.matchAll(/\[(\d+), (\d+)\]/g)) groups[groups.length - 1].pairs.push([Number(m[1]), Number(m[2])]);
}

const errors: string[] = [];
if (groups.reduce((n, g) => n + g.pairs.length, 0) !== CONSTELLATION_LINES.length) errors.push('could not read the figures from the source');
const seen = new Set<string>();
const label = (hr: number) => {
  const i = index.get(hr);
  return `${(names.get(hr) ?? '').padEnd(8)} HR ${String(hr).padStart(4)} V ${i === undefined ? '  ?  ' : cat.vmag[i].toFixed(2).padStart(5)}`;
};
const vector = (i: number) => [Math.cos(cat.dec[i]) * Math.cos(cat.ra[i]), Math.cos(cat.dec[i]) * Math.sin(cat.ra[i]), Math.sin(cat.dec[i])];

for (const { name, pairs } of groups) {
  console.log(`${name} (${pairs.length})`);
  for (const [a, b] of pairs) {
    const [ia, ib] = [index.get(a), index.get(b)];
    const key = a < b ? `${a}-${b}` : `${b}-${a}`;
    if (seen.has(key)) errors.push(`${name}: HR ${a}-${b} appears twice`);
    seen.add(key);
    if (ia === undefined || ib === undefined) {
      errors.push(`${name}: HR ${ia === undefined ? a : b} is not in stars.bin`);
      continue;
    }
    const [va, vb] = [vector(ia), vector(ib)];
    const deg = (Math.acos(Math.min(1, va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2])) * 180) / Math.PI;
    const flags = (deg > LONG_DEG ? '  LONG' : '') + (Math.max(cat.vmag[ia], cat.vmag[ib]) > FAINT_V ? '  FAINT' : '');
    console.log(`  ${label(a)}  -  ${label(b)}  ${deg.toFixed(1).padStart(5)} deg${flags}`);
  }
}
for (const { name, hr } of CONSTELLATION_NAMES) {
  if (!index.has(hr)) errors.push(`label ${name}: HR ${hr} is not in stars.bin`);
}

console.log(`\n${groups.length} constellations, ${CONSTELLATION_LINES.length} segments, ${CONSTELLATION_NAMES.length} labels`);
console.log(errors.length ? `Errors:\n  ${errors.join('\n  ')}` : 'No errors');
process.exitCode = errors.length ? 1 : 0;
