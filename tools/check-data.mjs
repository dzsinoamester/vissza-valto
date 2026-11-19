/**
 * REpontCheck - adatminőség-ellenőrző
 *
 * A fetch-data.mjs után fut, hogy egy elromlott API-válasz ne kerüljön be a repóba.
 * Hibánál 1-es kilépési kóddal áll le (a workflow nem commitol), figyelmeztetésnél 0-val.
 *
 * Futtatás:
 *   node tools/check-data.mjs
 *   node tools/check-data.mjs --baseline /tmp/elozo.json   # összevetés az előző futással
 *   node tools/check-data.mjs --strict                     # a figyelmeztetés is hiba
 */

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dirname, "..", "data");

const argv = process.argv.slice(2);
const strict = argv.includes("--strict");
const baselineArg = argv.indexOf("--baseline");
const baselinePath = baselineArg > -1 ? argv[baselineArg + 1] : null;

// Magyarország durva befoglaló téglalapja – egy külföldi koordináta adathiba.
const HU = { minLat: 45.7, maxLat: 48.6, minLng: 16.0, maxLng: 22.95 };
const HOURS_RE = /^\s*(\d{1,2}):(\d{2})\s*[-\u2013]\s*(\d{1,2}):(\d{2})\s*$/;
const CLOSED_RE = /^zárva$/i;

const errors = [];
const warnings = [];

const err = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

async function readJSON(path, label) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    err(`${label}: nem olvasható (${e.message})`);
    return null;
  }
}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function hoursOk(value) {
  if (value == null) return true;
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (CLOSED_RE.test(t)) return true;
  return HOURS_RE.test(t);
}

const points = await readJSON(join(DATA, "repontok.json"), "repontok.json");

if (!Array.isArray(points)) {
  err("repontok.json: nem tömb");
} else {
  if (points.length < 1000) {
    err(`repontok.json: gyanúsan kevés pont (${points.length})`);
  }

  const ids = new Set();
  const seen = new Set();
  let dupIds = 0;
  let badCoords = 0;
  let outside = 0;
  let badName = 0;
  let badHours = 0;
  let untitled = 0;
  let noCity = 0;
  let noZip = 0;
  let badType = 0;
  let dupPlaces = 0;
  const hoursExamples = [];
  const coordExamples = [];

  for (const p of points) {
    if (!p || typeof p !== "object") {
      err("repontok.json: nem objektum a tömbben");
      break;
    }

    if (p.id == null) err("hiányzó id");
    else if (ids.has(p.id)) dupIds++;
    else ids.add(p.id);

    if (!isNum(p.lat) || !isNum(p.lng)) {
      badCoords++;
      if (coordExamples.length < 3) coordExamples.push(`${p.id}: ${p.lat}, ${p.lng}`);
    } else if (
      p.lat < HU.minLat || p.lat > HU.maxLat ||
      p.lng < HU.minLng || p.lng > HU.maxLng
    ) {
      outside++;
      if (coordExamples.length < 3) coordExamples.push(`${p.id}: ${p.lat}, ${p.lng} (országon kívül)`);
    }

    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name) badName++;
    else if (name === "Névtelen pont") untitled++;

    if (p.type !== "automata" && p.type !== "kezi") badType++;

    if (!p.city) noCity++;
    if (!p.zip) noZip++;

    for (const key of ["h", "s", "v"]) {
      const v = p.hours ? p.hours[key] : null;
      if (!hoursOk(v)) {
        badHours++;
        if (hoursExamples.length < 3) hoursExamples.push(`${p.id} ${key}: ${JSON.stringify(v)}`);
      }
    }

    // azonos nevű, azonos helyen lévő pont (duplikált felvétel)
    if (name && isNum(p.lat) && isNum(p.lng)) {
      const key = `${name.toLowerCase()}|${p.lat.toFixed(5)}|${p.lng.toFixed(5)}`;
      if (seen.has(key)) dupPlaces++;
      else seen.add(key);
    }
  }

  if (dupIds) err(`duplikált id: ${dupIds}`);
  if (badCoords) err(`hiányzó/hibás koordináta: ${badCoords} (${coordExamples.join("; ")})`);
  if (outside) err(`Magyarországon kívüli koordináta: ${outside}`);
  if (badName) err(`üres név: ${badName}`);
  if (badType) err(`ismeretlen típus: ${badType}`);
  if (noCity > points.length * 0.02) err(`település nélküli pont: ${noCity}`);
  if (noZip > points.length * 0.02) err(`irányítószám nélküli pont: ${noZip}`);

  if (badHours) warn(`nem értelmezhető nyitvatartás: ${badHours} (${hoursExamples.join("; ")})`);
  if (untitled) warn(`"Névtelen pont" nevű rekord: ${untitled}`);
  if (dupPlaces) warn(`azonos nevű és helyű pont: ${dupPlaces}`);

  if (baselinePath) {
    const base = await readJSON(baselinePath, "baseline");
    if (Array.isArray(base) && base.length) {
      const ratio = points.length / base.length;
      if (ratio < 0.9) err(`túl nagy visszaesés: ${base.length} -> ${points.length} pont`);
      else if (ratio > 1.5) warn(`gyanús növekedés: ${base.length} -> ${points.length} pont`);
    }
  }
}

const meta = await readJSON(join(DATA, "repontok-meta.json"), "repontok-meta.json");
if (meta && Array.isArray(points)) {
  if (meta.total !== points.length) err(`meta.total (${meta.total}) != pontok (${points.length})`);
  const auto = points.filter((p) => p.type === "automata").length;
  const kezi = points.filter((p) => p.type === "kezi").length;
  if (meta.automata !== auto) err(`meta.automata (${meta.automata}) != ${auto}`);
  if (meta.kezi !== kezi) err(`meta.kezi (${meta.kezi}) != ${kezi}`);
  const when = Date.parse(meta.updatedAt);
  if (!Number.isFinite(when)) err("meta.updatedAt: érvénytelen dátum");
  else if (Date.now() - when > 7 * 24 * 3600 * 1000) {
    warn(`az adat régi: ${meta.updatedAt}`);
  }
}

const changes = await readJSON(join(DATA, "changes.json"), "changes.json");
if (changes && (!changes.counts || typeof changes.counts.total !== "number")) {
  warn("changes.json: hiányzó counts");
}

const zipMap = await readJSON(join(DATA, "zip-megye.json"), "zip-megye.json");
if (zipMap && Array.isArray(points)) {
  const zips = new Set(points.map((p) => String(p.zip || "")).filter(Boolean));
  let missing = 0;
  for (const z of zips) if (!zipMap[z]) missing++;
  if (missing > zips.size * 0.02) warn(`zip-megye.json: ${missing} irányítószám hiányzik`);
}

/* --- összegzés --- */

const fail = errors.length > 0 || (strict && warnings.length > 0);

console.log(`Adatellenőrzés: ${Array.isArray(points) ? points.length : 0} pont`);
if (errors.length) {
  console.log(`\nHibák (${errors.length}):`);
  for (const e of errors) console.log(`  ✕ ${e}`);
}
if (warnings.length) {
  console.log(`\nFigyelmeztetések (${warnings.length}):`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
if (!errors.length && !warnings.length) console.log("Minden rendben.");

process.exit(fail ? 1 : 0);
