/**
 * REpontCheck - irányítószám -> megye leképező
 *
 * A MOHU API nem ad megyét, ezért a megye-jelvényhez ezzel a scripttel
 * készítünk egy kis `data/zip-megye.json` fájlt: minden REpont irányítószámához
 * a counties.geojson (geoHungary, NUTS3) alapján a megyét írjuk.
 *
 * Futtatás:  node tools/gen-megye.mjs
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");
const COUNTIES_URL = "https://raw.githubusercontent.com/wuerdo/geoHungary/master/counties.geojson";

/** Pont a sokszögben? (ray casting, [lng, lat] koordinátákon) */
function inRing(ring, lng, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function inGeom(geom, lng, lat) {
  const t = geom.type, c = geom.coordinates;
  if (t === "Polygon") return inRing(c[0], lng, lat);
  if (t === "MultiPolygon") return c.some((poly) => inRing(poly[0], lng, lat));
  return false;
}

function bboxOf(geom) {
  const pts = [];
  const walk = (x) => {
    if (typeof x[0] === "number") pts.push(x);
    else x.forEach(walk);
  };
  walk(geom.coordinates);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

const counties = JSON.parse(await (await fetch(COUNTIES_URL)).text());
const boxes = counties.features.map((f) => bboxOf(f.geometry));

const repont = JSON.parse(await readFile(join(DATA, "repontok.json"), "utf8"));
const points = repont.points || repont;

const map = {};
let unmatched = 0;

for (const p of points) {
  const zip = p.zip ? String(p.zip) : null;
  if (!zip || map[zip]) continue;
  let megye = null;
  for (let i = 0; i < counties.features.length; i++) {
    const b = boxes[i];
    if (p.lng < b.minX || p.lng > b.maxX || p.lat < b.minY || p.lat > b.maxY) continue;
    if (inGeom(counties.features[i].geometry, p.lng, p.lat)) {
      megye = counties.features[i].properties.megye;
      break;
    }
  }
  if (megye) map[zip] = megye;
  else unmatched++;
}

const sorted = Object.fromEntries(Object.keys(map).sort().map((k) => [k, map[k]]));
await writeFile(join(DATA, "zip-megye.json"), JSON.stringify(sorted), "utf8");

console.log(`Kész: ${Object.keys(sorted).length} irányítószám -> megye, ${unmatched} pont kimaradt.`);
