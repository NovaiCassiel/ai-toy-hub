import { api, stream, getKey, setKey } from './client.js';
import { connectLovense } from './drivers/lovense.js';
import { connectSosexy } from './drivers/sosexy.js';
import { connectIntiface } from './drivers/intiface.js';
import { stepAt } from './timeline.js';
import { startKeepAlive } from './keep-alive.js';

const $ = (id) => document.getElementById(id);
const devices = new Map();
const running = new Map(); // deviceId -> { actuators, timers }
let bridgeId = sessionStorage.getItem('toyhub.bridge') || `b-${crypto.randomUUID().slice(0, 8)}`;
sessionStorage.setItem('toyhub.bridge', bridgeId);
let pingMs = 15000;
let lastPing = 0;
let abort = null;

function log(text) {
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString()}  ${text}`;
  $('log').prepend(li);
  while ($('log').children.length > 30) $('log').lastChild.remove();
}

function setStatus(text, live) {
  $('status').textContent = text;
  $('status').dataset.live = live ? '1' : '0';
}

function render() {
  const list = $('devices');
  list.replaceChildren(...[...devices.values()].map((d) => {
    const li = document.createElement('li');
    const busy = running.has(d.id) ? ' · 正在动' : '';
    li.textContent = `${d.name}（${d.actuators.map((a) => a.type).join(' / ')}）${d.battery != null ? ` · 电量 ${d.battery}%` : ''}${busy}`;
    return li;
  }));
  $('empty').hidden = devices.size > 0;
}

async function report() {
  render();
  if (!lastPing) return;
  const payload = [...devices.values()].map(({ id, name, driver, actuators, battery }) => ({ id, name, driver, actuators, battery }));
  try { await api('/api/bridge/report', { bridgeId, devices: payload }); } catch (e) { log(`上报失败：${e.message}`); }
}

function addDevices(list) {
  for (const d of list) {
    devices.set(d.id, d);
    d.onGone = () => { halt(d.id); devices.delete(d.id); log(`${d.name} 断开了`); report(); };
    log(`连上 ${d.name}`);
  }
  report();
}

function halt(id, only) {
  const run = running.get(id);
  if (run) { run.timers.forEach(clearTimeout); running.delete(id); }
  const d = devices.get(id);
  if (!d) return;
  if (only) only.forEach((i) => d.set(i, 0)); else d.stopAll();
}

function haltAll(reason) {
  for (const id of devices.keys()) halt(id);
  if (reason) log(reason);
  render();
}

function exec(cmd) {
  const d = devices.get(cmd.deviceId);
  if (!d) return;
  const prev = running.get(d.id);
  if (prev) prev.timers.forEach(clearTimeout);
  running.delete(d.id);
  if (cmd.startIn > 0 && cmd.action !== 'stop') {
    // Hold the start so the toy lines up with audio the panel is still loading.
    running.set(d.id, { actuators: prev?.actuators || [], timers: [setTimeout(() => exec({ ...cmd, startIn: 0 }), cmd.startIn)] });
    return;
  }
  if (cmd.action === 'stop') { d.stopAll(); log(`停 · ${d.name}`); return render(); }

  const leftover = (prev?.actuators || []).filter((i) => !cmd.actuators.includes(i));
  leftover.forEach((i) => d.set(i, 0));
  if (cmd.action === 'level' && cmd.level === 0) { cmd.actuators.forEach((i) => d.set(i, 0)); log(`停 · ${d.name}`); return render(); }
  const run = { actuators: cmd.actuators, timers: [] };
  if (cmd.action === 'level') {
    cmd.actuators.forEach((i) => d.set(i, cmd.level));
    log(`${d.name} → ${Math.round(cmd.level * 100)}%，${cmd.seconds ? `${cmd.seconds}s` : '直到停下'}`);
  } else {
    const started = performance.now();
    let current = -1;
    const tick = () => {
      const { done, index, level } = stepAt(cmd.steps, performance.now() - started, cmd.loop !== false);
      if (done) { clearInterval(run.timers[1]); halt(d.id, cmd.actuators); render(); return; }
      if (index !== current) { current = index; cmd.actuators.forEach((i) => d.set(i, level)); }
    };
    run.timers[1] = setInterval(tick, 50);
    tick();
    log(`${d.name} → ${cmd.loop === false ? '跟着笔走' : '节奏'}，${cmd.seconds ? `${cmd.seconds}s` : '直到停下'}`);
  }
  // Local deadline (seconds = 0 runs until stopped).
  if (cmd.seconds > 0) run.timers[0] = setTimeout(() => { halt(d.id, cmd.actuators); render(); }, cmd.seconds * 1000);
  running.set(d.id, run);
  render();
}

async function connectLoop() {
  while (abort) {
    try {
      setStatus('正在连云端…', false);
      await stream(`/api/bridge/stream?id=${bridgeId}`, (event, data) => {
        lastPing = Date.now();
        if (event === 'hello') { pingMs = data.pingMs; setStatus('已连上云端，可以开始了', true); report(); }
        if (event === 'cmd') exec(data);
      }, abort.signal);
    } catch (e) {
      if (!abort) break;
      log(`云端断开：${e.message}`);
    }
    lastPing = 0;
    haltAll('和云端失联，已经全部停下');
    setStatus('失联了，3 秒后重连…', false);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

// Tells the hub this page is really awake; a frozen page stops beating and the hub can say so.
setInterval(() => { if (lastPing) api('/api/bridge/beat', { bridgeId }).catch(() => {}); }, 10000);
setInterval(() => {
  if (lastPing && Date.now() - lastPing > pingMs * 3) { lastPing = 0; haltAll('云端心跳超时，已经全部停下'); abort?.abort(); abort = new AbortController(); }
}, 5000);
setInterval(async () => {
  for (const d of devices.values()) await d.readBattery().catch(() => null);
  if (devices.size) report();
}, 60000);

let wakeLock = null;
async function keepAwake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && abort) keepAwake(); });

async function tryConnect(fn, label) {
  try { addDevices((await fn()).filter((d) => !devices.has(d.id))); } catch (e) { if (e.name !== 'NotFoundError') log(`${label}：${e.message}`); }
}

$('key').value = getKey();
$('start').onclick = () => {
  setKey($('key').value.trim());
  if (abort) return;
  abort = new AbortController();
  keepAwake();
  startKeepAlive().then((ok) => { if (!ok) log('后台保活没开起来：切走页面时玩具可能会断'); });
  connectLoop();
  $('start').textContent = '中继运行中';
  $('start').disabled = true;
};
$('lovense').onclick = () => tryConnect(connectLovense, 'Lovense');
$('sosexy').onclick = () => tryConnect(connectSosexy, '啵啵贝');
$('intiface').onclick = () => tryConnect(() => connectIntiface(undefined, (list) => addDevices(list.filter((d) => !devices.has(d.id)))), 'Intiface');
$('panic').onclick = () => haltAll('按了急停');
if (!navigator.bluetooth) $('ble-note').hidden = false;
render();
