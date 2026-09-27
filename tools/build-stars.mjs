// Builds src/sky/stars.bin from the Yale Bright Star Catalogue, 5th revised edition
// (Hoffleit & Warren 1991), CDS catalogue V/50: cdsarc.cds.unistra.fr/ftp/V/50/catalog.gz
//
// Usage: node tools/build-stars.mjs <path to catalog.gz>
//
// Output (little-endian, structure of arrays, brightest star first):
//   uint32 n
//   float32 ra[n], dec[n]   radians, J2000 equator and equinox, proper motion applied to epoch 2026.0
//   int16 vmag[n]           V magnitude x 100
//   int16 bv[n]             B-V x 100 (65, a Sun-like 0.65, when the catalogue has none)
//   uint16 hr[n]            Harvard Revised (Bright Star) number

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';

const EPOCH = 2026.0;
const ARCSEC = Math.PI / (180 * 3600);
const OUT = resolve(import.meta.dirname, '../src/sky/stars.bin');

const source = process.argv[2];
if (!source) {
  console.error('usage: node tools/build-stars.mjs <path to catalog.gz>');
  process.exit(1);
}

const lines = gunzipSync(readFileSync(source)).toString('latin1').split(/\r?\n/);
const stars = [];
for (const l of lines) {
  const field = (a, b) => l.slice(a, b).trim();
  const num = (a, b, missing) => (field(a, b) ? Number(field(a, b)) : missing);
  // Entries removed from the catalogue (novae, clusters, galaxies) have no position.
  if (!field(75, 83)) continue;
  const ra0 = ((num(75, 77) + num(77, 79) / 60 + num(79, 83) / 3600) * 15 * Math.PI) / 180;
  const dec0 = ((l[83] === '-' ? -1 : 1) * (num(84, 86) + num(86, 88) / 60 + num(88, 90) / 3600) * Math.PI) / 180;
  // Proper motion in RA is given as the great-circle rate (mu_alpha * cos(dec)).
  const years = EPOCH - 2000;
  const ra = ra0 + (num(148, 154, 0) * years * ARCSEC) / Math.cos(dec0);
  const dec = dec0 + num(154, 160, 0) * years * ARCSEC;
  stars.push({
    hr: num(0, 4),
    name: field(4, 14),
    ra: ((ra % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
    dec,
    vmag: num(102, 107),
    bv: num(109, 114, 0.65),
  });
}
stars.sort((a, b) => a.vmag - b.vmag || a.hr - b.hr);

const n = stars.length;
const buf = Buffer.alloc(4 + 14 * n);
buf.writeUInt32LE(n, 0);
stars.forEach((s, i) => {
  buf.writeFloatLE(s.ra, 4 + 4 * i);
  buf.writeFloatLE(s.dec, 4 + 4 * n + 4 * i);
  buf.writeInt16LE(Math.round(s.vmag * 100), 4 + 8 * n + 2 * i);
  buf.writeInt16LE(Math.round(s.bv * 100), 4 + 10 * n + 2 * i);
  buf.writeUInt16LE(s.hr, 4 + 12 * n + 2 * i);
});
writeFileSync(OUT, buf);

const deg = (r) => ((r * 180) / Math.PI).toFixed(3).padStart(8);
console.log(`${n} stars (V ${stars[0].vmag} to ${stars[n - 1].vmag}), ${buf.length} bytes -> ${OUT}`);
console.log('Brightest:');
for (const s of stars.slice(0, 8)) {
  const mags = `V ${s.vmag.toFixed(2).padStart(5)}  B-V ${s.bv.toFixed(2).padStart(5)}`;
  console.log(`  HR ${String(s.hr).padStart(4)}  ${s.name.padEnd(10)} ${mags}  ra ${deg(s.ra)}  dec ${deg(s.dec)}`);
}
