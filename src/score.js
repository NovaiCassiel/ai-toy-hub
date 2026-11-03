'use strict';

const { glyphStrokes } = require('./glyphs');

// A "score" is drawing + feeling on one clock: strokes carry timed points for the
// canvas, steps carry the matching intensity timeline for the toy.
const SIZE = 1000;
const FRAME_MS = 20;
const BUCKET_MS = 100; // toys accept roughly one update per 100ms

const SHAPES = {
  heart: () => [Array.from({ length: 60 }, (_, i) => {
    const t = (i / 59) * Math.PI * 2;
    return [50 + 2.2 * 16 * Math.sin(t) ** 3, 45 - 2.2 * (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))];
  })],
  spiral: () => [Array.from({ length: 90 }, (_, i) => {
    const t = (i / 89) * Math.PI * 6;
    return [50 + Math.cos(t) * t * 2.2, 50 + Math.sin(t) * t * 2.2];
  })],
  wave: () => [Array.from({ length: 60 }, (_, i) => [8 + i * 1.4, 50 + Math.sin(i / 4) * 22])],
  zigzag: () => [Array.from({ length: 9 }, (_, i) => [10 + i * 10, i % 2 ? 25 : 75])],
  circle: () => [Array.from({ length: 50 }, (_, i) => {
    const t = (i / 49) * Math.PI * 2;
    return [50 + Math.cos(t) * 35, 50 + Math.sin(t) * 35];
  })],
};

async function buildScore({ text, shape, strokes, intensity = 70, speed = 1 } = {}, deps = {}) {
  const peak = clamp(Number(intensity) > 1 ? Number(intensity) / 100 : Number(intensity), 0.05, 1);
  const pace = clamp(Number(speed) || 1, 0.3, 3);
  const groups = []; // each group = one character/shape: strokes in canvas units
  const skipped = [];

  if (text) {
    const chars = [...String(text)].filter((c) => c.trim()).slice(0, 12);
    const cells = layout(chars.length);
    for (let i = 0; i < chars.length; i++) {
      const glyph = await (deps.glyphStrokes || glyphStrokes)(chars[i]);
      if (!glyph) { skipped.push(chars[i]); continue; }
      const { x, y, size } = cells[i];
      groups.push(glyph.map((s) => s.map(([gx, gy]) => [x + gx * size, y + gy * size])));
    }
  }
  if (shape) {
    if (!SHAPES[shape]) throw new Error(`unknown shape: ${shape}; shapes: ${Object.keys(SHAPES).join(', ')}`);
    groups.push(SHAPES[shape]().map((s) => s.map(([px, py]) => [px * 10, py * 10])));
  }
  if (Array.isArray(strokes) && strokes.length) {
    groups.push(strokes.slice(0, 60).map((s) => (Array.isArray(s) ? s : []).slice(0, 400)
      .map((p) => [clamp(p[0], 0, 100) * 10, clamp(p[1], 0, 100) * 10, p[2]])).filter((s) => s.length));
  }
  if (!groups.length) throw new Error(skipped.length ? `could not load strokes for: ${skipped.join('')}` : 'give text, shape or strokes');

  const out = [];
  let clock = 0;
  groups.forEach((group, gi) => {
    if (gi) clock += 650 / pace;
    group.forEach((stroke, si) => {
      if (si) clock += 320 / pace;
      const pts = penStroke(stroke, clock, peak, pace);
      if (pts.length) { out.push({ pts }); clock = pts.at(-1)[2]; }
    });
  });
  const duration = Math.ceil(clock + 200);
  return { strokes: out, steps: toSteps(out, duration), duration, skipped };
}

// Pen moves with ease-in/out; intensity follows pressure (press in, taper out) and speed.
function penStroke(raw, start, peak, pace) {
  const path = raw.map(([x, y, p]) => [Number(x), Number(y), p]).filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (path.length === 1) path.push([path[0][0] + 1, path[0][1] + 1]);
  const segs = [];
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    segs.push(d);
    length += d;
  }
  const tap = length < 60;
  const dur = clamp((tap ? 170 : 220 + length * 1.3) / pace, 120, 6000);
  const frames = Math.max(2, Math.round(dur / FRAME_MS));
  const pts = [];
  for (let f = 0; f <= frames; f++) {
    const tau = f / frames;
    const s = tau * tau * (3 - 2 * tau);
    const [x, y, given] = pointAt(path, segs, s * length);
    const pressure = Number.isFinite(given) ? clamp(given, 0, 1) : Math.min(1, s / 0.12) * (1 - 0.45 * Math.max(0, (s - 0.6) / 0.4));
    const velocity = (6 * tau * (1 - tau)) / 1.5;
    const level = tap ? peak * 0.95 : peak * clamp(0.2 + 0.5 * pressure + 0.4 * velocity, 0, 1);
    pts.push([round(x), round(y), Math.round(start + tau * dur), round(level, 100)]);
  }
  return pts;
}

function pointAt(path, segs, dist) {
  for (let i = 0; i < segs.length; i++) {
    if (dist <= segs[i] || i === segs.length - 1) {
      const k = segs[i] ? Math.min(1, dist / segs[i]) : 0;
      const [a, b] = [path[i], path[i + 1]];
      const p = Number.isFinite(a[2]) && Number.isFinite(b[2]) ? a[2] + (b[2] - a[2]) * k : a[2] ?? b[2];
      return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, p];
    }
    dist -= segs[i];
  }
  return path.at(-1);
}

// Average each 100ms bucket, quantise, merge repeats → compact [level, ms] steps.
function toSteps(strokes, duration) {
  const buckets = Array.from({ length: Math.ceil(duration / BUCKET_MS) }, () => [0, 0]);
  for (const { pts } of strokes) for (const [, , t, level] of pts) {
    const b = buckets[Math.min(buckets.length - 1, Math.floor(t / BUCKET_MS))];
    b[0] += level; b[1] += 1;
  }
  const steps = [];
  for (const [sum, n] of buckets) {
    const level = n ? Math.round((sum / n) * 20) / 20 : 0;
    if (steps.length && steps.at(-1)[0] === level) steps.at(-1)[1] += BUCKET_MS;
    else steps.push([level, BUCKET_MS]);
  }
  return steps;
}

function layout(n) {
  const cols = Math.min(n, n <= 4 ? n : Math.ceil(Math.sqrt(n)));
  const rows = Math.ceil(n / cols);
  const size = Math.min(SIZE / cols, SIZE / rows) * 0.92;
  const x0 = (SIZE - cols * size) / 2;
  const y0 = (SIZE - rows * size) / 2;
  return Array.from({ length: n }, (_, i) => ({ x: x0 + (i % cols) * size, y: y0 + Math.floor(i / cols) * size, size }));
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));
const round = (n, k = 10) => Math.round(n * k) / k;

module.exports = { buildScore, SHAPES };
