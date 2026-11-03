const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function browserFixture() {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: '', textContent: '', dataset: {}, children: [], disabled: false,
      replaceChildren(...children) { this.children = children; },
      prepend(child) { this.children.unshift(child); },
    });
    return elements.get(id);
  };
  const writes = [];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let receive;
  const device = {
    id: 'fake-ble', name: 'Fixture', driver: 'fixture', actuators: [{ type: 'Vibrate' }],
    set(index, level) { writes.push({ index, level }); },
    stopAll() { writes.push({ stop: true }); }, async readBattery() {},
  };
  const sandbox = {
    document: { getElementById: element, createElement: () => ({}), addEventListener() {} },
    window: { addEventListener() {} }, navigator: { bluetooth: {} },
    sessionStorage: { getItem: () => 'b-test', setItem() {} },
    crypto: { randomUUID: () => 'test-id' }, performance: { now: () => 0 },
    api: async (url, body) => { requests.push({ url, body }); return {}; },
    stream: async (_url, listener) => { receive = listener; return new Promise(() => {}); },
    getKey: () => 'test-key', setKey() {}, AbortController, Date,
    startKeepAlive: async () => true,
    connectSosexy: async () => [device], connectLovense: async () => [], connectIntiface: async () => [],
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => ++timerId, clearInterval() {},
  };
  const source = fs.readFileSync(path.join(__dirname, '../public/bridge.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  vm.runInNewContext(source, sandbox, { filename: 'bridge.js' });
  return { element, device, requests, writes, timers, receive: (...args) => receive(...args) };
}

test('relay connects without writes, arms explicitly, and a stop blocks later commands', async () => {
  const f = browserFixture();
  f.element('start').onclick();
  f.receive('hello', { pingMs: 15000 });
  await f.element('sosexy').onclick();
  assert.equal(f.writes.length, 0, 'connecting must not send even a zero frame');
  const command = { deviceId: f.device.id, action: 'level', actuators: [0], level: 0.01, seconds: 2 };
  f.receive('cmd', command);
  assert.equal(f.writes.length, 0, 'standby ignores commands');
  await f.element('arm').onclick();
  assert.equal(f.requests.at(-1).body.controlEnabled, true);
  f.receive('cmd', command);
  assert.deepEqual(f.writes[0], { index: 0, level: 0.01 });
  f.receive('cmd', { deviceId: f.device.id, action: 'stop' });
  assert.ok(f.writes.at(-1).stop);
  assert.equal(f.timers.size, 0, 'stop cancels pending deadlines');
  const count = f.writes.length;
  f.receive('cmd', command);
  assert.equal(f.writes.length, count, 'queued actions cannot restart after stop');
  assert.equal(f.requests.at(-1).body.controlEnabled, false);
});

test('reconnect and Bluetooth loss revoke relay permission', async () => {
  const f = browserFixture();
  f.element('start').onclick();
  f.receive('hello', { pingMs: 15000 });
  await f.element('sosexy').onclick();
  await f.element('arm').onclick();
  f.receive('hello', { pingMs: 15000 });
  assert.equal(f.requests.at(-1).body.controlEnabled, false);
  await f.element('arm').onclick();
  f.device.onGone();
  assert.equal(f.requests.at(-1).body.controlEnabled, false);
  assert.equal(f.requests.at(-1).body.devices.length, 0);
});
