'use strict';

const { spawn } = require('child_process');

// Voice → feeling: synthesise speech, measure its loudness over time, and turn that
// envelope into the same [level, ms] timeline the canvas uses.
const BUCKET_MS = 100;
const DEFAULT_MODEL = 'eleven_v4';

async function synthesize(text, config, { model, fetchImpl = fetch } = {}) {
  if (!config?.apiKey || !config?.voice_id) throw Object.assign(new Error('voice is not configured (ElevenLabs apiKey / voice_id)'), { statusCode: 409 });
  const base = (config.baseURL || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/text-to-speech/${encodeURIComponent(config.voice_id)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': config.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model || config.toyModel || DEFAULT_MODEL }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`ElevenLabs HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return Buffer.from(await res.arrayBuffer());
}

// Decode with ffmpeg to 8 kHz mono PCM and return RMS per 100ms bucket.
function loudness(audio) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1']);
    const chunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
      const pcm = Buffer.concat(chunks);
      const per = (8000 * BUCKET_MS) / 1000;
      const rms = [];
      for (let i = 0; i + 1 < pcm.length; i += per * 2) {
        let sum = 0; let n = 0;
        for (let j = i; j + 1 < Math.min(pcm.length, i + per * 2); j += 2) { const v = pcm.readInt16LE(j) / 32768; sum += v * v; n++; }
        rms.push(n ? Math.sqrt(sum / n) : 0);
      }
      resolve(rms);
    });
    ff.stdin.on('error', () => {});
    ff.stdin.end(audio);
  });
}

// Loudness → intensity. Normalised to the clip's own loud end, a soft floor keeps
// breaths and whispers perceptible, true silence goes to zero.
function envelopeToSteps(rms, peak = 0.7) {
  const sorted = [...rms].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.95)] || 1e-6;
  const gate = top * 0.06;
  const levels = rms.map((r) => (r < gate ? 0 : peak * (0.18 + 0.82 * Math.min(1, r / top) ** 0.8)));
  const smooth = levels.map((l, i) => (i ? (l + levels[i - 1]) / 2 : l));
  const steps = [];
  for (const l of smooth) {
    const q = Math.round(l * 20) / 20;
    if (steps.length && steps.at(-1)[0] === q) steps.at(-1)[1] += BUCKET_MS;
    else steps.push([q, BUCKET_MS]);
  }
  return { steps, wave: smooth.map((l) => Math.round((l / (peak || 1)) * 100) / 100) };
}

async function buildVoiceScore({ text, intensity = 70, model }, config, deps = {}) {
  const clean = String(text || '').trim();
  if (!clean) throw Object.assign(new Error('text is required'), { statusCode: 400 });
  const peak = Math.min(1, Math.max(0, Number(intensity) > 1 ? Number(intensity) / 100 : Number(intensity)));
  const audio = await (deps.synthesize || synthesize)(clean, config, { model });
  const rms = await (deps.loudness || loudness)(audio);
  const { steps, wave } = envelopeToSteps(rms, peak);
  return { kind: 'voice', text: clean, audio, steps, wave, strokes: [], duration: rms.length * BUCKET_MS };
}

// The user's side: speech-to-text with ElevenLabs Scribe; audio events come back inline, e.g. "(笑声)".
async function transcribe(audio, mime, config, { fetchImpl = fetch } = {}) {
  if (!config?.apiKey) throw Object.assign(new Error('voice is not configured (ElevenLabs apiKey)'), { statusCode: 409 });
  const base = (config.baseURL || 'https://api.elevenlabs.io/v1').replace(/\/+$/, '');
  const form = new FormData();
  form.append('model_id', config.sttModel || 'scribe_v1');
  form.append('tag_audio_events', 'true');
  form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), 'clip.webm');
  const res = await fetchImpl(`${base}/speech-to-text`, {
    method: 'POST', headers: { 'xi-api-key': config.apiKey }, body: form, signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`ElevenLabs STT HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return String(data.text || '').trim();
}

module.exports = { buildVoiceScore, envelopeToSteps, synthesize, loudness, transcribe, DEFAULT_MODEL };
