// Lovense over Web Bluetooth. Text protocol: "Vibrate:0-20;", "Rotate:0-20;", "Battery;".
// Service list follows Buttplug's public device config; tx/rx swap the 0001 segment for 0002/0003.
const PREFIXES = ['6e40', '5030', '5730', '5a30', '5330', '4f30', '4230', '4330', '4c30', '4c41', '5630', '5830', '5230',
  '4630', '4a30', '4544', '4542', '5430', '4549', '4e30', '4541', '5130', '4546', '454c', '5530', '5344', '4830', '4653',
  '4241', '4341', '4f43', '455a', '5744', '414e', '5142'];
const SERVICES = [
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', '50300001-0024-4bd4-bbd5-a6920e4c5653', '5a300001-0024-4bd4-bbd5-a6920e4c5653',
  ...PREFIXES.filter((p) => p !== '6e40').map((p) => `${p}0001-0023-4bd4-bbd5-a6920e4c5653`),
  '0000fff0-0000-1000-8000-00805f9b34fb',
];
const charFor = (service, n) => service.startsWith('0000fff0')
  ? `0000fff${n === 2 ? 2 : 1}-0000-1000-8000-00805f9b34fb`
  : `${service.slice(0, 4)}000${n}${service.slice(8)}`;

// Identifier letter from "DeviceType;" → extra actuators beyond a single vibrator.
const LAYOUTS = { P: ['Vibrate', 'Vibrate'], A: ['Vibrate', 'Rotate'], C: ['Vibrate', 'Rotate'], CB: ['Vibrate', 'Rotate'] };

export async function connectLovense() {
  const ble = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'LVS-' }], optionalServices: SERVICES });
  const gatt = await ble.gatt.connect();
  const services = await gatt.getPrimaryServices();
  const service = services.find((s) => SERVICES.includes(s.uuid));
  if (!service) throw new Error('没找到 Lovense 的控制通道');
  const tx = await service.getCharacteristic(charFor(service.uuid, 2));
  const rx = await service.getCharacteristic(charFor(service.uuid, 3));
  let waiter = null;
  rx.addEventListener('characteristicvaluechanged', (e) => {
    const text = new TextDecoder().decode(e.target.value).trim();
    if (waiter) { waiter(text); waiter = null; }
  });
  await rx.startNotifications();

  const queue = createWriter((text) => tx.writeValue(new TextEncoder().encode(text)));
  const ask = (text) => new Promise((resolve) => {
    waiter = resolve;
    queue.push(`ask:${text}`, text);
    setTimeout(() => { if (waiter === resolve) { waiter = null; resolve(''); } }, 1500);
  });

  const type = (await ask('DeviceType;')).split(':')[0].replace(/[^A-Z]/g, '');
  const layout = LAYOUTS[type] || ['Vibrate'];
  const device = {
    id: ble.id, name: ble.name?.replace(/^LVS-/, 'Lovense ') || 'Lovense', driver: 'lovense',
    actuators: layout.map((t) => ({ type: t })),
    battery: null,
    set(index, level) {
      const n = Math.round(level * 20);
      const kind = layout[index];
      if (kind === 'Rotate') return queue.push(`a${index}`, `Rotate:${n};`);
      return queue.push(`a${index}`, layout.length > 1 && layout[1] === 'Vibrate' ? `Vibrate${index + 1}:${n};` : `Vibrate:${n};`);
    },
    stopAll() { layout.forEach((_, i) => device.set(i, 0)); },
    async readBattery() {
      const b = parseInt(await ask('Battery;'), 10);
      device.battery = Number.isFinite(b) ? b : null;
      return device.battery;
    },
    onGone: null,
  };
  ble.addEventListener('gattserverdisconnected', () => device.onGone?.());
  await device.readBattery();
  return [device];
}

// Serialises GATT writes and keeps only the newest pending value per key, so a
// fast slider never piles up stale commands.
export function createWriter(write) {
  const pending = new Map();
  let busy = false;
  async function drain() {
    if (busy) return;
    busy = true;
    while (pending.size) {
      const [key, value] = pending.entries().next().value;
      pending.delete(key);
      try { await write(value); } catch (e) { console.warn('ble write failed', e); }
    }
    busy = false;
  }
  return { push(key, value) { pending.set(key, value); drain(); } };
}
