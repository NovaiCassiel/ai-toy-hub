// Any toy Intiface Central knows (hundreds of brands), via its local Buttplug v3 WebSocket.
const DEFAULT_URL = 'ws://127.0.0.1:12345';

export async function connectIntiface(url = DEFAULT_URL, onChange = () => {}) {
  const ws = new WebSocket(url);
  let id = 1;
  const waiting = new Map();
  const devices = new Map();
  const send = (type, body = {}) => new Promise((resolve) => {
    const msgId = id++;
    waiting.set(msgId, resolve);
    ws.send(JSON.stringify([{ [type]: { ...body, Id: msgId } }]));
  });

  const wrap = (d) => {
    const scalars = d.DeviceMessages?.ScalarCmd || [];
    const device = {
      id: `intiface-${d.DeviceIndex}`, name: d.DeviceName, driver: 'intiface',
      actuators: scalars.map((s) => ({ type: s.ActuatorType === 'Oscillate' ? 'Vibrate' : s.ActuatorType })),
      battery: null,
      set(index, level) {
        return send('ScalarCmd', { DeviceIndex: d.DeviceIndex, Scalars: [{ Index: index, Scalar: level, ActuatorType: scalars[index].ActuatorType }] });
      },
      stopAll() { return send('StopDeviceCmd', { DeviceIndex: d.DeviceIndex }); },
      async readBattery() {
        if (!d.DeviceMessages?.SensorReadCmd?.some((s) => s.SensorType === 'Battery')) return null;
        const r = await send('SensorReadCmd', { DeviceIndex: d.DeviceIndex, SensorIndex: 0, SensorType: 'Battery' });
        device.battery = r?.SensorReading?.Data?.[0] ?? null;
        return device.battery;
      },
      onGone: null,
    };
    return device;
  };

  ws.onmessage = (e) => {
    for (const m of JSON.parse(e.data)) {
      const [type, v] = Object.entries(m)[0];
      if (v.Id && waiting.has(v.Id)) { waiting.get(v.Id)({ [type]: v, ...v }); waiting.delete(v.Id); }
      if (type === 'DeviceAdded') { devices.set(v.DeviceIndex, wrap(v)); onChange([...devices.values()]); }
      if (type === 'DeviceList') v.Devices.forEach((d) => devices.set(d.DeviceIndex, wrap(d)));
      if (type === 'DeviceRemoved') { devices.get(v.DeviceIndex)?.onGone?.(); devices.delete(v.DeviceIndex); onChange([...devices.values()]); }
    }
  };
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('连不上 Intiface，请先在 Intiface Central 里点 Start Server'));
  });
  ws.onclose = () => { for (const d of devices.values()) d.onGone?.(); };

  await send('RequestServerInfo', { ClientName: 'toy-hub-bridge', MessageVersion: 3 });
  await send('RequestDeviceList');
  await send('StartScanning');
  await new Promise((r) => setTimeout(r, 6000));
  await send('StopScanning');
  const list = [...devices.values()];
  await Promise.all(list.map((d) => d.readBattery().catch(() => null)));
  return list;
}
