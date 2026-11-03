'use strict';

const { callTool } = require('./mcp');
const { PATTERNS } = require('./patterns');
const { SHAPES } = require('./score');

const percent = { type: 'number', minimum: 0, maximum: 100 };
const seconds = { type: 'number', minimum: 1, maximum: 300, default: 30 };
const device = { type: 'string', minLength: 1, maxLength: 160, description: 'Device key or name from toy_status. Omit for connected devices.' };
const feature = { type: 'string', enum: ['Vibrate', 'Suction'], default: 'Vibrate' };
const tool = (name, description, properties, required = [], readOnly = false) => ({
  name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: name === 'toy_status' || name === 'toy_stop', openWorldHint: false },
  securitySchemes: [{ type: 'oauth2', scopes: [readOnly ? 'toy:read' : 'toy:control'] }],
});
const TOOLS = [
  tool('toy_status', 'Check connection, standby, battery and activity. Does not move any device.', {}, [], true),
  tool('toy_vibrate', 'Run a bounded device command only after the user explicitly requests it. Requires the owner to enable control on the local relay. Level is a percentage: 1 means 1%.', { level: percent, seconds, device, feature }, ['level']),
  tool('toy_pattern', 'Run a bounded preset or custom sequence after explicit user consent. Local standby still applies.', {
    pattern: { type: 'string', enum: Object.keys(PATTERNS) },
    steps: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', properties: { level: percent, ms: { type: 'number', minimum: 100, maximum: 60000 } }, required: ['level', 'ms'], additionalProperties: false } },
    intensity: { ...percent, default: 20 }, seconds, device, feature,
  }),
  tool('toy_draw', 'Draw text or a shape on the panel and send the matching bounded sequence to an enabled device. Requires explicit user consent.', {
    text: { type: 'string', minLength: 1, maxLength: 12 }, shape: { type: 'string', enum: Object.keys(SHAPES) },
    intensity: { ...percent, default: 20 }, speed: { type: 'number', minimum: 0.3, maximum: 3, default: 1 }, clear: { type: 'boolean' }, device,
  }),
  tool('toy_replay', 'List saved drawings when name is omitted. With a name, replay a saved drawing after explicit consent; local standby still applies.', { name: { type: 'string', minLength: 1, maxLength: 100 }, device }),
  tool('toy_stop', 'Immediately request stop and return the local relay to standby. Always use when the user asks to stop.', { device }),
];

// Small schema validator for these six fixed schemas; no coercion and no extra
// arguments. This matches the Brain's bounded interface without changing its API.
function validate(value, schema, label) {
  const fail = () => { throw new Error(`Invalid ${label}`); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    if (Object.keys(value).some((k) => !Object.hasOwn(schema.properties, k))) fail();
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail();
    for (const [key, item] of Object.entries(value)) validate(item, schema.properties[key], `${label}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems) fail();
    value.forEach((item) => validate(item, schema.items, label));
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) fail();
  } else if (schema.type === 'string') {
    if (typeof value !== 'string' || (schema.minLength && !value.trim()) || [...value].length < (schema.minLength || 0) || [...value].length > (schema.maxLength || Infinity)) fail();
  } else if (typeof value !== schema.type) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
}

async function handleOAuthRpc(hub, body, auth) {
  const { id, method, params } = body || {};
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const rpcError = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (body?.jsonrpc !== '2.0' || typeof method !== 'string' || Array.isArray(body)) return rpcError(-32600, 'Invalid request');
  if (method.startsWith('notifications/')) return null;
  if (id === undefined || (typeof id !== 'string' && typeof id !== 'number')) return rpcError(-32600, 'Request id required');
  if (method === 'initialize') return ok({
    protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26'].includes(params?.protocolVersion) ? params.protocolVersion : '2025-11-25',
    capabilities: { tools: {} }, serverInfo: { name: 'novai-toy-hub', version: '0.2.0' },
    instructions: 'Read status before use. Device actions require explicit current user consent and local relay permission. Never enable the relay remotely. Start with the user-agreed bounded settings; stop on request. Device status is not proof of physical motion.',
  });
  if (method === 'ping') return ok({});
  const allowed = TOOLS.filter((t) => auth.scopes.includes(t.annotations.readOnlyHint ? 'toy:read' : 'toy:control'));
  if (method === 'tools/list') return ok({ tools: allowed });
  if (method !== 'tools/call') return rpcError(-32601, 'Method not found');
  const spec = allowed.find((t) => t.name === params?.name);
  if (!spec) return rpcError(-32602, 'Tool is unavailable for this authorization');
  try {
    const args = params.arguments ?? {};
    validate(args, spec.inputSchema, 'arguments');
    const clean = { ...args };
    if (['toy_vibrate', 'toy_pattern'].includes(spec.name)) {
      clean.seconds ??= 30;
      clean.feature ??= 'Vibrate';
    }
    if (['toy_pattern', 'toy_draw'].includes(spec.name)) clean.intensity ??= 20;
    if (spec.name === 'toy_pattern' && clean.steps && clean.pattern) throw new Error('Choose a preset or custom steps');
    if (spec.name === 'toy_draw' && !clean.text && !clean.shape) throw new Error('Text or shape required');
    if (spec.name === 'toy_replay' && clean.name && hub.saved?.find(clean.name)?.kind === 'voice') throw new Error('Voice clips are not available through this connection');
    let result = await callTool(hub, spec.name, clean, 'mcp:ChatGPT');
    if (spec.name === 'toy_status') {
      const { heard: _heard, userMicOn: _mic, ...status } = result;
      result = status;
    }
    if (spec.name === 'toy_replay' && !clean.name) result = { saved: result.saved.filter((s) => s.kind !== 'voice') };
    return ok({ content: [{ type: 'text', text: JSON.stringify(result) }] });
  } catch (error) {
    return ok({ content: [{ type: 'text', text: error.message }], isError: true });
  }
}

module.exports = { handleOAuthRpc, TOOLS };
