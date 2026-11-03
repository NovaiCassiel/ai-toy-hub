// The stage: a breathing orb that flips into a dial. The dial's needle shows the toy's live
// intensity and can be dragged to set it. --heat (0..1) on the page tints the glow, speeds the
// breathing and drives the stage's shake. A hairline slider under the readout does the same job.
const SWEEP = 120; // needle travels from -120° (0) to +120° (100)

export function createStage({ stage, orb, dial, needle, hub, hint, readout, slider, onLevel }) {
  let holding = false; // a finger is on the needle or slider, so don't move them from outside
  let heat = 0;

  const showDial = (on) => {
    stage.classList.toggle('show-dial', on);
    hint.textContent = on ? '拨动指针调强度 · 点中心回去' : '轻点中间 · 换成表盘';
  };
  showDial(false);

  function showLevel(level) {
    const pct = Math.round(level * 100);
    needle.style.setProperty('--needle', `${-SWEEP + level * 2 * SWEEP}deg`);
    hub.textContent = readout.textContent = pct;
    slider.value = pct;
  }
  function paint(level) {
    heat = Math.min(1, Math.max(0, level || 0));
    document.documentElement.style.setProperty('--heat', heat.toFixed(3));
  }
  function userSets(level) { paint(level); showLevel(heat); onLevel(heat); }

  orb.addEventListener('click', () => showDial(true));

  // Angle from the dial centre, 0° at the top, clockwise positive.
  function readDial(e) {
    const r = dial.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2);
    const dy = e.clientY - (r.top + r.height / 2);
    const deg = Math.max(-SWEEP, Math.min(SWEEP, (Math.atan2(dx, -dy) * 180) / Math.PI));
    return { inHub: Math.hypot(dx, dy) < r.width * 0.13, level: (deg + SWEEP) / (2 * SWEEP) };
  }
  let downInHub = false;
  dial.addEventListener('pointerdown', (e) => {
    const { inHub, level } = readDial(e);
    downInHub = inHub;
    if (inHub) return;
    holding = true;
    dial.setPointerCapture(e.pointerId);
    userSets(level);
  });
  dial.addEventListener('pointermove', (e) => { if (holding) userSets(readDial(e).level); });
  dial.addEventListener('pointerup', (e) => {
    if (downInHub && readDial(e).inHub) showDial(false);
    downInHub = false;
    holding = false;
  });
  dial.addEventListener('pointercancel', () => { downInHub = false; holding = false; });

  slider.addEventListener('pointerdown', () => { holding = true; });
  addEventListener('pointerup', () => { holding = false; });
  slider.addEventListener('input', () => userSets(Number(slider.value) / 100));

  const dust = stage.querySelector('.dust');
  for (let i = 0; i < 18; i++) {
    const s = document.createElement('i');
    Object.assign(s.style, { left: `${Math.random() * 100}%`, top: `${100 + Math.random() * 8}%`,
      animationDuration: `${6 + Math.random() * 8}s`, animationDelay: `${-Math.random() * 12}s` });
    dust.append(s);
  }

  return {
    setHeat(level) { paint(level); if (!holding) showLevel(heat); },
    heat: () => heat,
    showDial,
    setBusy: (busy) => { stage.classList.toggle('busy', busy); hint.hidden = busy; },
    setListening: (on) => stage.classList.toggle('listening', on),
    ear: (loudness) => stage.style.setProperty('--ear', Math.min(1, loudness || 0).toFixed(2)),
  };
}

const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };

// Effect switches, remembered per device. Low-key mode turns all of them off.
const FX = ['breathe', 'shake', 'dust', 'ripple'];
export function setupEffects(container) {
  const prefs = { breathe: true, shake: true, dust: true, ripple: true, lowkey: false, ...read('toyhub.fx', {}) };
  const apply = () => {
    for (const k of FX) document.body.classList.toggle(`fx-${k}`, prefs[k] && !prefs.lowkey);
    document.body.classList.toggle('lowkey', prefs.lowkey);
    write('toyhub.fx', prefs);
  };
  container.querySelectorAll('input[data-fx]').forEach((box) => {
    box.checked = prefs[box.dataset.fx];
    box.onchange = () => { prefs[box.dataset.fx] = box.checked; apply(); };
  });
  apply();
}

// Three looks: velvet (misty orb, glass capsules), candy (chrome blob, glossy buttons),
// horology (watch dial, hairlines and serif numerals).
export function setupThemes(container, fallback, onChange = () => {}) {
  const buttons = [...container.querySelectorAll('button[data-theme]')];
  const apply = (name, save) => {
    document.documentElement.dataset.theme = name;
    buttons.forEach((b) => b.classList.toggle('on', b.dataset.theme === name));
    if (save) write('toyhub.theme', name);
    onChange(name);
  };
  buttons.forEach((b) => { b.onclick = () => apply(b.dataset.theme, true); });
  apply(read('toyhub.theme', fallback), false);
}
