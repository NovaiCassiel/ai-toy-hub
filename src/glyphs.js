'use strict';

// Chinese stroke-order centre lines from hanzi-writer-data (derived from Make Me a Hanzi,
// Arphic Public License). Fetched per character on demand and cached in memory.
const SOURCES = (process.env.TOY_HANZI_SOURCES || 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0.1/,https://unpkg.com/hanzi-writer-data@2.0.1/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const cache = new Map();

const isHanzi = (ch) => /\p{Script=Han}/u.test(ch);

// Returns strokes as arrays of [x, y] in 0..1 (y down), or null if unavailable.
async function glyphStrokes(ch, fetchImpl = fetch) {
  if (!isHanzi(ch)) return null;
  if (cache.has(ch)) return cache.get(ch);
  for (const base of SOURCES) {
    try {
      const res = await fetchImpl(`${base}${encodeURIComponent(ch)}.json`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data = await res.json();
      // Data lives in a 1024 box with y pointing up from a baseline at 900.
      const strokes = data.medians.map((m) => m.map(([x, y]) => [x / 1024, (900 - y) / 1024]));
      cache.set(ch, strokes);
      return strokes;
    } catch { /* try next source */ }
  }
  return null;
}

module.exports = { glyphStrokes, isHanzi };
