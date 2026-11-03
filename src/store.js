'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Saved drawings in one JSON file. Deletes are soft (deletedAt) so nothing is lost by a mis-tap.
class SavedScores {
  constructor(file) {
    this.file = file;
    this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
  }

  list() {
    return this.items.filter((s) => !s.deletedAt)
      .map(({ id, name, label, savedAt, duration, kind }) => ({ id, name, label, savedAt, duration, kind: kind || 'draw' }))
      .reverse();
  }

  audioIds() { return new Set(this.items.map((s) => s.audioId).filter(Boolean)); }

  get(id) { return this.items.find((s) => s.id === id && !s.deletedAt) || null; }

  find(query) {
    const q = String(query || '').toLowerCase();
    return this.get(query) || this.items.filter((s) => !s.deletedAt).reverse().find((s) => s.name.toLowerCase().includes(q)) || null;
  }

  save(score, name) {
    if (!score?.steps?.length) throw Object.assign(new Error('nothing to save yet'), { statusCode: 409 });
    const item = {
      id: crypto.randomUUID(), name: String(name || score.label || '画画').slice(0, 40), label: score.label,
      savedAt: Date.now(), duration: score.duration, strokes: score.strokes, steps: score.steps,
      ...(score.kind === 'voice' ? { kind: 'voice', audioId: score.audioId, text: score.text, wave: score.wave } : {}),
    };
    this.items.push(item);
    this.flush();
    return { id: item.id, name: item.name };
  }

  remove(id) {
    const item = this.get(id);
    if (!item) throw Object.assign(new Error('not found'), { statusCode: 404 });
    item.deletedAt = Date.now();
    this.flush();
    return { ok: true };
  }

  flush() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items));
    fs.renameSync(tmp, this.file);
  }
}

// Spoken clips as mp3 files. Unsaved clips older than a few days are pruned; anything a
// saved drawing (even a soft-deleted one) points to is kept.
class AudioClips {
  constructor(dir, { keep = () => new Set(), maxAgeMs = 3 * 24 * 3600 * 1000 } = {}) {
    this.dir = dir;
    this.keep = keep;
    this.maxAgeMs = maxAgeMs;
  }

  put(buf) {
    fs.mkdirSync(this.dir, { recursive: true });
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(this.dir, `${id}.mp3`), buf);
    this.prune();
    return id;
  }

  file(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
    const file = path.join(this.dir, `${id}.mp3`);
    return fs.existsSync(file) ? file : null;
  }

  prune() {
    const keep = this.keep();
    const cutoff = Date.now() - this.maxAgeMs;
    for (const name of fs.readdirSync(this.dir)) {
      const id = name.replace(/\.mp3$/, '');
      const file = path.join(this.dir, name);
      if (!keep.has(id) && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  }
}

// The user's own names for their toys, keyed by the name the toy reports (stable across reconnects).
class ToyAliases {
  constructor(file) {
    this.file = file;
    this.map = {};
    try { this.map = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
  }

  get(toyName) { return this.map[toyName] || null; }

  set(toyName, alias) {
    const key = String(toyName || '').slice(0, 60);
    if (!key) throw Object.assign(new Error('toy name is required'), { statusCode: 400 });
    const clean = String(alias || '').trim().slice(0, 20);
    if (clean) this.map[key] = clean; else delete this.map[key];
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(this.map));
    fs.renameSync(`${this.file}.tmp`, this.file);
    return { ok: true, alias: clean || null };
  }
}

module.exports = { SavedScores, AudioClips, ToyAliases };
