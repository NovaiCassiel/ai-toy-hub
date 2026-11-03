// 啵啵贝 (SOSEXY) over Web Bluetooth. 12-byte frames, protocol documented by the
// open-source sosexy-ble-control / Toy-Relay projects (MIT).
import { createWriter } from './lovense.js';

const SERVICE = '0000ee01-0000-1000-8000-00805f9b34fb';
const WRITE = '0000ee03-0000-1000-8000-00805f9b34fb';
const MOTORS = [
  { type: 'Vibrate', mode: [0x01, 0x02] },
  { type: 'Suction', mode: [0x07, 0x08] },
];
const frame = ([m1, m2], pct) => new Uint8Array([0x01, 0x01, 0x00, 0x02, 0x00, m1, 0x11, pct, 0x00, m2, 0x11, 0x01]);

export async function connectSosexy() {
  const ble = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'SOSEXY' }], optionalServices: [SERVICE] });
  const gatt = await ble.gatt.connect();
  const ch = await (await gatt.getPrimaryService(SERVICE)).getCharacteristic(WRITE);
  const queue = createWriter((bytes) => ch.writeValueWithResponse(bytes));
  const device = {
    id: ble.id, name: '啵啵贝', driver: 'sosexy',
    actuators: MOTORS.map(({ type }) => ({ type })),
    battery: null,
    set(index, level) { queue.push(index, frame(MOTORS[index].mode, Math.round(level * 100))); },
    stopAll() { MOTORS.forEach((_, i) => device.set(i, 0)); },
    async readBattery() { return null; },
    onGone: null,
  };
  ble.addEventListener('gattserverdisconnected', () => device.onGone?.());
  return [device];
}
