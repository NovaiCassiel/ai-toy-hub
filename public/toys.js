import { api } from './client.js';

// Toy cards: the user's nickname (tap to rename), battery, what's playing, and per-feature sliders
// for toys with more than one motor (single-motor toys are driven from the dial).
const FEATURE = { Vibrate: '震动', Suction: '吮吸', Rotate: '旋转', Electric: '电流', Constrict: '收缩' };

export function createToyList({ list, empty, describe, onLevel }) {
  const timers = new Map();
  let dragging = false;

  async function rename(d) {
    const alias = prompt(`给「${d.name}」起个名字（留空恢复原名）`, d.alias || '');
    if (alias === null) return;
    await api('/api/toy-name', { toy: d.name, alias }).catch((e) => alert(`没改成：${e.message}`));
  }

  function render(devices = []) {
    empty.hidden = devices.length > 0;
    if (dragging) return; // never rebuild under a finger
    list.replaceChildren(...devices.map((d) => {
      const box = document.createElement('div');
      box.className = 'toy';
      box.innerHTML = '<div class="toy-head"><button class="toy-name"></button><small></small><button class="rename ghost">改名</button></div><div class="now"></div>';
      const name = box.querySelector('.toy-name');
      name.textContent = d.alias || d.name;
      name.onclick = box.querySelector('.rename').onclick = () => rename(d);
      box.querySelector('small').textContent = [d.alias ? d.name : '', d.battery != null ? `电量 ${d.battery}%` : ''].filter(Boolean).join(' · ');
      box.querySelector('.now').textContent = describe(d.activity);
      if (d.actuators.length > 1) d.actuators.forEach((a, i) => {
        const row = document.createElement('div');
        row.className = 'slider';
        const act = d.activity;
        const value = act && act.kind === 'level' && act.actuators.includes(a.type) ? act.detail : 0;
        row.innerHTML = `<span>${FEATURE[a.type] || a.type}</span><input type="range" min="0" max="100" step="5" value="${value}"><b>${value}</b>`;
        const input = row.querySelector('input');
        input.onpointerdown = () => { dragging = true; };
        input.onpointerup = input.onpointercancel = () => { dragging = false; };
        input.oninput = () => {
          row.querySelector('b').textContent = input.value;
          clearTimeout(timers.get(d.key));
          timers.set(d.key, setTimeout(() => onLevel({ device: d.key, actuator: i, level: Number(input.value) }), 120));
        };
        box.append(row);
      });
      return box;
    }));
  }

  return { render };
}
