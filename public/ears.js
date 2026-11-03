import { api, HUB, getKey } from './client.js';

// The AI's ears on the user's phone. Sounds are recognised on-device (YAMNet via MediaPipe);
// only the recognised labels and a loudness number leave the phone. Hold-to-talk clips
// go to the hub for transcription.
const TASKS = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-audio@1.1.1';
const LABELS = {
  Breathing: '喘息', Pant: '急喘', Gasp: '倒抽气', Sigh: '叹气', 'Wail, moan': '呻吟', Groan: '哼吟',
  Whimper: '呜咽', Whispering: '耳语', Laughter: '笑', Giggle: '咯咯笑', 'Crying, sobbing': '啜泣',
  Screaming: '尖叫', Speech: '说话', Humming: '哼歌',
  Water: '水声', Liquid: '水声', 'Splash, splatter': '水花声', Slosh: '搅水声', Squish: '湿黏声', Drip: '滴水声',
  'Slap, smack': '拍打声', 'Heart sounds, heartbeat': '心跳',
};
const SPEECHY = new Set(['说话', '耳语', '哼歌', '笑', '咯咯笑']);
const REPORT_MS = 3000;
const MIN_SCORE = 0.2;

export function createEars({ onLabels, onStatus, isVoicePlaying }) {
  let ctx = null; let stream = null; let classifier = null; let node = null;
  let buf = []; let windowLabels = new Map(); let loudSum = 0; let loudN = 0;
  let reportTimer = null; let beatTimer = null;

  async function loadClassifier() {
    const { FilesetResolver, AudioClassifier } = await import(`${TASKS}/audio_bundle.mjs`);
    const files = await FilesetResolver.forAudioTasks(`${TASKS}/wasm`);
    return AudioClassifier.createFromOptions(files, {
      baseOptions: { modelAssetPath: `${HUB}/models/yamnet.tflite` },
      maxResults: 4, scoreThreshold: MIN_SCORE, categoryAllowlist: Object.keys(LABELS),
    });
  }

  function classify(samples) {
    let sq = 0;
    for (const v of samples) sq += v * v;
    loudSum += Math.sqrt(sq / samples.length); loudN += 1;
    const results = classifier.classify(samples, ctx.sampleRate);
    const now = new Map();
    for (const r of results) for (const c of r.classifications[0]?.categories || []) {
      const label = LABELS[c.categoryName];
      // The AI's voice from the speaker would otherwise sound like the user talking.
      if (!label || (isVoicePlaying() && SPEECHY.has(label))) continue;
      now.set(label, Math.max(now.get(label) || 0, c.score));
      windowLabels.set(label, Math.max(windowLabels.get(label) || 0, c.score));
    }
    onLabels([...now.entries()].sort((a, b) => b[1] - a[1]));
  }

  async function report() {
    const sounds = [...windowLabels.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([label, score]) => ({ label, score }));
    const loudness = loudN ? Math.min(1, (loudSum / loudN) * 8) : 0;
    windowLabels = new Map(); loudSum = 0; loudN = 0;
    if (sounds.length) await api('/api/senses', { sounds, loudness }).catch(() => {});
  }

  async function start() {
    onStatus('正在准备耳朵…');
    // No noise suppression: it would scrub exactly the breaths and water sounds we want.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false } });
    classifier = classifier || await loadClassifier();
    ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    node = ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      buf.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      const total = buf.reduce((n, b) => n + b.length, 0);
      if (total < ctx.sampleRate) return;
      const merged = new Float32Array(total);
      let off = 0;
      for (const b of buf) { merged.set(b, off); off += b.length; }
      buf = [];
      classify(merged);
    };
    src.connect(node);
    node.connect(ctx.destination);
    reportTimer = setInterval(report, REPORT_MS);
    beatTimer = setInterval(() => api('/api/senses', { mic: true }).catch(() => {}), 10000);
    api('/api/senses', { mic: true }).catch(() => {});
    onStatus('正在听');
  }

  function stop() {
    clearInterval(reportTimer); clearInterval(beatTimer);
    node?.disconnect(); ctx?.close().catch(() => {});
    stream?.getTracks().forEach((t) => t.stop());
    ctx = null; stream = null; node = null; buf = [];
    api('/api/senses', { mic: false }).catch(() => {});
    onLabels([]);
    onStatus('');
  }

  return { start, stop, listening: () => Boolean(stream) };
}

export function micError(err) {
  if (err?.name === 'NotAllowedError' || /denied/i.test(err?.message)) return '没拿到麦克风权限：点地址栏左边的小锁，允许这个网站用麦克风';
  if (err?.name === 'NotFoundError') return '没找到麦克风';
  return `麦克风没打开：${err?.message || err}`;
}

// Hold-to-talk: records while pressed, then sends the clip for transcription.
export function holdToTalk(button, { onText, onStatus }) {
  let rec = null; let chunks = []; let mic = null;
  const begin = async () => {
    if (rec) return;
    mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    rec = new MediaRecorder(mic);
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      mic.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      rec = null;
      if (blob.size < 2000) return onStatus('太短了，按住久一点');
      onStatus('正在转成文字…');
      try {
        const res = await fetch(`${HUB}/api/hear`, { method: 'POST', headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': blob.type.split(';')[0] }, body: blob });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || res.status);
        onText(data.text);
      } catch (e) { onStatus(`没传过去：${e.message}`); }
    };
    rec.start();
    button.classList.add('on');
    onStatus('在录…松手发送');
  };
  const end = () => { button.classList.remove('on'); if (rec?.state === 'recording') rec.stop(); };
  button.addEventListener('pointerdown', (e) => { e.preventDefault(); begin().catch((err) => onStatus(micError(err))); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => button.addEventListener(t, end));
}
