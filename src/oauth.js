'use strict';

// Single-owner OAuth provider. The SDK owns the protocol endpoints; this file
// owns explicit consent, bounded storage, token lifetimes and the owner key.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { mcpAuthMetadataRouter } = require('@modelcontextprotocol/sdk/server/auth/router.js');
const { authorizationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/authorize.js');
const { tokenHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/token.js');
const { clientRegistrationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/register.js');
const { revocationHandler } = require('@modelcontextprotocol/sdk/server/auth/handlers/revoke.js');
const {
  InvalidClientMetadataError, InvalidGrantError, InvalidScopeError,
  InvalidTokenError, InvalidTargetError, InvalidRequestError, TooManyRequestsError,
} = require('@modelcontextprotocol/sdk/server/auth/errors.js');

const SCOPES = ['toy:read', 'toy:control'];
const MINUTE = 60 * 1000;
const ACCESS_MS = 60 * MINUTE;
const GRANT_MS = 30 * 24 * ACCESS_MS;
const random = () => crypto.randomBytes(32).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(String(s || '')).digest('hex');
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function chatGptRedirect(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://chatgpt.com' && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '/connector_platform_oauth_redirect' || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))
      && url.href === value;
  } catch { return false; }
}

function scopesOf(scopes, fallback = SCOPES) {
  const result = [...new Set(scopes?.length ? scopes : fallback)];
  if (!result.length || result.some((s) => !SCOPES.includes(s))) throw new InvalidScopeError('Unknown scope');
  return result;
}

function page(body, title = '连接 ChatGPT') {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Novai</title><link rel="stylesheet" href="/oauth.css"></head><body><main><p class="eyebrow">NOVAI · TOY HUB</p>${body}</main><script src="/oauth.js" defer></script></body></html>`;
}

class HubOAuth {
  constructor({ publicUrl, token, file, now = () => Date.now() }) {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('TOY_HUB_PUBLIC_URL must use HTTPS');
    }
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('TOY_HUB_PUBLIC_URL must be an origin');
    if (!token || !file) throw new Error('OAuth requires an owner key and persistent storage');
    this.origin = url.origin;
    this.issuer = `${url.origin}/`;
    this.resource = `${url.origin}/mcp`;
    this.metadataUrl = `${url.origin}/.well-known/oauth-protected-resource/mcp`;
    this.secure = url.protocol === 'https:';
    this.cookieName = this.secure ? '__Host-toyhub-oauth' : 'toyhub-oauth';
    this.token = token;
    this.file = file;
    this.now = now;
    this.pending = new Map();
    this.codes = new Map();
    this.usedCodes = new Map();
    this.state = { version: 1, owner: hash(`oauth:${this.resource}:${token}`), clients: [], grants: [] };
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.clients) || !Array.isArray(saved.grants)
        || saved.clients.length > 512 || saved.grants.length > 32
        || saved.clients.some((c) => typeof c.client_id !== 'string' || !Number.isSafeInteger(c.client_id_issued_at)
          || c.token_endpoint_auth_method !== 'none' || !Array.isArray(c.redirect_uris) || !c.redirect_uris.length
          || !c.redirect_uris.every(chatGptRedirect) || typeof c.scope !== 'string')
        || saved.grants.some((g) => typeof g.id !== 'string' || typeof g.clientId !== 'string'
          || ![g.created, g.expires, g.accessExpires].every(Number.isSafeInteger)
          || typeof g.resource !== 'string' || !Array.isArray(g.scopes) || !g.scopes.length || g.scopes.some((s) => !SCOPES.includes(s))
          || !Array.isArray(g.usedRefresh) || g.usedRefresh.length > 2048
          || ![g.accessHash, g.refreshHash, ...g.usedRefresh].every((h) => /^[a-f0-9]{64}$/.test(h)))) throw new Error('Invalid OAuth store');
      this.state.clients = saved.clients;
      if (saved.owner === this.state.owner) this.state.grants = saved.grants;
    }
    this.prune();
    this.save();
    this.clientsStore = {
      getClient: (id) => { this.prune(); return this.state.clients.find((c) => c.client_id === id); },
      registerClient: (client) => this.register(client),
    };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600, flush: true });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      // Never continue serving stale grants after a failed revocation write.
      this.storageFailed = true;
      throw error;
    }
  }

  prune() {
    const now = this.now();
    this.state.grants = this.state.grants.filter((g) => g.expires > now);
    const activeClients = new Set(this.state.grants.map((g) => g.clientId));
    this.state.clients = this.state.clients.filter((c) => activeClients.has(c.client_id) || c.client_id_issued_at * 1000 > now - 24 * ACCESS_MS);
    for (const map of [this.pending, this.codes, this.usedCodes]) {
      for (const [key, value] of map) if (value.expires <= now) map.delete(key);
    }
  }

  register(client) {
    this.prune();
    if (client.token_endpoint_auth_method !== 'none' || client.client_secret) throw new InvalidClientMetadataError('Use a public client with PKCE');
    if (!client.redirect_uris?.length || client.redirect_uris.length > 4 || !client.redirect_uris.every(chatGptRedirect)) throw new InvalidClientMetadataError('Only ChatGPT callback URLs are allowed');
    if (client.grant_types?.some((g) => !['authorization_code', 'refresh_token'].includes(g)) || client.response_types?.some((r) => r !== 'code')) throw new InvalidClientMetadataError('Authorization code flow required');
    if (this.state.clients.length >= 512) throw new TooManyRequestsError('Client registration is full; try later');
    const stored = {
      client_id: client.client_id, client_id_issued_at: Math.floor(this.now() / 1000),
      client_name: String(client.client_name || 'ChatGPT').slice(0, 80),
      redirect_uris: client.redirect_uris, token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      scope: scopesOf(client.scope?.split(' ')).join(' '),
    };
    this.state.clients.push(stored);
    this.save();
    return stored;
  }

  checkResource(resource, optional = false) {
    if ((!resource && optional) || resource?.href === this.resource) return;
    throw new InvalidTargetError('Resource must be this Hub MCP endpoint');
  }

  async authorize(client, params, res) {
    this.prune();
    this.checkResource(params.resource);
    const scopes = scopesOf(params.scopes);
    if (scopes.some((s) => !client.scope.split(' ').includes(s))) throw new InvalidScopeError('Scope exceeds the registered client scope');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || (params.state?.length || 0) > 1024) throw new InvalidRequestError('Invalid PKCE challenge or state');
    if (this.pending.size >= 128) throw new TooManyRequestsError('Too many pending authorizations');
    const id = random();
    const csrf = random();
    const session = this.cookie(res.req) || random();
    this.pending.set(id, { clientId: client.client_id, ...params, scopes, resource: this.resource, session: hash(session), csrf: hash(csrf), expires: this.now() + 10 * MINUTE });
    res.cookie(this.cookieName, session, { httpOnly: true, secure: this.secure, sameSite: 'lax', path: '/', maxAge: 10 * MINUTE });
    res.type('html').send(page(`<h1>连接 ChatGPT</h1><p class="intro">${escape(client.client_name)} 请求连接你的小玩具中继。</p><ul class="permissions">${scopes.includes('toy:read') ? '<li>查看设备连接、待机状态和电量</li>' : ''}${scopes.includes('toy:control') ? '<li>发送控制、图案与停止指令</li>' : ''}</ul><p class="note">连接后，仍需你在电脑中继点击「允许控制」。</p><form id="consent"><input type="hidden" name="request" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label for="key">中继钥匙</label><input id="key" type="password" autocomplete="current-password" spellcheck="false" placeholder="仅在此页面验证，不会交给 ChatGPT"><p id="key-note" class="note"></p><div class="actions"><button type="button" id="deny" class="secondary">取消</button><button type="submit" id="approve">允许连接</button></div></form><p id="status" role="status" aria-live="polite"></p><p class="note">回到 chatgpt.com · 可随时在「连接管理」撤销</p>`));
  }

  cookie(req) {
    const value = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${this.cookieName}=`))?.slice(this.cookieName.length + 1);
    return /^[A-Za-z0-9_-]{43}$/.test(value || '') ? value : '';
  }

  decide(req, res) {
    this.prune();
    const pending = this.pending.get(req.body?.request);
    if (req.get('origin') !== this.origin || !pending || !equal(hash(this.cookie(req)), pending.session) || !equal(hash(req.body?.csrf), pending.csrf)) {
      return res.status(403).json({ error: '授权页面已失效，请从 ChatGPT 重新连接。' });
    }
    if (typeof req.body.allow !== 'boolean') return res.status(400).json({ error: '请选择允许或取消。' });
    if (req.body.allow && !equal((req.get('authorization') || '').replace(/^Bearer\s+/i, ''), this.token)) return res.status(401).json({ error: '中继钥匙不正确。' });
    if (req.body.allow && this.state.grants.length >= 32) return res.status(409).json({ error: '请先在连接管理中撤销旧连接。' });
    const target = new URL(pending.redirectUri);
    if (pending.state !== undefined) target.searchParams.set('state', pending.state);
    target.searchParams.set('iss', this.issuer);
    if (req.body.allow) {
      const code = random();
      this.codes.set(hash(code), { ...pending, expires: this.now() + 2 * MINUTE });
      target.searchParams.set('code', code);
    } else target.searchParams.set('error', 'access_denied');
    this.pending.delete(req.body.request);
    res.json({ redirect: target.href });
  }

  authorizationCode(client, code) {
    this.prune();
    const key = hash(code);
    const used = this.usedCodes.get(key);
    if (used && used.clientId === client.client_id) {
      this.revokeGrant(used.grantId);
      throw new InvalidGrantError('Authorization code already used');
    }
    const item = this.codes.get(key);
    if (!item || item.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code');
    return item;
  }

  async challengeForAuthorizationCode(client, code) { return this.authorizationCode(client, code).codeChallenge; }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const item = this.authorizationCode(client, code);
    this.checkResource(resource);
    if (redirectUri !== item.redirectUri) throw new InvalidGrantError('Redirect URI mismatch');
    if (this.state.grants.length >= 32) throw new TooManyRequestsError('Too many active grants');
    // No await between code consumption and durable token creation.
    this.codes.delete(hash(code));
    const grant = { id: crypto.randomUUID(), clientId: client.client_id, scopes: item.scopes, resource: this.resource, created: this.now(), expires: this.now() + GRANT_MS, usedRefresh: [] };
    this.state.grants.push(grant);
    this.usedCodes.set(hash(code), { grantId: grant.id, clientId: client.client_id, expires: this.now() + 2 * MINUTE });
    return this.issue(grant);
  }

  issue(grant) {
    const access = random();
    const refresh = random();
    grant.accessHash = hash(access);
    grant.refreshHash = hash(refresh);
    grant.accessExpires = Math.min(this.now() + ACCESS_MS, grant.expires);
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor((grant.accessExpires - this.now()) / 1000), refresh_token: refresh, scope: grant.scopes.join(' ') };
  }

  async exchangeRefreshToken(client, token, scopes, resource) {
    this.prune();
    this.checkResource(resource, true);
    const fingerprint = hash(token);
    const grant = this.state.grants.find((g) => g.clientId === client.client_id && (g.refreshHash === fingerprint || g.usedRefresh.includes(fingerprint)));
    if (!grant) throw new InvalidGrantError('Invalid or expired refresh token');
    if (grant.refreshHash !== fingerprint || grant.usedRefresh.length >= 2048) {
      this.revokeGrant(grant.id);
      throw new InvalidGrantError('Refresh token reused or exhausted; reconnect');
    }
    const requested = scopesOf(scopes, grant.scopes);
    if (requested.some((s) => !grant.scopes.includes(s))) throw new InvalidScopeError('Scope exceeds the original authorization');
    grant.usedRefresh.push(fingerprint);
    grant.scopes = requested;
    return this.issue(grant);
  }

  async verifyAccessToken(token) {
    if (this.storageFailed) throw new InvalidTokenError('OAuth storage unavailable');
    const grant = this.state.grants.find((g) => g.accessHash === hash(token));
    if (!grant || grant.expires <= this.now() || grant.accessExpires <= this.now() || grant.resource !== this.resource) throw new InvalidTokenError('Invalid or expired access token');
    return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: Math.floor(grant.accessExpires / 1000), resource: new URL(grant.resource) };
  }

  revokeGrant(id) {
    this.state.grants = this.state.grants.filter((g) => g.id !== id);
    this.save();
  }

  async revokeToken(client, request) {
    const fingerprint = hash(request.token);
    const grant = this.state.grants.find((g) => g.clientId === client.client_id && (g.accessHash === fingerprint || g.refreshHash === fingerprint || g.usedRefresh.includes(fingerprint)));
    if (grant) this.revokeGrant(grant.id);
  }

  connections() {
    this.prune();
    return this.state.grants.map((g) => ({ id: g.id, name: this.clientsStore.getClient(g.clientId)?.client_name || 'ChatGPT', scopes: g.scopes, created: g.created, expires: g.expires }));
  }

  router({ rateLimits = true } = {}) {
    const router = express.Router();
    const security = (_req, res, next) => {
      res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
      next();
    };
    const rate = rateLimits ? { keyGenerator: () => 'hub' } : false; // Single owner; never trust spoofable proxy IP headers.
    const oauthMetadata = {
      issuer: this.issuer, authorization_endpoint: `${this.origin}/authorize`, token_endpoint: `${this.origin}/token`,
      registration_endpoint: `${this.origin}/register`, revocation_endpoint: `${this.origin}/revoke`,
      response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: SCOPES,
      authorization_response_iss_parameter_supported: true,
    };
    router.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: new URL(this.resource), scopesSupported: SCOPES, resourceName: 'Novai Toy Hub' }));
    router.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: this.resource, authorization_servers: [this.issuer], scopes_supported: SCOPES }));
    router.use(['/authorize', '/token', '/register', '/revoke', '/oauth/decision', '/connections.html'], security);
    // Bound public request bodies before the SDK's protocol parsers run.
    router.use(['/authorize', '/token', '/revoke'], express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 24 }));
    router.use(['/register', '/oauth/decision'], express.json({ limit: '8kb' }));
    // Consent has its own budget, separate from protocol traffic. No forwarded
    // IP is used as authority, since the service has one owner behind a tunnel.
    let decisionWindow = 0;
    let decisionCount = 0;
    router.use('/oauth/decision', (_req, res, next) => {
      if (rateLimits) {
        if (Date.now() - decisionWindow > MINUTE) { decisionWindow = Date.now(); decisionCount = 0; }
        if (++decisionCount > 30) return res.status(429).json({ error: '请求太频繁，请稍后再试。' });
      }
      next();
    });
    router.use('/authorize', (req, res, next) => {
      const redirect = res.redirect.bind(res);
      res.redirect = (status, location) => {
        const target = new URL(location === undefined ? status : location);
        // SDK validation failures use redirects too; every authorization response carries iss.
        target.searchParams.set('iss', this.issuer);
        return redirect(location === undefined ? 302 : status, target.href);
      };
      next();
    }, authorizationHandler({ provider: this, rateLimit: rate }));
    router.use('/register', clientRegistrationHandler({ clientsStore: this.clientsStore, rateLimit: rate }));
    router.use('/token', (req, res, next) => {
      if (req.body?.grant_type === 'authorization_code' && !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body.code_verifier || '')) return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid code verifier' });
      next();
    }, tokenHandler({ provider: this, rateLimit: rate }));
    router.use('/revoke', revocationHandler({ provider: this, rateLimit: rate }));
    router.post('/oauth/decision', (req, res, next) => { try { this.decide(req, res); } catch (e) { next(e); } });
    router.get('/connections.html', (_req, res) => res.type('html').send(page('<h1>连接管理</h1><form id="connections"><label for="key">中继钥匙</label><input id="key" type="password" autocomplete="current-password" spellcheck="false"><p id="key-note" class="note"></p><button type="submit">查看授权</button></form><p id="status" role="status" aria-live="polite"></p><ul id="grants"></ul><a class="back" href="/bridge.html">返回中继</a>', '连接管理')));
    router.use((error, _req, res, _next) => res.status(error.type === 'entity.too.large' ? 413 : 500).json({ error: 'OAuth request could not be completed' }));
    return router;
  }
}

module.exports = { HubOAuth, SCOPES, chatGptRedirect };
