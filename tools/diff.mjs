/**
 * Két pont-lista összehasonlítása (a fetch-data.mjs használja).
 * Tiszta függvények, hogy külön is tesztelhető legyen.
 */

function hoursKey(p) {
  const h = p.hours || {};
  return `${h.h || ''}|${h.s || ''}|${h.v || ''}`;
}

function meters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function diffPoints(prev, next, moveTolerance = 75) {
  const before = new Map((prev || []).map((p) => [p.id, p]));
  const after = new Map((next || []).map((p) => [p.id, p]));

  const added = [];
  const removed = [];
  const moved = [];
  const hours = [];

  for (const [id, p] of after) {
    const old = before.get(id);
    if (!old) { added.push(id); continue; }
    if (hoursKey(old) !== hoursKey(p)) hours.push(id);
    if (old.lat != null && old.lng != null && p.lat != null && p.lng != null) {
      const d = meters(old, p);
      if (d > moveTolerance) moved.push({ id, m: Math.round(d) });
    }
  }

  for (const [id, p] of before) {
    if (!after.has(id)) removed.push({ id, name: p.name || '', city: p.city || '' });
  }

  return { added, removed, moved, hours };
}

export function changesSummary(prev, next) {
  const d = diffPoints(prev, next);
  return {
    at: new Date().toISOString(),
    counts: {
      total: next.length,
      added: d.added.length,
      removed: d.removed.length,
      moved: d.moved.length,
      hours: d.hours.length
    },
    added: d.added,
    removed: d.removed,
    moved: d.moved,
    hours: d.hours
  };
}
