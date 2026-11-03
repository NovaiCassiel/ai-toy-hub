import { api, stream, getKey, setKey } from './client.js';
import config from './config.js';
import { createBoard } from './board.js';
import { createVoicePlayer } from './voice-player.js';
import { createEars, holdToTalk, micError } from './ears.js';
import { createStage, setupEffects, setupThemes } from './stage.js';
import { createToyList } from './toys.js';

const $ = (id) => document.getElementById(id);
let state = null;
let lastScore = null;
let playing = false; // a drawing or voice is on the stage, so its own level drives the glow
let chosenLevel = 0;

$('title').textContent = document.title = config.title;
$('eyebrow').textContent = config.eyebrow;
document.querySelectorAll('[data-ta]').forEach((el) => { el.textContent = el.textContent.replace('TA', config.partner); });

const seconds = () => Number($('seconds').value);
const who = (source) => (source?.startsWith('mcp:') ? source.slice(4) : source === 'replay' ? '重播' : '你');
const patternName = (d) => state?.patterns?.[d] || (d === 'custom' ? '自定义' : d);

async function send(cmd) {
  try { await api('/api/command', cmd); } catch (e) {
    $('online').textContent = /no toy connected/.test(e.message) ? '玩具还没连上：先在玩具旁边打开中继页' : `没发出去：${e.message}`;
  }
}

setupEffects($('settings'));
const stage = createStage({
  stage: $('stage'), orb: $('orb'), dial: $('dial'), needle: $('needle'), hub: $('dial-hub'),
  hint: $('stage-hint'), readout: $('readout'), slider: $('level'),
  onLevel: (() => {
    let t = null;
    return (level) => {
      chosenLevel = level;
      clearTimeout(t);
      t = setTimeout(() => send({ action: 'level', level: Math.round(level * 100), seconds: seconds() }), 120);
    };
  })(),
});
setupThemes($('themes'), config.theme, (name) => stage.showDial(name === 'horology'));
const board = createBoard({
  ink: $('ink'), tip: $('tip'), meter: $('meter'), note: $('board-note'),
  onLevel: (level) => { if (playing) stage.setHeat(level); },
  onBusy: (busy) => { playing = busy; stage.setBusy(busy); if (!busy) syncHeat(); },
});
const voice = createVoicePlayer($('unlock-sound'));

// Outside playback, the glow follows the strongest thing any toy is doing.
function syncHeat() {
  if (playing) return;
  let heat = 0;
  for (const d of state?.devices || []) {
    const a = d.activity;
    if (a) heat = Math.max(heat, a.kind === 'level' ? a.detail / 100 : 0.6);
  }
  stage.setHeat(heat);
}

function describe(act) {
  if (!act) return '';
  const left = act.until === null ? '直到停下' : `还剩 ${Math.max(0, Math.round((act.until - Date.now()) / 1000))}s`;
  if (act.source === 'replay') return `正在重播「${String(act.detail).replace(/^重播：/, '')}」 · ${left}`;
  return `${who(act.source)}正在${act.kind === 'pattern' ? `放「${patternName(act.detail)}」` : `开到 ${act.detail}%`} · ${left}`;
}
const toys = createToyList({
  list: $('toys'), empty: $('no-toy'), describe,
  onLevel: ({ device, actuator, level }) => send({ action: 'level', device, actuator, level, seconds: seconds() }),
});

function playScore(data) {
  // Both this page and the toy count the lead time from when the score arrives.
  const startAt = performance.now() + (data.replay ? 0 : data.startIn || 0);
  if (data.kind !== 'voice') { voice.stop(); board.play(data, who(data.source)); return; }
  board.playVoice(data, who(data.source), startAt);
  if (!data.replay) {
    voice.play(data.audioId, startAt)
      .then((played) => { if (!played) $('board-note').textContent += '（点「开声音」才能听到）'; })
      .catch((e) => { $('online').textContent = `声音没放出来：${e.message}`; });
  }
}

async function loadSaved() {
  const items = await api('/api/saved').catch(() => []);
  $('saved-box').hidden = !items.length;
  const icon = { voice: '🎙', draw: '✍' };
  $('saved').replaceChildren(...items.map((s) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><small></small><button class="pink">重播</button><button class="ghost">删除</button>';
    li.querySelector('span').textContent = `${icon[s.kind] || '✍'} ${s.name}`;
    li.querySelector('small').textContent = `${Math.round(s.duration / 1000)}s`;
    const [play, del] = li.querySelectorAll('button');
    play.onclick = () => api(`/api/saved/${s.id}/play`, {}).catch((e) => { $('online').textContent = `重播失败：${e.message}`; });
    del.onclick = async () => { if (confirm(`删掉「${s.name}」？`)) { await api(`/api/saved/${s.id}`, null, 'DELETE'); loadSaved(); } };
    return li;
  }));
}

