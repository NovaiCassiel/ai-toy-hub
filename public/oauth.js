'use strict';

// The owner key stays on this origin. Only a one-use authorization code goes
// back to ChatGPT after the owner presses the consent button.
const keyInput = document.getElementById('key');
const statusText = document.getElementById('status');
try {
  keyInput.value = localStorage.getItem('toyhub.key') || '';
  if (keyInput.value) document.getElementById('key-note').textContent = '已找到这台电脑保存的中继钥匙。';
} catch { /* Private browsing may disable storage. */ }

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${keyInput.value.trim()}`, 'Content-Type': 'application/json' },
    credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(response.status === 401 ? '中继钥匙不正确。' : result.error || '暂时连接不上，请重试。');
  return result;
}

const consent = document.getElementById('consent');
if (consent) {
  let busy = false;
  async function decide(allow) {
    if (busy) return;
    if (allow && !keyInput.value.trim()) { statusText.textContent = '请填写电脑中继正在使用的钥匙。'; keyInput.focus(); return; }
    busy = true;
    const buttons = [...consent.querySelectorAll('button')];
    buttons.forEach((b) => { b.disabled = true; });
    statusText.textContent = allow ? '正在连接…' : '正在返回…';
    try {
      const result = await request('/oauth/decision', { method: 'POST', body: JSON.stringify({ request: consent.elements.request.value, csrf: consent.elements.csrf.value, allow }) });
      const target = new URL(result.redirect);
      if (target.origin !== 'https://chatgpt.com') throw new Error('返回地址不正确。');
      location.replace(target.href);
    } catch (error) {
      statusText.textContent = error.message;
      busy = false;
      buttons.forEach((b) => { b.disabled = false; });
    }
  }
  consent.addEventListener('submit', (event) => { event.preventDefault(); decide(true); });
  document.getElementById('deny').addEventListener('click', () => decide(false));
}

const connections = document.getElementById('connections');
if (connections) {
  async function loadConnections() {
    statusText.textContent = '正在读取…';
    try {
      const result = await request('/api/oauth-connections');
      const list = document.getElementById('grants');
      list.replaceChildren();
      for (const grant of result.connections) {
        const item = document.createElement('li');
        const label = document.createElement('span');
        label.textContent = grant.name;
        const date = document.createElement('small');
        date.textContent = `授权于 ${new Date(grant.created).toLocaleDateString()}`;
        label.append(date);
        const button = document.createElement('button');
        button.className = 'secondary';
        button.textContent = '撤销';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await request(`/api/oauth-connections/${encodeURIComponent(grant.id)}`, { method: 'DELETE' });
            await loadConnections();
          } catch (error) { statusText.textContent = error.message; button.disabled = false; }
        });
        item.append(label, button);
        list.append(item);
      }
      statusText.textContent = result.connections.length ? '撤销后，该连接将立即失效。' : '还没有已授权的连接。';
    } catch (error) { statusText.textContent = error.message; }
  }
  connections.addEventListener('submit', (event) => { event.preventDefault(); loadConnections(); });
  if (keyInput.value) loadConnections();
}
