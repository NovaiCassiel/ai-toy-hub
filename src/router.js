'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { ToyHub } = require('./hub');
const { handleRpc } = require('./mcp');
const { SavedScores, AudioClips, ToyAliases } = require('./store');
const { transcribe } = require('./voice');

const DATA_DIR = process.env.TOY_HUB_DATA || path.join(__dirname, '..', 'data');
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/audio_classifier/yamnet/float32/1/yamnet.tflite';

const PING_MS = 15000;

// The sound-recognition model is fetched once and then served from here, so phones on networks
// that can't reach the origin still get it.
let modelFetch = null;
function ensureModel(file) {
  if (fs.existsSync(file)) return Promise.resolve();
  modelFetch = modelFetch || (async () => {
    const res = await fetch(MODEL_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, Buffer.from(await res.arrayBuffer()));
    fs.renameSync(`${file}.tmp`, file);
  })().finally(() => { modelFetch = null; });
  return modelFetch;
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function openStream(res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const ping = setInterval(() => send('ping', { t: Date.now() }), PING_MS);
  return { send, stop: () => clearInterval(ping) };
}

// Mountable router: pages at /, REST under /api, MCP at /mcp. Returns null without a token.
// voiceConfig: optional async (actor) => { apiKey, voice_id, baseURL }. A host running several
// AIs can return a different voice per actor, or throw when one has no voice of its own.
function createToyHub({ token, hub = new ToyHub(), saved = new SavedScores(path.join(DATA_DIR, 'saved-scores.json')), voiceConfig } = {}) {
  if (!token) return null;
  hub.saved = saved;
  hub.aliases = hub.aliases || new ToyAliases(path.join(DATA_DIR, 'toy-names.json'));
  if (voiceConfig) hub.voice = { getConfig: voiceConfig, clips: new AudioClips(path.join(DATA_DIR, 'voice'), { keep: () => saved.audioIds() }) };
  const router = express.Router();
  const reply = (fn) => async (req, res) => {
    try { res.json(await fn(req)); } catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  };

  router.use(['/api', '/mcp'], (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    const bearer = (req.headers.authorization || '').replace(/^bearer\s+/i, '');
    // Chat apps' connector screens often take only a URL, so /mcp also accepts ?key=.
    const given = bearer || (req.baseUrl.endsWith('/mcp') ? req.query.key : '');
    if (!safeEqual(given, token)) return res.status(401).json({ error: 'unauthorized' });
    next();
  });
  router.use(express.json({ limit: '2mb' })); // freehand drawings can be long

  router.get('/api/state', (_req, res) => res.json(hub.state()));

  router.get('/api/events', (req, res) => {
    const stream = openStream(res);
    stream.send('state', hub.state());
    if (hub.lastScore) stream.send('score', { ...hub.lastScore, replay: true });
    const unwatch = hub.watch((event, data) => stream.send(event, data));
    req.on('close', () => { unwatch(); stream.stop(); });
  });

  router.post('/api/command', (req, res) => {
    try { res.json(hub.command({ ...req.body, source: req.body?.source || 'panel' })); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/api/feedback', (req, res) => {
    try { res.json(hub.feedback(req.body?.kind, req.body?.note)); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  // The user's side: on-device sound labels / mic on-off, and push-to-talk clips for transcription.
  router.post('/api/senses', reply((req) => {
    if ('mic' in (req.body || {})) { hub.senses.mic(Boolean(req.body.mic)); return { ok: true }; }
    return { ok: Boolean(hub.senses.add(req.body)) };
  }));
  router.post('/api/hear', express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '8mb' }), reply(async (req) => {
    if (!hub.voice) throw Object.assign(new Error('voice is not enabled on this hub'), { statusCode: 409 });
    if (!req.body?.length) throw Object.assign(new Error('no audio'), { statusCode: 400 });
    const text = await transcribe(req.body, req.get('content-type'), await hub.voice.getConfig());
    hub.senses.add({ kind: 'speech', text });
    return { text };
  }));
  router.get('/models/yamnet.tflite', async (_req, res) => {
    const file = path.resolve(DATA_DIR, 'models', 'yamnet.tflite');
    try {
      await ensureModel(file);
      res.set('Cache-Control', 'public, max-age=2592000').sendFile(file);
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  router.get('/api/voice/:id', (req, res) => {
    const file = hub.voice?.clips.file(req.params.id);
    if (!file) return res.status(404).json({ error: 'not found' });
    res.set('Cache-Control', 'private, max-age=86400').type('audio/mpeg').sendFile(file);
  });

  router.post('/api/toy-name', reply((req) => {
    const result = hub.aliases.set(req.body?.toy, req.body?.alias);
    hub.emit();
    return result;
  }));

  router.get('/api/saved', reply(() => saved.list()));
  router.post('/api/saved', reply((req) => saved.save(hub.lastScore, req.body?.name)));
  router.delete('/api/saved/:id', reply((req) => saved.remove(req.params.id)));
  router.post('/api/saved/:id/play', reply((req) => hub.replaySaved(req.params.id, { device: req.body?.device, source: 'replay' })));

  router.get('/api/bridge/stream', (req, res) => {
    const bridgeId = String(req.query.id || '').slice(0, 40);
    if (!/^[\w-]{4,40}$/.test(bridgeId)) return res.status(400).json({ error: 'bad bridge id' });
    const stream = openStream(res);
    const detach = hub.attachBridge(bridgeId, stream.send);
    stream.send('hello', { bridgeId, maxSeconds: hub.maxSeconds, pingMs: PING_MS });
    req.on('close', () => { detach(); stream.stop(); });
  });

  router.post('/api/bridge/report', (req, res) => {
    try { hub.report(String(req.body?.bridgeId || ''), req.body?.devices); res.json({ ok: true }); }
    catch (e) { res.status(e.statusCode || 500).json({ error: e.message }); }
  });

  router.post('/api/bridge/beat', reply((req) => { hub.beat(String(req.body?.bridgeId || '')); return { ok: true }; }));

  router.post('/mcp', async (req, res) => {
    // The name shown on the panel: add ?name=YourAI to the connector URL (or an x-client-name header).
    const name = String(req.query.name || req.get('x-client-name') || 'AI').slice(0, 20);
    const answer = await handleRpc(hub, req.body, `mcp:${name}`);
    if (!answer) return res.status(202).end();
    res.json(answer);
  });
  router.get('/mcp', (_req, res) => res.status(405).json({ error: 'use POST' }));

  router.use(express.static(path.join(__dirname, '..', 'public'), { index: 'panel.html' }));
  router.hub = hub;
  return router;
}

module.exports = { createToyHub, ToyHub };
