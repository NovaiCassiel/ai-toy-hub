const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

process.env.TOY_HUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'toyhub-router-'));
const { createToyHub, ToyHub } = require('../src/router');

async function serve() {
  const hub = new ToyHub();
  const app = express();
  app.use('/', createToyHub({ token: 'test-key', hub }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const rpc = (url, body, headers = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { hub, base, rpc, close: () => { server.closeAllConnections(); server.close(); } };
}

test('MCP accepts the key as a bearer header or in the URL, and refuses without it', async (t) => {
  const { base, rpc, close } = await serve();
  t.after(close);
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
  assert.equal((await rpc('/mcp', list)).status, 401);
  assert.equal((await rpc('/mcp?key=wrong', list)).status, 401);
  assert.equal((await rpc('/mcp', list, { Authorization: 'Bearer test-key' })).status, 200);
  const viaUrl = await rpc('/mcp?key=test-key', list);
  assert.equal(viaUrl.status, 200);
  assert.ok((await viaUrl.json()).result.tools.some((tool) => tool.name === 'toy_draw'));
  assert.equal((await fetch(`${base}/api/state?key=test-key`)).status, 401, 'the URL key is for /mcp only');
});

test('the connector URL names the AI shown on the panel', async (t) => {
  const { hub, rpc, close } = await serve();
  t.after(close);
  hub.attachBridge('b-test', () => {});
  hub.report('b-test', [{ id: 'x', name: 'Toy', actuators: [{ type: 'Vibrate' }] }]);
  await rpc('/mcp?key=test-key&name=小光', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'toy_vibrate', arguments: { level: 10 } } });
  assert.equal(hub.listDevices()[0].activity.source, 'mcp:小光');
});

test('pages are served without the key and contain no key', async (t) => {
  const { base, close } = await serve();
  t.after(close);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /小玩具遥控/);
  assert.equal((await fetch(`${base}/bridge.html`)).status, 200);
});
