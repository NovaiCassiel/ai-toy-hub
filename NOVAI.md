# Novai deployment

This fork keeps AI Toy Hub's upstream license and credits. It adds a bounded
Novai deployment and a standby gate to the browser relay.

## Connections

`iPhone chat -> Brain -> Hub -> Windows Chrome/Edge relay -> Bluetooth device`

- Run `docker compose -f compose.novai.yaml up -d --build` on the VPS with a
  privately generated `TOY_HUB_TOKEN` in `.env` (32 random bytes or more).
- The only host listener is `127.0.0.1:13737`. Connect a named Cloudflare Tunnel
  hostname to `http://localhost:13737`. Quick Tunnels cannot carry this SSE relay.
- Brain's API and worker use `http://novai-toy-hub:3737` over the existing private
  `coolify` Docker network and the same bearer token. Configure both persistent
  Coolify variables `NOVAI_TOY_HUB_INTERNAL_URL` and `NOVAI_TOY_HUB_TOKEN`, then
  deploy the Brain version that registers the Toy Hub tools. Never put the token
  in a chat, Git, application logs, or a query string.
- Open `/bridge.html` in desktop Chrome or Edge. Enter the key, start the relay,
  and connect the device. Connecting alone leaves it in standby. Click
  **允许控制** when ready; **停止并回到待机** revokes the current relay permission.
- Open `/` on the phone for the drawing canvas and direct stop control. This
  panel is separate from the chat page; its private key is stored in that
  browser's local storage, as in upstream. A `#key=` setup link is consumed and
  removed from the address bar. Never publish a setup link.
- Keep the computer awake and the toy within Bluetooth range. Disconnects and
  reconnections return to standby. Software can only request a stop while the
  computer and Bluetooth still function; the device's physical stop remains available.

## Local changes

- MCP percentages are unambiguous: `1` is 1%, not 100%. REST/relay normalized
  values remain unchanged. Zero-intensity drawing/voice has zero output.
- HTTP relay reports must explicitly enable control. Offline/asleep/standby
  relays reject motion; stop remains available. Reconnect discards previous targets.
- Production commands have a 300-second maximum; no indefinite command.
- SOSEXY exposes only Vibrate and Suction, whose GATT endpoints were inspected.
  Electric is not exposed. Physical output and any Pro-specific initialization
  still require an attended hardware test; GATT discovery is not proof of output.
- The container runs as a non-root user with a read-only filesystem, persistent
  `/data`, bounded logs, and a health check. Voice credentials are not configured
  by this Compose file; optional audio services remain outside this setup.

Run `npm ci --ignore-scripts` and `npm test`. Automated tests use simulated devices
and do not establish physical stop or output behavior. Back up the `toy_hub_data`
volume if saved patterns matter. Roll back by stopping this Compose service and
clearing the two Brain variables; do not delete the persistent volume.
