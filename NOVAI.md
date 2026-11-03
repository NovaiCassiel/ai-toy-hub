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

## ChatGPT OAuth

Set `TOY_HUB_PUBLIC_URL` to the public HTTPS origin (no path), then rebuild this
service. Add `https://<that-host>/mcp` to ChatGPT as a custom MCP server with OAuth.
Dynamic registration is supported; no Hub key or client secret goes into ChatGPT.
The existing Brain and relay bearer keys continue to work unchanged. OAuth mode
disables the legacy `/mcp?key=...` shortcut.

Start the connection in the desktop browser that already holds the relay key.
The consent page uses that locally saved key only after **允许连接** is clicked.
Another browser needs the same private owner key entered on the Hub consent page.
Only an authorization code returns to ChatGPT. The page never hands over the owner
key and never enables Bluetooth control. Local **允许控制** is still required.

- Discovery: `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server`; audience is the exact `/mcp` URL.
- SDK protocol handlers provide public-client registration, authorization-code
  exchange with mandatory S256 PKCE, refresh and revocation. Registration allows
  only the exact ChatGPT callback paths; no arbitrary redirect hosts or client
  credentials grant. Authorization responses include the issuer.
- Tokens are scoped to `toy:read` / `toy:control` and work only at `/mcp`.
  Six bounded tools are exposed; voice, microphone and relay administration are
  excluded. Fixed/pattern commands default to Vibrate and at most 300 seconds.
- Access tokens last one hour. Refresh tokens rotate; reuse revokes the grant.
  An authorization lasts at most 30 days before reconnection is needed.
- Clients and token hashes persist in `/data/oauth.json` (private, atomic writes).
  Preserve this volume across deploys. Rotating the owner key invalidates OAuth
  grants on restart. Storage corruption fails startup instead of dropping grants.
- **ChatGPT 连接管理** in the relay opens `/connections.html`. The owner can revoke
  a connection immediately; this blocks further requests. Use the relay stop
  button to stop an already-running command.

Tests use the official MCP client for discovery, registration, PKCE, refresh and
tool discovery, plus simulated devices for standby and input bounds. A successful
test is not proof of installation in the owner's actual ChatGPT account.

## Local changes

- MCP percentages are unambiguous: `1` is 1%, not 100%. REST/relay normalized
  values remain unchanged. Zero-intensity drawing/voice has zero output.
- HTTP relay reports must explicitly enable control. Offline/asleep/standby
  relays reject motion; stop remains available. Reconnect discards previous targets.
- Production commands have a 300-second maximum; no indefinite command.
- SOSEXY exposes only Vibrate and Suction, whose GATT endpoints were inspected.
  Electric is not exposed. The owner observed output and stop at Vibrate 1% for
  1 second and Suction 5% for 1 second. This does not establish a minimum threshold,
  full-range behavior, or physical-stop behavior during computer/Bluetooth loss.
- The container runs as a non-root user with a read-only filesystem, persistent
  `/data`, bounded logs, and a health check. Voice credentials are not configured
  by this Compose file; optional audio services remain outside this setup.

Run `npm ci --ignore-scripts` and `npm test`. Automated tests use simulated devices
and do not establish physical stop or output behavior. Back up the `toy_hub_data`
volume if saved patterns matter. Roll back by stopping this Compose service and
clearing the two Brain variables; do not delete the persistent volume.
