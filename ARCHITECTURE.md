# WebRTC Camera — Architecture & Workflows Index

> Fork of AlexxIT/WebRTC. go2rtc streaming engine. HA custom integration.
> This file is the authoritative map of **what the code actually does**. Written
> after a full read of the core path (backend + driver + card). Keep it in sync.

## 1. File map

| File | Lines | Role |
|---|---|---|
| `__init__.py` | 360 | Backend. HTTP views, **`/api/webrtc/ws` proxy**, `SESSIONS` registry, go2rtc server mgmt, services (`create_link`, `dash_cast`). |
| `utils.py` | 311 | `websocket_forward` (the byte pump), go2rtc binary download/run (`Server`), signed-request validation, lovelace resource registration. |
| `sensor.py` | 77 | The `proxied_connections` sensor = **`len(SESSIONS)`** + per-session detail attributes. |
| `media_player.py` | 99 | Chromecast/media_player entity (dash_cast target). Peripheral to streaming. |
| `config_flow.py` | 106 | Config entry UI. Peripheral. |
| `www/video-rtc.js` | 710 | **The driver** (`<video-rtc>`). Dumb, disposable. Owns ONE WebSocket + ONE PeerConnection. Negotiates MSE/WebRTC/HLS/MJPEG/MP4. |
| `www/webrtc-camera.js` | 1345 | **The card** (`<webrtc-camera>`). Owns driver lifecycle, main+shadow orchestration, retry/upgrade state machine, UI. |
| `www/ui-interaction.js` | 426 | Sidecar: shortcuts, PTZ buttons, style templates. |
| `www/digital-ptz.js` | 493 | Pinch/pan digital PTZ. |

**Composition, not inheritance** (vs upstream `WebRTCCamera extends VideoRTC`): the card
HOLDS a disposable driver. Every reconnect = hard teardown + recreate (Safari/iOS
memory hygiene). "Do NOT optimize by reusing the driver" — see header comment.

## 2. Backend: the proxy + session accounting (THE COUNTER)

`WebSocketView` at `/api/webrtc/ws` (`__init__.py:206`). Per browser connection:

1. Validate signed request (`?authSig=` JWT, `validate_signed_request`).
2. Open `ws_server` (browser side), `heartbeat=30`.
3. `ws_connect()` builds the upstream go2rtc URL `ws://…/api/ws?src=…` and opens `ws_client`.
4. **Register `SESSIONS[uuid4] = {client_id, entity_id, client_ip, user_agent, connected_at, expires_at}`** → dispatch `webrtc_sessions_updated`.
5. Two `websocket_forward` tasks pump bytes both ways until `FIRST_COMPLETED`.
6. `finally`: cancel tasks, **`SESSIONS.pop`**, dispatch update.

`websocket_forward` (`utils.py:213`) relays TEXT/BINARY/PING/PONG and **breaks on `WSMsgType.CLOSE`/`ERROR`** so the `finally` runs and the session clears.

### What the sensor counts — EXACT semantics
`sensor.py:61` → `count = len(SESSIONS)`.

> **One SESSION = one live `/api/webrtc/ws` browser→HA WebSocket = one driver instance's `ws`.**
> NOT per-camera. NOT per-go2rtc-consumer. NOT per-transport.

Consequence, per transport outcome:

| Camera transport state | Driver `ws` | SESSIONS footprint |
|---|---|---|
| **MSE** (media streams over the ws as binary) | **open** | **1** |
| **WebRTC** (media over PeerConnection, ws was signaling only) | **closed on handoff** (`onpcvideo` → `ws.close()`) | **0** |
| MSE **+ a live shadow probe** | main open + shadow open | **2** (while the probe lives) |
| mid-negotiation (before any handoff) | open | 1 |

**A camera on RTC contributes 0 to the counter** (its signaling ws was handed off; media
is peer↔go2rtc, off-proxy). **A camera on MSE contributes 1.** Each **live shadow
probe adds 1** for its lifetime.

## 3. Driver (`video-rtc.js`) — one ws, one pc

- `set src` → `onconnect()` opens the ws (`onconnect` bails if `this.ws || this.pc` already set).
- `onopen()` (`:294`): parses `this.mode`. **MSE and WebRTC are started in PARALLEL** on the
  same ws — `if mode.includes('mse') → onmse()` **and** a separate `if mode.includes('webrtc') → onwebrtc()`.
