// Shared browser helpers: hub base URL, key storage, authed fetch and SSE-over-fetch.
export const HUB = new URL('.', location.href).href.replace(/\/$/, '');

const KEY = 'toyhub.key';
export function getKey() { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } }
export function setKey(v) { try { localStorage.setItem(KEY, v); } catch {} }

// A "#key=…" link (e.g. from a QR code) stores the key once, then drops it from the address bar.
const fromLink = new URLSearchParams(location.hash.slice(1)).get('key');
if (fromLink) {
  setKey(fromLink);
  history.replaceState(null, '', location.pathname + location.search);
}

export async function api(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: { Authorization: `Bearer ${getKey()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export async function apiBlob(path) {
  const res = await fetch(`${HUB}${path}`, { headers: { Authorization: `Bearer ${getKey()}` } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.arrayBuffer();
}

// EventSource can't send headers, so read the event stream through fetch.
export async function stream(path, onEvent, signal) {
  const res = await fetch(`${HUB}${path}`, { headers: { Authorization: `Bearer ${getKey()}` }, signal });
  if (!res.ok) throw new Error(res.status === 401 ? '钥匙不对' : `HTTP ${res.status}`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let cut;
    while ((cut = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const event = /^event: (.*)$/m.exec(chunk)?.[1] || 'message';
      const data = /^data: (.*)$/m.exec(chunk)?.[1];
      if (data) onEvent(event, JSON.parse(data));
    }
  }
}
