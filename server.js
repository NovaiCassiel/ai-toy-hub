'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { createToyHub, ToyHub } = require('./src/router');

const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const token = process.env.TOY_HUB_TOKEN;
if (!token) {
  console.error('TOY_HUB_TOKEN is missing. Copy .env.example to .env and set a long random key.');
  process.exit(1);
}

// Voice is optional: without an ElevenLabs key everything else still works.
const voiceConfig = process.env.ELEVENLABS_API_KEY
  ? async () => ({
    apiKey: process.env.ELEVENLABS_API_KEY,
    voice_id: process.env.ELEVENLABS_VOICE_ID,
    baseURL: process.env.ELEVENLABS_BASE_URL,
    toyModel: process.env.ELEVENLABS_MODEL,
  })
  : undefined;

const app = express();
app.disable('x-powered-by');
app.get('/health', (_req, res) => res.json({ ok: true }));
const maxSeconds = Number(process.env.TOY_HUB_MAX_SECONDS || 300);
if (!Number.isInteger(maxSeconds) || maxSeconds < 1 || maxSeconds > 3600) {
  throw new Error('TOY_HUB_MAX_SECONDS must be 1-3600');
}
app.use('/', createToyHub({ token, voiceConfig, hub: new ToyHub({ maxSeconds }) }));

const port = Number(process.env.PORT || 3737);
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => {
  console.log(`AI Toy Hub on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`);
  if (!voiceConfig) console.log('Voice is off: set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID to enable toy_speak and hold-to-talk.');
});