- `onmse()` (`:400`): binary chunks → SourceBuffer. Keeps last 5s, catch-up playbackRate. 2MB staging buffer with overflow guard.
- `onwebrtc()` (`:498`): builds `pc`, sends offer over the ws. On `connectionstatechange`:
  - `connected` → probe tracks in a temp `<video>`; on `loadeddata` → `onpcvideo()`.
  - `failed`/`disconnected` → **if MSE still live (ws open + mseCodecs): drop ONLY pc, keep MSE, emit `rtc_failed`** (v2.2.14 #6). Else full `onclose()` (retry).
- `onpcvideo(video2)` (`:598`): quality gate. `rtcPriority` (H265=0x240/H264=0x220 + audio) vs `msePriority` (from `mseCodecs`).
  - `rtcPriority >= msePriority` → **SWITCH**: `video.srcObject = stream`, then **`handoff=true; ws.close()`** → session drops. Media now over pc.
  - else → **REJECT**: emit `rtc_rejected`, close pc, keep MSE.
- `onclose()` (`:360`): re-entrancy-guarded; closes ws; dispatches `connection-closed` (unless `handoff`).
- `ondisconnect()` (`:255`): the destructor — closes ws + pc, stops tracks, clears video. Called by the card's `_nukeDriver`.
- No-data watchdog (`_feedWatchdog`, 5s): forces `onclose()` if the ws is open but no bytes arrive (frozen MSE / black-hole).

## 4. Card (`webrtc-camera.js`) — the state machine

### Drivers
- `this.driver` = main (visible). `this.shadowDriver` = ephemeral webrtc-only upgrade probe.
- **Each driver = its own ws = its own SESSION.**

### Key state fields
- `_activeMode` : `'mse' | 'rtc' | null` — last negotiated MAIN transport.
- `_isReconnecting`, `_retryCount`, `_retryTimer` — cold-restart backoff (1s→30s).
- `_streamHealthy` — a media mode came up (distinguishes fatal vs per-mode error).
- `_shadowAttempts` — counter for the fast 2s upgrade path (gate `< 2`).
- `_upgradeTimer` — the fast **2s shadow** after MSE lands.
- `_reprobeTimer`/`_reprobeDelay` — the **periodic re-probe loop** (30s→…→600s).
- `_paused` — auto-pause (off-screen/hidden) teardown.

### Three MSE→WebRTC upgrade mechanisms (they coexist)
1. **Main's own parallel WebRTC** — `onopen` runs `onwebrtc()` alongside MSE on the main's
   ws. On success → `onpcvideo` SWITCH on the main → main `ws.close()` (handoff). Main goes
   RTC **in place**, its session drops. *(No extra ws. But empirically slower / less reliable
   than a dedicated webrtc-only driver — do not assume it replaces the shadow.)*
2. **Fast 2s shadow** (`_upgradeTimer`, `case 'mse'` `:688`) — 2s after MSE lands, launch a
   webrtc-only shadow driver. **This is the reliable fast upgrade path** (proven on a
   14-camera fleet). Removing it slows upgrades — see §6.
3. **Periodic re-probe loop** (`_scheduleReprobe`/`_attemptReprobe` `:456`) — for a stream
   settled on MSE, retry the shadow on backoff 30s→60s→…→600s. **The fork's core
   resilience**: a stream stuck on MSE (UDP blocked / TURN down at connect) still upgrades
   minutes later when the network recovers. Armed on `case 'mse'` and on `rtc_failed`;
   stopped on any RTC success and on `rtc_rejected`.

### Shadow lifecycle (`startStream`, `isShadowMode = !!this.driver && !this._isReconnecting`)
- Shadow forced to `mode='webrtc'` (`:574`); own unique `client_id`; attached **hidden**
  (1px/opacity0/absolute — never `display:none`, which would suspend decoding).
- Own ws → **own SESSION (this is the +1 while it probes).**
- Resolves via one of:
  - **SWAP** (`onpcvideo`, `isShadowMode`, `:743`): shadow got WebRTC → nuke old main (MSE),
    promote shadow to main, reveal it, `_activeMode='rtc'`, `_stopReprobe()`. Both old
    sessions drop; the promoted driver has no ws (handoff) → camera → 0 sessions.
  - **15s watchdog** (`_shadowTimeout`, `:863`): not promoted in 15s → nuke, re-arm re-probe.
  - **error / auth-fail** (`:637`, `:942`): nuke, re-arm re-probe.
  - **orphan cleanup** (direct-upgrade branch `:818`): main upgraded on its own while a shadow
    was in flight → nuke the now-pointless shadow.

### Teardown paths (all funnel through `_nukeDriver` → `driver.ondisconnect()` → `ws.close()`)
`_cleanupDriver` (both drivers), `_scheduleRetry`, `hardReset`, `_pauseStream`,
`disconnectedCallback`, `nextStream`.

## 5. The counter behaviour, fully explained

- **RTC camera → 0 sessions** (ws handed off). **MSE camera → 1.** **+1 per live shadow.**
- A camera **stuck on MSE** (WebRTC never succeeds) + the **re-probe loop** ⇒ a shadow ws is
  alive ~15s out of every 30–60s ⇒ the counter **oscillates 1↔2** for that camera, looking
  like a stuck "+1". This is the `+1` observed in the field — it is a **real second proxy
  websocket** (the probe), not a miscount.
- Multiple distinct cameras each on MSE ⇒ counter = number of MSE cameras (each a distinct
  `session_id`/`entity_id`, as seen in the live `sessions` attribute).

## 6. Regression log (things proven wrong on hardware)

- **v14.1.10** removed the fast 2s shadow (mechanism 2) assuming it was redundant with
  mechanism 1. **Reverted (v14.1.11):** cameras reached RTC **slower** (mechanism 1 is not a
  reliable substitute) AND the counter still showed the +1 (it was the **re-probe** shadow,
  mechanism 3, not the 2s shadow). Both premises were false.
- Lesson: the shadow (a dedicated webrtc-only driver) is the reliable upgrade path. The
  counter's `+1` is intrinsic to any shadow that opens its **own** proxy ws.

## 7. Where to intervene for "a probe should not inflate the counter"

The counter is correct *by its definition* (proxy websockets). To make it mean "real viewer
streams" without weakening the upgrade machinery, the surgical fix is to **tag the shadow's
ws as a probe and exclude it from `SESSIONS`** (backend registers probes in a separate bucket
/ with a `probe: true` flag the sensor filters out). The shadow keeps working identically;
only the accounting changes. Alternative (bigger, riskier): re-probe by replaying the main
driver's `onwebrtc()` on its live ws so no second ws exists at all.
