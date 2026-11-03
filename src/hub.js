'use strict';

const crypto = require('crypto');
const { resolvePattern, PATTERNS } = require('./patterns');
const { Senses } = require('./senses');

const DEFAULT_SECONDS = 30;
const OPT_IN_TYPES = new Set(['Electric']);
const VOICE_LEAD_MS = 1500;
const RELAY_ASLEEP_MS = 30000; // relay pages beat every 10s; silence means the page is frozen
const ASLEEP_NOTE = 'the relay page near the toy looks asleep, so the toy may not have moved; ask the user to bring that page back to the foreground';

// Device-agnostic relay: bridges (phone/PC pages near the toy) report devices and
// receive commands; controllers (panel, MCP) only ever talk to this hub.
class ToyHub {
  // maxSeconds: optional cap; by default a command may run until stopped (seconds = 0).
  constructor({ maxSeconds = null, now = () => Date.now() } = {}) {
    this.maxSeconds = maxSeconds;
    this.now = now;
    this.bridges = new Map(); // bridgeId -> { send, devices, connectedAt, lastSeen }
    this.activity = new Map(); // deviceKey -> { kind, detail, until, source }
    this.watchers = new Set();
    this.history = [];
    this.feedbackLog = [];
    this.lastScore = null;
    this.senses = new Senses({ now });
    this.wasAsleep = false;
    setInterval(() => this.checkRelays(), 5000).unref?.();
  }

