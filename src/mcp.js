'use strict';

const { PATTERNS } = require('./patterns');
const { buildScore, SHAPES } = require('./score');
const { buildVoiceScore } = require('./voice');

const deviceProp = { type: 'string', description: 'Toy from toy_status — the nickname the user gave it (alias), its name, or key. Omit to drive every connected toy.' };
const secondsProp = { type: 'number', description: 'How long it runs before auto-stopping. 0 = keep going until stopped. Default 30.' };

const TOOLS = [
  {
    name: 'toy_status',
    description: 'See which toys are connected right now, their features (Vibrate/Suction/Rotate/Electric…), battery, what is currently playing, and the latest reactions from the panel (feedback: 再重一点 / 轻一点 / 快一点 / 慢一点 / 别停 / 快不行了 / 到了 / ❤️ 爱你). Each toy may carry a nickname from the user (alias) — call it by that name. Does not move the toy.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'toy_vibrate',
    description: 'Set a steady intensity on the toy. Use when the user has invited toy play. They can always stop it from the panel.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'number', description: 'Intensity 0-100. 0 stops.' },
        seconds: secondsProp,
        device: deviceProp,
        feature: { type: 'string', description: 'Only this feature, e.g. Vibrate, Suction, Rotate, Electric. Omit to drive every feature except Electric, which must be named explicitly.' },
      },
      required: ['level'],
    },
  },
  {
    name: 'toy_pattern',
    description: `Play a looping rhythm. Presets: ${Object.entries(PATTERNS).map(([k, v]) => `${k}(${v.label})`).join(', ')}. Or pass custom steps.`,
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Preset name.' },
        steps: { type: 'array', description: 'Custom rhythm instead of a preset: [{level:0-100, ms:100-60000}, …]', items: { type: 'object', properties: { level: { type: 'number' }, ms: { type: 'number' } } } },
        intensity: { type: 'number', description: 'Scale the whole pattern 0-100. Default 100.' },
        seconds: secondsProp,
        device: deviceProp,
        feature: { type: 'string' },
      },
    },
  },
  {
    name: 'toy_draw',
    description: 'Write or draw on the shared canvas the user is watching; the toy follows your pen in sync — pressure and pen speed become intensity, each pen lift a pause. Chinese text is written in true stroke order (e.g. the name of the user). Give text, a shape, or your own strokes (any combination).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Up to 12 Chinese characters, written stroke by stroke.' },
        shape: { type: 'string', enum: Object.keys(SHAPES) },
        strokes: { type: 'array', description: 'Freehand: list of strokes, each a list of [x, y] or [x, y, pressure 0-1] points on a 0-100 canvas (x right, y down).', items: { type: 'array', items: { type: 'array', items: { type: 'number' } } } },
        intensity: { type: 'number', description: 'Peak intensity 0-100. Default 70.' },
        speed: { type: 'number', description: 'Pen speed multiplier 0.3-3. Lower = slower, longer strokes. Default 1.' },
        clear: { type: 'boolean', description: 'Wipe the canvas first. Default true.' },
        device: deviceProp,
      },
    },
  },
  {
    name: 'toy_speak',
    description: 'Say something to the user in your own voice (ElevenLabs v4): it plays from the panel and the toy rises and falls with the loudness of your voice — louder words press harder, breaths and whispers stay soft, silences rest. v4 audio tags shape the delivery, e.g. [whispers] [softly] [breathy] [sighs] [exhales] [laughs softly] [moans] [panting], and … for lingering pauses. Uses the ElevenLabs character quota (the result reports how many).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What you say, with optional [audio tags].' },
        intensity: { type: 'number', description: 'Peak intensity 0-100 at your loudest. Default 70.' },
        model: { type: 'string', description: 'ElevenLabs model id. Default eleven_v4.' },
        device: deviceProp,
      },
      required: ['text'],
    },
  },
  {
    name: 'toy_listen',
    description: 'Listen for the user. Waits until they make a sound or speak (or the time runs out) and returns what was heard: on-device sound labels from their mic (喘息, 急喘, 倒抽气, 叹气, 呻吟, 哼吟, 耳语, 笑, 水声, 搅水声, 湿黏声, 拍打声…) with loudness, and their push-to-talk words as text. Raw audio never reaches you — only these labels and transcripts. Use it right after you speak or move the toy to hear how they react.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'number', description: 'How long to wait, 1-60. Default 15.' } } },
  },
  {
    name: 'toy_replay',
    description: 'Replay a drawing or voice clip the user saved (toy follows it again). Call with no name to list what has been saved.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Saved name or id.' }, device: deviceProp } },
  },
  {
    name: 'toy_stop',
    description: 'Stop the toy immediately.',
    inputSchema: { type: 'object', properties: { device: deviceProp } },
  },
];

// actor: { id, label } of the caller when the host knows it; toy_speak uses that actor's own voice.
async function callTool(hub, name, args = {}, source = 'mcp:AI', actor) {
  switch (name) {
    case 'toy_draw': {
      const score = await buildScore(args);
      const label = args.text ? `写字：${args.text}` : '画画';
      return { ...hub.playScore(score, { device: args.device, source, label, clear: args.clear !== false }), skipped: score.skipped };
    }
    case 'toy_status': return hub.state();
    case 'toy_listen': {
      const micOn = hub.senses.micOn();
      const seconds = Math.min(60, Math.max(1, Number(args.seconds) || 15));
      const heard = await hub.senses.listen(seconds * 1000);
      return { userMicOn: micOn || hub.senses.micOn(), waitedUpTo: seconds, heard, ...(heard.length ? {} : { note: micOn ? 'quiet — nothing heard' : 'their mic is off; they can still hold-to-talk' }) };
    }
    case 'toy_speak': {
      if (!hub.voice) throw new Error('voice is not enabled on this hub');
      const { audio, ...score } = await buildVoiceScore(args, await hub.voice.getConfig(actor));
      const audioId = hub.voice.clips.put(audio);
      const label = `说：${score.text.replace(/\[[^\]]*\]/g, '').trim().slice(0, 18)}`;
      return { ...hub.playScore({ ...score, audioId }, { device: args.device, source, label }), characters: score.text.length };
    }
    case 'toy_replay': return args.name ? hub.replaySaved(args.name, { device: args.device, source }) : { saved: hub.saved?.list() || [] };
    case 'toy_vibrate': return hub.command({ ...args, action: 'level', source });
    case 'toy_pattern': return hub.command({ ...args, action: 'pattern', pattern: args.steps || args.pattern || 'wave', source });
    case 'toy_stop': return hub.command({ action: 'stop', device: args.device, source });
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32601 });
  }
}

// Minimal streamable-HTTP JSON-RPC endpoint.
async function handleRpc(hub, body, source) {
  const { id, method, params } = body || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  if (method === 'initialize') {
    return ok({
      protocolVersion: params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'toy-hub', version: '0.1.0' },
      instructions: 'Toy control for a consenting adult user. Only act when the user has invited play; start gentle, read their replies, and use toy_stop the moment they ask.',
    });
  }
  if (method?.startsWith('notifications/')) return null;
  if (method === 'ping') return ok({});
  if (method === 'tools/list') return ok({ tools: TOOLS });
  if (method === 'tools/call') {
    try {
      const result = await callTool(hub, params?.name, params?.arguments, source);
      return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      if (e.code === -32601) return { jsonrpc: '2.0', id, error: { code: -32601, message: e.message } };
      return ok({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

module.exports = { TOOLS, callTool, handleRpc };
