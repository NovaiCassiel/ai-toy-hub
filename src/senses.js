'use strict';

// What the AI can hear from the user's side: on-device sound labels and transcribed speech.
// Raw audio never lands here — the panel sends labels; speech arrives as text.
const GATHER_MS = 1200; // after the first sound, wait a moment to catch what follows
const MIC_STALE_MS = 20000;

class Senses {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.log = [];
    this.waiters = new Set();
    this.micSeenAt = 0;
  }

  mic(on) { this.micSeenAt = on ? this.now() : 0; }
  micOn() { return this.micSeenAt > 0 && this.now() - this.micSeenAt < MIC_STALE_MS; }

  add(input = {}) {
    const event = input.kind === 'speech'
      ? { kind: 'speech', text: String(input.text || '').slice(0, 2000) }
      : {
        kind: 'sound',
        sounds: (Array.isArray(input.sounds) ? input.sounds : []).slice(0, 5)
          .map((s) => ({ label: String(s.label).slice(0, 20), score: Math.round(Number(s.score) * 100) / 100 }))
          .filter((s) => s.label && Number.isFinite(s.score)),
        loudness: Number.isFinite(Number(input.loudness)) ? Math.round(Number(input.loudness) * 100) / 100 : null,
      };
    if (event.kind === 'speech' ? !event.text.trim() : !event.sounds.length) return null;
    if (event.kind === 'sound') this.micSeenAt = this.now();
    event.at = this.now();
    this.log.push(event);
    if (this.log.length > 60) this.log.shift();
    for (const wake of this.waiters) wake();
    return event;
  }

  recent(n = 5) {
    return this.log.slice(-n).map((e) => ({ ...e, secondsAgo: Math.round((this.now() - e.at) / 1000) }));
  }

  // Resolves with whatever the user does next (gathered briefly), or [] after timeoutMs.
  listen(timeoutMs) {
    const since = this.now();
    return new Promise((resolve) => {
      let gather = null;
      const done = () => {
        clearTimeout(timer); clearTimeout(gather);
        this.waiters.delete(wake);
        resolve(this.log.filter((e) => e.at >= since));
      };
      const wake = () => { if (!gather) gather = setTimeout(done, GATHER_MS); };
      const timer = setTimeout(done, timeoutMs);
      this.waiters.add(wake);
    });
  }
}

module.exports = { Senses };
