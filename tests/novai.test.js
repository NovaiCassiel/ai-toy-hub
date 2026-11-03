const test = require('node:test');
const assert = require('node:assert/strict');
const { ToyHub } = require('../src/hub');
const { callTool } = require('../src/mcp');

function fixture() {
  const commands = [];
  const hub = new ToyHub({ maxSeconds: 300 });
  hub.attachBridge('b-test', (event, data) => { if (event === 'cmd') commands.push(data); });
  const devices = [{ id: 'fixture', name: 'Fixture', actuators: [{ type: 'Vibrate' }, { type: 'Suction' }] }];
  return { hub, commands, devices };
}

test('connected standby reports status but rejects motion; stop remains available', () => {
  const { hub, commands, devices } = fixture();
  hub.report('b-test', devices, false);
  assert.equal(hub.state().devices[0].controlEnabled, false);
  assert.throws(() => hub.command({ action: 'level', level: 0.1 }), /allow control/);
  assert.equal(commands.length, 0);
  hub.command({ action: 'stop' });
  assert.equal(commands[0].action, 'stop');
  hub.report('b-test', devices, true);
  hub.command({ action: 'level', level: 0.1, seconds: 0 });
  assert.equal(commands.at(-1).seconds, 300);
  hub.attachBridge('b-test', () => {});
  assert.equal(hub.state().bridges[0].controlEnabled, false);
  assert.equal(hub.state().devices.length, 0, 'reconnect cannot inherit old targets');
});

test('MCP 1 percent is one percent for fixed and custom rhythm controls', async () => {
  const { hub, commands, devices } = fixture();
  hub.report('b-test', devices, true);
  await callTool(hub, 'toy_vibrate', { level: 1, seconds: 2 });
  assert.equal(commands.at(-1).level, 0.01);
  await callTool(hub, 'toy_vibrate', { level: 0.5, seconds: 2 });
  assert.equal(commands.at(-1).level, 0.005);
  await callTool(hub, 'toy_pattern', { steps: [{ level: 1, ms: 200 }], intensity: 100 });
  assert.equal(commands.at(-1).steps[0][0], 0.01);
  await callTool(hub, 'toy_pattern', { pattern: 'pulse', intensity: 1 });
  assert.ok(commands.at(-1).steps.every(([level]) => level <= 0.01));
  await assert.rejects(callTool(hub, 'toy_vibrate', { level: NaN }));
});

test('zero-percent drawing has no nonzero hardware step', async () => {
  const { hub, commands, devices } = fixture();
  hub.report('b-test', devices, true);
  await callTool(hub, 'toy_draw', { shape: 'heart', intensity: 0 });
  assert.ok(commands.at(-1).steps.every(([level]) => level === 0));
  await callTool(hub, 'toy_draw', { shape: 'heart', intensity: 1 });
  assert.ok(commands.at(-1).steps.every(([level]) => level <= 0.01));
});
