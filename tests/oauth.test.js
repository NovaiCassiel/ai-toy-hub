'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { HubOAuth } = require('../src/oauth');
const { SavedScores } = require('../src/store');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { auth: sdkAuth } = require('@modelcontextprotocol/sdk/client/auth.js');

const owner = 'test-owner-key-not-a-real-credential';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
process.env.TOY_HUB_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'toyhub-oauth-aliases-'));
const { createToyHub, ToyHub } = require('../src/router');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toyhub-oauth-'));
  const file = path.join(directory, 'oauth.json');
  const app = express();
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const clock = { time: Date.now() };
  const oauth = new HubOAuth({ publicUrl: base, token: owner, file, now: () => clock.time });
  const hub = new ToyHub({ maxSeconds: 300 });
  app.use(oauth.router({ rateLimits: false }));
  app.use(createToyHub({ token: owner, hub, oauth, saved: new SavedScores(path.join(directory, 'saved.json')) }));
  t.after(() => { server.closeAllConnections(); server.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const json = (route, body, headers = {}) => fetch(base + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const form = (route, body) => fetch(base + route, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const register = async (overrides = {}) => {
    const response = await json('/register', { client_name: 'ChatGPT', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], ...overrides });
    assert.equal(response.status, 201, await response.clone().text());
    return response.json();
  };
  const begin = async (client, scope = 'toy:read toy:control', overrides = {}) => {
    const verifier = crypto.randomBytes(32).toString('base64url');
    const query = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: base + '/mcp', scope, state: 'client-state', ...overrides });
    const response = await fetch(`${base}/authorize?${query}`, { redirect: 'manual' });
    const html = await response.text();
    return { response, html, verifier, request: /name="request" value="([^"]+)"/.exec(html)?.[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)?.[1], cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const decide = (flow, allow = true, headers = {}) => json('/oauth/decision', { request: flow.request, csrf: flow.csrf, allow }, { Cookie: flow.cookie, Origin: base, Authorization: `Bearer ${owner}`, ...headers });
  const codeFor = async (client, scope) => {
    const flow = await begin(client, scope);
    assert.equal(flow.response.status, 200);
    const response = await decide(flow);
    assert.equal(response.status, 200, await response.clone().text());
    const target = new URL((await response.json()).redirect);
    assert.equal(target.origin, 'https://chatgpt.com');
    assert.equal(target.searchParams.get('state'), 'client-state');
    assert.equal(target.searchParams.get('iss'), `${base}/`);
    assert.ok(!target.href.includes(owner));
    return { ...flow, code: target.searchParams.get('code') };
  };
  const exchange = (client, flow, overrides = {}) => form('/token', { grant_type: 'authorization_code', client_id: client.client_id, code: flow.code, code_verifier: flow.verifier, redirect_uri: client.redirect_uris[0], resource: base + '/mcp', ...overrides });
  const authorize = async (scope) => {
    const client = await register();
    const flow = await codeFor(client, scope);
    const response = await exchange(client, flow);
    assert.equal(response.status, 200, await response.clone().text());
    return { client, tokens: await response.json(), flow };
  };
  const rpc = (token, method, params) => json('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { Authorization: `Bearer ${token}` });
  return { base, oauth, hub, file, clock, json, form, register, begin, decide, codeFor, exchange, authorize, rpc };
}

test('OAuth discovery, no URL keys in OAuth mode, existing owner/Brain access preserved', async (t) => {
  const f = await fixture(t);
  const unauth = await f.rpc('', 'tools/list');
  assert.equal(unauth.status, 401);
  assert.match(unauth.headers.get('www-authenticate'), /oauth-protected-resource\/mcp/);
  const metadata = await (await fetch(`${f.base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(metadata.resource, f.base + '/mcp');
  const auth = await (await fetch(`${f.base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(auth.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(auth.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(auth.authorization_response_iss_parameter_supported, true);
  assert.equal((await f.json(`/mcp?key=${owner}`, { method: 'tools/list' })).status, 401);
  assert.equal((await f.rpc(owner, 'tools/list')).status, 200);
  assert.equal((await fetch(`${f.base}/api/state`, { headers: { Authorization: `Bearer ${owner}` } })).status, 200);
  assert.equal((await fetch(`${f.base}/bridge.html`)).status, 200);
});

test('registration only accepts exact ChatGPT callbacks and public PKCE clients', async (t) => {
  const f = await fixture(t);
  for (const uri of ['https://evil.example/callback', 'http://chatgpt.com/connector_platform_oauth_redirect', callback + '#x', callback + '?next=evil', 'https://chatgpt.com.evil.example/connector/oauth/abc', 'https://user@chatgpt.com/connector/oauth/abc']) {
    assert.equal((await f.json('/register', { redirect_uris: [uri], token_endpoint_auth_method: 'none' })).status, 400);
  }
  assert.equal((await f.json('/register', { redirect_uris: [callback], token_endpoint_auth_method: 'client_secret_post' })).status, 400);
  assert.ok((await f.register({ redirect_uris: ['https://chatgpt.com/connector/oauth/test_callback-123'] })).client_id);
  assert.equal((await f.json('/register', { redirect_uris: [callback], token_endpoint_auth_method: 'none', client_name: 'x'.repeat(9000) })).status, 413);
});

test('owner consent requires same-origin browser binding, CSRF and the owner key; denial redirects with issuer', async (t) => {
  const f = await fixture(t);
  const client = await f.register({ client_name: '<script>alert(1)</script>' });
  const flow = await f.begin(client);
  assert.match(flow.html, /&lt;script&gt;/);
  assert.ok(!flow.html.includes(owner));
  assert.match(flow.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(flow.response.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(flow.response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await f.decide(flow, true, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await f.decide(flow, true, { Cookie: '' })).status, 403);
  assert.equal((await f.decide({ ...flow, csrf: 'wrong' })).status, 403);
  assert.equal((await f.decide(flow, true, { Authorization: 'Bearer wrong' })).status, 401);
  const denied = await (await f.decide(flow, false, { Authorization: '' })).json();
  assert.equal(new URL(denied.redirect).searchParams.get('error'), 'access_denied');
  assert.equal(new URL(denied.redirect).searchParams.get('iss'), `${f.base}/`);
  assert.equal((await f.decide(flow)).status, 403);
  const expired = await f.begin(client);
  f.clock.time += 11 * 60_000;
  assert.equal((await f.decide(expired)).status, 403);
});

test('authorization errors do not redirect to unregistered URLs and always identify the issuer on valid redirects', async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  assert.equal((await f.begin(client, undefined, { redirect_uri: 'https://evil.example/' })).response.status, 400);
  for (const overrides of [{ code_challenge_method: 'plain' }, { resource: 'https://evil.example/mcp' }, { code_challenge: 'short' }, { scope: 'admin' }]) {
    const flow = await f.begin(client, undefined, overrides);
    assert.equal(flow.response.status, 302);
    const location = new URL(flow.response.headers.get('location'));
    assert.equal(location.origin, 'https://chatgpt.com');
    assert.equal(location.searchParams.get('iss'), `${f.base}/`);
    assert.ok(location.searchParams.get('error'));
  }
});

test('code exchange binds PKCE, client, redirect and resource; codes are one-use', async (t) => {
  const f = await fixture(t);
  const client = await f.register();
  const other = await f.register();
  const flow = await f.codeFor(client);
  for (const overrides of [{ code_verifier: 'x'.repeat(43) }, { client_id: other.client_id }, { redirect_uri: 'https://chatgpt.com/connector/oauth/other' }, { resource: 'https://evil.example/mcp' }, { resource: '' }]) {
    assert.equal((await f.exchange(client, flow, overrides)).status, 400);
  }
  const response = await f.exchange(client, flow);
  assert.equal(response.status, 200);
  const tokens = await response.json();
  assert.equal((await f.rpc(tokens.access_token, 'tools/list')).status, 200);
  assert.equal((await f.exchange(client, flow)).status, 400);
  assert.equal((await f.rpc(tokens.access_token, 'tools/list')).status, 401, 'code replay revokes the issued grant');
  const expired = await f.codeFor(client);
  f.clock.time += 121_000;
  assert.equal((await f.exchange(client, expired)).status, 400);
});

test('OAuth tokens survive restart, store only hashes, rotate refresh tokens and revoke on reuse', async (t) => {
  const f = await fixture(t);
  const { client, tokens } = await f.authorize();
  const stored = fs.readFileSync(f.file, 'utf8');
  assert.ok(!stored.includes(tokens.access_token) && !stored.includes(tokens.refresh_token) && !stored.includes(owner));
  const restarted = new HubOAuth({ publicUrl: f.base, token: owner, file: f.file, now: () => f.clock.time });
  assert.equal((await restarted.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  f.clock.time += 3_600_001;
  assert.equal((await f.rpc(tokens.access_token, 'tools/list')).status, 401);
  const refresh = (overrides = {}) => f.form('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, resource: f.base + '/mcp', ...overrides });
  assert.equal((await refresh({ resource: 'https://wrong.example/mcp' })).status, 400);
  const response = await refresh();
  assert.equal(response.status, 200);
  const next = await response.json();
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.equal((await f.rpc(next.access_token, 'tools/list')).status, 200);
  assert.equal((await refresh()).status, 400);
  assert.equal((await f.rpc(next.access_token, 'tools/list')).status, 401);
});

test('grant expiry, owner rotation and OAuth revocation fail closed; grants stay owner-managed', async (t) => {
  const f = await fixture(t);
  const first = await f.authorize();
  const other = await f.register();
  await f.form('/revoke', { client_id: other.client_id, token: first.tokens.refresh_token });
  assert.equal((await f.rpc(first.tokens.access_token, 'tools/list')).status, 200);
  assert.equal((await f.form('/revoke', { client_id: first.client.client_id, token: first.tokens.refresh_token })).status, 200);
  assert.equal((await f.rpc(first.tokens.access_token, 'tools/list')).status, 401);
  const second = await f.authorize();
  const headers = { Authorization: `Bearer ${owner}` };
  const listed = await (await fetch(f.base + '/api/oauth-connections', { headers })).json();
  assert.equal(listed.connections.length, 1);
  assert.ok(!JSON.stringify(listed).includes(second.tokens.access_token));
  assert.equal((await fetch(f.base + '/api/oauth-connections/' + listed.connections[0].id, { method: 'DELETE', headers: { Authorization: `Bearer ${second.tokens.access_token}` } })).status, 401);
  await fetch(f.base + '/api/oauth-connections/' + listed.connections[0].id, { method: 'DELETE', headers });
  assert.equal((await f.rpc(second.tokens.access_token, 'tools/list')).status, 401);
  const third = await f.authorize();
  const rotated = new HubOAuth({ publicUrl: f.base, token: owner + '-rotated', file: f.file });
  await assert.rejects(rotated.verifyAccessToken(third.tokens.access_token));
  f.clock.time += 31 * 24 * 3_600_000;
  assert.equal((await f.form('/token', { grant_type: 'refresh_token', client_id: third.client.client_id, refresh_token: third.tokens.refresh_token })).status, 400);
});

test('read-only scopes cannot control, escalate or access private REST and relay endpoints', async (t) => {
  const f = await fixture(t);
  const { client, tokens } = await f.authorize('toy:read');
  const catalog = await (await f.rpc(tokens.access_token, 'tools/list')).json();
  assert.deepEqual(catalog.result.tools.map((s) => s.name), ['toy_status']);
  assert.equal((await (await f.rpc(tokens.access_token, 'tools/call', { name: 'toy_stop' })).json()).error.code, -32602);
  const result = await (await f.rpc(tokens.access_token, 'tools/call', { name: 'toy_status' })).json();
  assert.ok(!('heard' in JSON.parse(result.result.content[0].text)));
  for (const route of ['/api/state', '/api/bridge/stream?id=oauth-test', '/api/oauth-connections']) {
    assert.equal((await fetch(f.base + route, { headers: { Authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  }
  assert.equal((await f.json('/api/bridge/report', { bridgeId: 'oauth-test', controlEnabled: true }, { Authorization: `Bearer ${tokens.access_token}` })).status, 401);
  assert.equal((await f.form('/token', { grant_type: 'refresh_token', client_id: client.client_id, refresh_token: tokens.refresh_token, scope: 'toy:read toy:control' })).status, 400);
});

test('invalid persistent expiry and failed revocation writes cannot leave tokens usable', async (t) => {
  const f = await fixture(t);
  const { tokens } = await f.authorize();
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  delete saved.grants[0].expires;
  fs.writeFileSync(f.file, JSON.stringify(saved));
  assert.throws(() => new HubOAuth({ publicUrl: f.base, token: owner, file: f.file }), /Invalid OAuth store/);
  const originalFile = f.oauth.file;
  f.oauth.file = path.join(originalFile, 'not-a-directory');
  assert.throws(() => f.oauth.revokeGrant('unknown-id'));
  assert.equal((await f.rpc(tokens.access_token, 'tools/list')).status, 401);
});

test('official MCP client discovers six bounded tools; local standby and percentage units are preserved', async (t) => {
  const f = await fixture(t);
  const { tokens } = await f.authorize();
  const client = new Client({ name: 'OAuth-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } });
  await client.connect(transport);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  assert.equal(tools.length, 6);
  assert.ok(!tools.some((tool) => ['toy_speak', 'toy_listen'].includes(tool.name)));
  assert.equal((await client.callTool({ name: 'toy_status', arguments: {} })).isError, undefined);
  const sent = [];
  f.hub.attachBridge('simulated-only', (event, data) => { if (event === 'cmd') sent.push(data); });
  const devices = [{ id: 'fake', name: 'Simulation', actuators: [{ type: 'Vibrate' }, { type: 'Suction' }] }];
  f.hub.report('simulated-only', devices, false);
  const call = (name, args) => client.callTool({ name, arguments: args });
  assert.equal((await call('toy_vibrate', { level: 1, seconds: 1 })).isError, true);
  f.hub.report('simulated-only', devices, true);
  for (const args of [{ level: 101 }, { level: true }, { level: 1, seconds: 0 }, { level: 1, seconds: 301 }, { level: 1, feature: 'Electric' }, { level: 1, actuator: 0 }]) {
    assert.equal((await call('toy_vibrate', args)).isError, true);
  }
  assert.equal((await call('toy_pattern', { steps: [{ level: 1, ms: 1 }] })).isError, true);
  assert.equal((await call('toy_draw', { text: 'x'.repeat(13) })).isError, true);
  assert.equal(sent.length, 0);
  assert.equal((await call('toy_vibrate', { level: 1, seconds: 1, feature: 'Suction' })).isError, undefined);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].level, 0.01);
  assert.equal(sent[0].seconds, 1);
  assert.equal((await call('toy_stop', {})).isError, undefined);
});

test('official SDK completes discovery, DCR, PKCE, token exchange and refresh', async (t) => {
  const f = await fixture(t);
  const session = {};
  const provider = {
    redirectUrl: callback,
    clientMetadata: { client_name: 'SDK interoperability test', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] },
    clientInformation: () => session.client,
    saveClientInformation: (value) => { session.client = value; },
    tokens: () => session.tokens,
    saveTokens: (value) => { session.tokens = value; },
    state: () => 'sdk-state',
    saveCodeVerifier: (value) => { session.verifier = value; },
    codeVerifier: () => session.verifier,
    redirectToAuthorization: (url) => { session.authorizationUrl = url; },
  };
  assert.equal(await sdkAuth(provider, { serverUrl: f.base + '/mcp' }), 'REDIRECT');
  const response = await fetch(session.authorizationUrl, { redirect: 'manual' });
  assert.equal(response.status, 200);
  const html = await response.text();
  const flow = { request: /name="request" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1], cookie: response.headers.get('set-cookie').split(';')[0] };
  const redirect = new URL((await (await f.decide(flow)).json()).redirect);
  assert.equal(redirect.searchParams.get('state'), 'sdk-state');
  assert.equal(await sdkAuth(provider, { serverUrl: f.base + '/mcp', authorizationCode: redirect.searchParams.get('code') }), 'AUTHORIZED');
  const original = session.tokens.access_token;
  assert.equal((await f.rpc(original, 'tools/list')).status, 200);
  f.clock.time += 3_600_001;
  assert.equal(await sdkAuth(provider, { serverUrl: f.base + '/mcp' }), 'AUTHORIZED');
  assert.notEqual(session.tokens.access_token, original);
  assert.equal((await f.rpc(session.tokens.access_token, 'tools/list')).status, 200);
});