  beat(bridgeId) {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge) throw Object.assign(new Error('bridge not connected'), { statusCode: 409 });
    bridge.lastSeen = this.now();
    this.checkRelays();
  }

  isAsleep(bridge) { return this.now() - bridge.lastSeen > RELAY_ASLEEP_MS; }
  relayAsleep() { return [...this.bridges.values()].some((b) => this.isAsleep(b)); }

  // Open panels hear about a relay falling asleep or waking without waiting for another event.
  checkRelays() {
    const asleep = this.relayAsleep();
    if (asleep !== this.wasAsleep) { this.wasAsleep = asleep; this.emit(); }
  }

  attachBridge(bridgeId, send) {
    const prev = this.bridges.get(bridgeId);
    if (prev) prev.close?.();
    const bridge = { send, devices: prev?.devices || [], connectedAt: this.now(), lastSeen: this.now() };
    this.bridges.set(bridgeId, bridge);
    this.emit();
    return () => {
      if (this.bridges.get(bridgeId) !== bridge) return;
      this.bridges.delete(bridgeId);
      for (const key of [...this.activity.keys()]) if (key.startsWith(`${bridgeId}/`)) this.activity.delete(key);
      this.emit();
    };
  }

  report(bridgeId, devices) {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge) throw Object.assign(new Error('bridge not connected'), { statusCode: 409 });
    bridge.devices = (Array.isArray(devices) ? devices : []).slice(0, 16).map((d) => ({
      id: String(d.id),
      name: String(d.name || 'Toy').slice(0, 60),
      driver: String(d.driver || 'unknown').slice(0, 30),
      battery: Number.isFinite(d.battery) ? d.battery : null,
      actuators: (d.actuators || []).slice(0, 8).map((a) => ({ type: String(a.type || 'Vibrate') })),
    }));
    bridge.lastSeen = this.now();
    this.emit();
  }

  listDevices() {
    const out = [];
    for (const [bridgeId, bridge] of this.bridges) {
      for (const d of bridge.devices) {
        const key = `${bridgeId}/${d.id}`;
        const act = this.activity.get(key);
        const live = act && (act.until === null || act.until > this.now());
        out.push({ key, bridgeId, ...d, alias: this.aliases?.get(d.name) || null, activity: live ? act : null });
      }
    }
    return out;
  }

  state() {
    return {
      online: this.bridges.size > 0,
      relayAsleep: this.relayAsleep(),
      ...(this.relayAsleep() ? { note: ASLEEP_NOTE } : {}),
      bridges: [...this.bridges.entries()].map(([id, b]) => ({ id, connectedAt: b.connectedAt, asleep: this.isAsleep(b), devices: b.devices.length })),
      devices: this.listDevices(),
      patterns: Object.fromEntries(Object.entries(PATTERNS).map(([k, v]) => [k, v.label])),
      recent: this.history.slice(-10),
      feedback: this.feedbackLog.slice(-5).map((f) => ({ ...f, secondsAgo: Math.round((this.now() - f.at) / 1000) })),
      userMicOn: this.senses.micOn(),
      heard: this.senses.recent(5),
    };
  }

  // The user's reactions from the panel, readable by the AI through toy_status.
  feedback(kind, note) {
    const label = FEEDBACK[kind];
    if (!label) throw badRequest(`kind must be one of ${Object.keys(FEEDBACK).join(', ')}`);
    this.feedbackLog.push({ at: this.now(), kind, label, note: note ? String(note).slice(0, 80) : undefined });
    if (this.feedbackLog.length > 30) this.feedbackLog.shift();
    this.emit();
    return { ok: true };
  }

  // Plays a built score on the toy and streams the same strokes to every open panel.
  // With no toy online the drawing still plays on the canvas (toyOffline: true).
  // Voice scores start after a short lead so the panel can fetch the audio first;
  // toy and panel both count the lead from the moment they receive the score.
  playScore(score, { device, source = 'panel', label = '画画', clear = true } = {}) {
    const startIn = score.kind === 'voice' ? VOICE_LEAD_MS : 0;
    let result;
    try {
      result = this.command({
        action: 'pattern', pattern: score.steps, loop: false, label, device, source, startIn,
        seconds: Math.ceil((score.duration + startIn) / 1000) + 1,
      });
    } catch (e) {
      if (e.statusCode !== 409) throw e;
      result = { ok: true, toyOffline: true, note: e.message };
    }
    const voice = score.kind === 'voice' ? { kind: 'voice', audioId: score.audioId, text: score.text, wave: score.wave } : {};
    this.lastScore = { id: crypto.randomUUID(), at: this.now(), clear, label, source, startIn, strokes: score.strokes, steps: score.steps, duration: score.duration, ...voice };
    for (const fn of this.watchers) fn('score', this.lastScore);
    return { ...result, durationSeconds: Math.round(score.duration / 100) / 10, strokes: score.strokes.length };
  }

  // cmd: { action: 'level'|'pattern'|'stop', device?, actuator?, feature?, level?, pattern?, seconds?, source? }
  command(cmd = {}) {
    const action = cmd.action;
    if (!['level', 'pattern', 'stop'].includes(action)) throw badRequest('action must be level, pattern or stop');
    // Every open panel cuts its running drawing/voice too, whoever pressed stop — even with no toy online.
    if (action === 'stop') for (const fn of this.watchers) fn('halt', { source: cmd.source || 'panel' });
    const targets = this.resolveTargets(cmd.device);
    if (!targets.length) throw Object.assign(new Error('no toy connected — open the bridge page near the toy first'), { statusCode: 409 });

    const seconds = action === 'stop' ? 0 : clampSeconds(cmd.seconds, this.maxSeconds);
    const loop = cmd.loop !== false;
    const pattern = action === 'pattern' ? resolvePattern(cmd.pattern, loop ? 200 : 3000) : null;
    const scale = cmd.intensity == null ? 1 : clamp01(Number(cmd.intensity) > 1 ? Number(cmd.intensity) / 100 : Number(cmd.intensity));
    const level = action === 'level' ? clamp01(Number(cmd.level) > 1 ? Number(cmd.level) / 100 : Number(cmd.level)) : 0;
    if (action === 'level' && !Number.isFinite(level)) throw badRequest('level must be 0-100');

    const results = [];
    for (const { bridgeId, bridge, device } of targets) {
      const actuators = action === 'stop' ? [] : pickActuators(device, cmd);
      if (action !== 'stop' && !actuators.length) continue;
      const msg = {
        id: crypto.randomUUID(), action, deviceId: device.id, actuators, seconds,
        level, loop, startIn: cmd.startIn || 0, steps: pattern?.steps.map(([l, ms]) => [l * scale, ms]),
      };
      bridge.send('cmd', msg);
      const key = `${bridgeId}/${device.id}`;
      if (action === 'stop' || (action === 'level' && level === 0)) this.activity.delete(key);
      else this.activity.set(key, {
        kind: action, detail: action === 'level' ? Math.round(level * 100) : cmd.label || pattern.name,
        actuators: actuators.map((i) => device.actuators[i].type), until: seconds ? this.now() + seconds * 1000 : null,
        source: String(cmd.source || 'panel').slice(0, 40),
      });
      results.push({ device: device.name, key, actuators: actuators.map((i) => device.actuators[i].type) });
    }
    if (!results.length) throw badRequest('no matching actuator on the selected toy');
    this.history.push({ at: this.now(), action, source: cmd.source || 'panel', detail: cmd.label || pattern?.name || (action === 'level' ? Math.round(level * 100) : '') });
    if (this.history.length > 50) this.history.shift();
    this.emit();
    const asleep = targets.some(({ bridge }) => this.isAsleep(bridge));
    return { ok: true, seconds, targets: results, ...(asleep ? { relayAsleep: true, note: ASLEEP_NOTE } : {}) };
  }

  resolveTargets(device) {
    const all = [];
    for (const [bridgeId, bridge] of this.bridges) for (const d of bridge.devices) all.push({ bridgeId, bridge, device: d });
    if (!device || device === 'all') return all;
    const q = String(device).toLowerCase();
    return all.filter(({ bridgeId, device: d }) => `${bridgeId}/${d.id}` === device || d.id === device
      || d.name.toLowerCase().includes(q) || (this.aliases?.get(d.name) || '').toLowerCase().includes(q));
  }

  // Replays a saved drawing by id or name (needs hub.saved, set by the router).
  replaySaved(query, { device, source = 'replay' } = {}) {
    const item = this.saved?.find(query);
    if (!item) throw Object.assign(new Error('saved drawing not found'), { statusCode: 404 });
    return { name: item.name, ...this.playScore(item, { device, source, label: `重播：${item.name}` }) };
  }

  // Watchers receive (event, data): 'state' snapshots and 'score' drawings.
  watch(fn) { this.watchers.add(fn); return () => this.watchers.delete(fn); }
  emit() { const s = this.state(); for (const fn of this.watchers) fn('state', s); }
}

const FEEDBACK = {
  more: '再重一点', less: '轻一点', faster: '快一点', slower: '慢一点',
  dont_stop: '别停', edge: '快不行了', came: '到了', love: '❤️ 爱你',
};

function pickActuators(device, cmd) {
  const idx = device.actuators.map((a, i) => ({ a, i }));
  if (Number.isInteger(cmd.actuator)) return idx.filter(({ i }) => i === cmd.actuator).map(({ i }) => i);
  if (cmd.feature) {
    const f = String(cmd.feature).toLowerCase();
    return idx.filter(({ a }) => a.type.toLowerCase() === f).map(({ i }) => i);
  }
  // Electric motors never start unless a command names them: safer default for a public project.
  return idx.filter(({ a }) => !OPT_IN_TYPES.has(a.type)).map(({ i }) => i);
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
// 0 means "until stopped"; a configured max still applies when set.
function clampSeconds(s, max) {
  const n = Number(s ?? DEFAULT_SECONDS);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_SECONDS;
  const secs = Math.round(n);
  if (max && (secs === 0 || secs > max)) return max;
  return secs;
}
const badRequest = (m) => Object.assign(new Error(m), { statusCode: 400 });

module.exports = { ToyHub };
