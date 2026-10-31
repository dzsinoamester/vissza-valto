/**
 * REpontCheck - adatfrissítő eszköz
 *
 * Letölti a MOHU nyilvános térkép API-járól az összes DRS (REpont) pontot,
 * majd az egyes pontok részleteit (nyitvatartás) is, és JSON fájlba menti.
 *
 * Futtatás:  node tools/fetch-data.mjs
 *
 * Forrás: https://map.mohu.hu/api/Map/  (MOHU MOL Hulladékgazdálkodási Zrt.)
 */

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "https://map.mohu.hu/api/Map";
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, "..", "data");

async function getJSON(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} - ${url}`);
  return res.json();
}

/** Egyszerű párhuzamos végrehajtó, hogy ne terheljük túl a szervert. */
async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let index = 0;
  async function runner() {
    while (index < items.length) {
      const i = index++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runner));
  return results;
}

console.log("1/2 Pontok lekérése (SearchPoisGeneralData)...");
const points = await getJSON(`${API}/SearchPoisGeneralData`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json" },
  body: JSON.stringify({ searchInPoiTypes: ["Drs"] }),
});
console.log(`   ${points.length} pont`);

console.log("2/2 Részletek (nyitvatartás) lekérése...");
const started = Date.now();
let done = 0;
const details = await mapPool(points, 24, async (p) => {
  try {
    const d = await getJSON(`${API}/GetDrsPointDetails?id=${p.id}`);
    done++;
    if (done % 500 === 0) {
      const elapsed = (Date.now() - started) / 1000;
      const rate = done / elapsed;
      const left = Math.round((points.length - done) / rate);
      console.log(`   ${done}/${points.length}  (~${left}s hátra)`);
    }
    return d;
  } catch (err) {
    done++;
    console.warn(`   ! ${p.id}: ${err.message}`);
    return null;
  }
});

const byId = new Map();
for (const d of details) if (d && d.id != null) byId.set(d.id, d);

const out = points.map((p) => {
  const d = byId.get(p.id);
  const automated = (p.subTypes || []).some((s) => s.toLowerCase() === "automated");
  return {
    id: p.id,
    type: automated ? "automata" : "kezi",
    lat: p.coordinates?.latitude ?? null,
    lng: p.coordinates?.longitude ?? null,
    name: (p.name || "").trim() || "Névtelen pont",
    address: (p.address || "").trim(),
    city: d?.city || "",
    zip: d?.zipCode || "",
    phone: d?.phoneNumber || d?.normalizedPhoneNumber || null,
    site: d?.webSiteUrl || null,
    hours: {
      h: d?.openTimeWeekdays ?? null,
      s: d?.openTimeSaturday ?? null,
      v: d?.openTimeSunday ?? null,
    },
  };
});

await mkdir(OUT_DIR, { recursive: true });
const file = join(OUT_DIR, "repontok.json");
await writeFile(file, JSON.stringify(out), "utf8");

const stats = {
  updatedAt: new Date().toISOString(),
  total: out.length,
  automata: out.filter((o) => o.type === "automata").length,
  kezi: out.filter((o) => o.type === "kezi").length,
};
await writeFile(join(OUT_DIR, "repontok-meta.json"), JSON.stringify(stats, null, 2), "utf8");

console.log(`Kész: ${file}`);
console.log(stats);