function render() {
  if (!state) return;
  const names = state.devices.map((d) => d.alias || d.name).join('、');
  $('online').textContent = state.relayAsleep ? '中继睡着了：玩具现在收不到指令，切回中继页就能叫醒'
    : state.online ? `中继在线 · ${names || '还没连玩具'}` : '中继不在线（玩具旁边的中继页没开）';
  if ($('patterns').childElementCount !== Object.keys(state.patterns).length) {
    $('patterns').replaceChildren(...Object.entries(state.patterns).map(([name, text]) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.onclick = () => send({ action: 'pattern', pattern: name, intensity: Math.round((chosenLevel || 0.7) * 100), seconds: seconds() });
      return b;
    }));
  }
  $('recent').replaceChildren(...state.recent.slice().reverse().map((r) => {
    const li = document.createElement('li');
    li.textContent = `${new Date(r.at).toLocaleTimeString()} · ${who(r.source)} · ${r.action === 'stop' ? '停' : r.action === 'pattern' ? patternName(r.detail) : `${r.detail}%`}`;
    return li;
  }));
  toys.render(state.devices);
  syncHeat();
}

async function live() {
  for (;;) {
    try {
      await stream('/api/events', (event, data) => {
        if (event === 'state') { state = data; render(); }
        if (event === 'halt') { voice.stop(); board.stop(`${who(data.source)}按了停，停在这儿了`); }
        if (event === 'score') {
          playScore(data);
          lastScore = data;
          $('save-score').disabled = data.source === 'replay';
          $('save-score').textContent = '收进回放';
        }
      });
    } catch (e) {
      $('online').textContent = e.message === '钥匙不对' ? '钥匙不对，重新填一下' : '和云端断开，正在重连…';
      if (e.message === '钥匙不对') { $('key-box').hidden = false; return; }
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const earsNote = $('ears-note').textContent;
const ears = createEars({
  isVoicePlaying: () => voice.playing(),
  onStatus: (text) => { $('ears-note').textContent = text || earsNote; },
  onLabels: (pairs) => {
    stage.ear(pairs[0]?.[1] || 0);
    $('ears-labels').replaceChildren(...pairs.map(([label]) => Object.assign(document.createElement('span'), { textContent: label })));
  },
});
$('ears-toggle').onclick = async () => {
  const btn = $('ears-toggle');
  if (ears.listening()) { ears.stop(); stage.setListening(false); btn.textContent = '开始听'; btn.classList.remove('on'); return; }
  try {
    await ears.start();
    stage.setListening(true); btn.textContent = '正在听'; btn.classList.add('on');
  } catch (e) { $('ears-note').textContent = micError(e); }
};
holdToTalk($('talk'), {
  onStatus: (text) => { $('ears-note').textContent = text; },
  onText: (text) => { $('ears-note').textContent = text ? `听到了：「${text}」` : '没听清，再说一次？'; },
});

$('gear').onclick = () => { $('settings').hidden = !$('settings').hidden; };
$('stop').onclick = () => { voice.stop(); board.stop('停在这儿了'); chosenLevel = 0; stage.setHeat(0); send({ action: 'stop' }); };
$('save-score').onclick = async () => {
  if (!lastScore) return;
  const fallback = `${lastScore.label.replace(/^(写字|说)：/, '')} · ${new Date(lastScore.at).toLocaleDateString()}`;
  const name = prompt('给这一段起个名字', fallback);
  if (name === null) return;
  try {
    await api('/api/saved', { name: name.trim() || fallback });
    $('save-score').textContent = '已收进回放 ✓';
    $('save-score').disabled = true;
    loadSaved();
  } catch (e) { $('online').textContent = `没存上：${e.message}`; }
};
document.querySelectorAll('#feedback button').forEach((btn) => {
  btn.onclick = async () => {
    try {
      await api('/api/feedback', { kind: btn.dataset.kind });
      btn.classList.add('sent');
      setTimeout(() => btn.classList.remove('sent'), 1500);
    } catch (e) { $('online').textContent = `没发出去：${e.message}`; }
  };
});
$('save-key').onclick = () => { setKey($('key').value.trim()); $('key-box').hidden = true; live(); loadSaved(); };
setInterval(() => toys.render(state?.devices), 1000);
if (getKey()) { $('key-box').hidden = true; live(); loadSaved(); }
