# WebRTC Camera — Architecture & Workflows Index

> Fork of AlexxIT/WebRTC. go2rtc streaming engine. HA custom integration.
> This file is the **authoritative map** of what the code actually does. Consult it
> instead of re-reading the large JS files; **keep it in sync** on every change.
> Anchors (`file:line`) current as of **card v14.2.5 / driver v2.3.5**.

## 1. File map

| File | Lines | Role |
|---|---|---|
| `__init__.py` | 371 | Backend. HTTP views, **`/api/webrtc/ws` proxy**, **two** session registries, go2rtc server mgmt, services (`create_link`, `dash_cast`). |
| `utils.py` | 311 | `websocket_forward` (the blind byte pump), go2rtc binary download/run (`Server`), signed-request validation, lovelace resource registration. |
| `sensor.py` | 93 | **Two** diagnostic sensors: `proxied_connections` = `len(CLIENT_SESSIONS)`, `shadow_probes` = `len(SHADOW_SESSIONS)`. Shared base `_WebRTCSessionSensor`. |
| `media_player.py` | 99 | Chromecast/media_player entity (dash_cast target). Peripheral. |
| `config_flow.py` | 106 | Config entry UI. Peripheral. |
| `www/video-rtc.js` | 1243 | **The driver** (`<video-rtc>`). Dumb, disposable. Owns ONE WebSocket + ONE PeerConnection. MSE/WebRTC/HLS/MJPEG. Runs the **reversible** RTC handoff. |
| `www/webrtc-camera.js` | 1433 | **The card** (`<webrtc-camera>`). Owns driver lifecycle, main+shadow orchestration, retry/upgrade state machine, UI. |
| `www/ui-interaction.js` | 426 | Sidecar: shortcuts, PTZ buttons, style templates. |
| `www/digital-ptz.js` | 493 | Pinch/pan digital PTZ. |

**Composition, not inheritance** (vs upstream `WebRTCCamera extends VideoRTC`): the card
HOLDS a disposable driver. Every reconnect = hard teardown + recreate (Safari/iOS memory
hygiene). Do NOT "optimize" by reusing the driver — see the card header + memory
`webrtc-card-is-ephemeral-by-design`.

## 2. Backend: the proxy + session accounting (TWO registries)

`WebSocketView` at `/api/webrtc/ws` (`__init__.py:210`, `get()` `:215`). Per browser connection:

1. `is_shadow = request.query.get("role") == "shadow"` (`:223`) → pick registry
   `SHADOW_SESSIONS if is_shadow else CLIENT_SESSIONS` (`:224`).
2. Validate signed request (`?authSig=` JWT, `validate_signed_request`).
3. Open `ws_server` (browser side, `heartbeat=30`); `ws_connect()` builds the upstream
   go2rtc URL and opens `ws_client`.
4. **Register `registry[uuid4] = {client_id, entity_id, client_ip, user_agent, connected_at, expires_at}`** (`:281`) → dispatch `webrtc_sessions_updated` (`:290`).
5. Two `websocket_forward` tasks pump bytes both ways until `FIRST_COMPLETED`.
6. `finally`: cancel tasks, **`registry.pop`** (`:337`), dispatch update (`:340`).

`websocket_forward` (`utils.py:213`) relays TEXT/BINARY/PING/PONG and **breaks on
`WSMsgType.CLOSE`/`ERROR`** so the `finally` runs and the session clears. It is a **blind
forwarder** — it does not inspect frames; the server has **no server-side signal of "RTC
active"** (RTC media is peer↔go2rtc, off-proxy).

`CLIENT_SESSIONS` (`:56`) / `SHADOW_SESSIONS` (`:57`) are module-level dicts.

### What the two sensors count — EXACT semantics
`sensor.py:61` (base) → `count = len(self._registry)`; subclasses bind the registry
(`WebRTCConnectionSensor` → `CLIENT_SESSIONS` `:84`; `WebRTCShadowSensor` → `SHADOW_SESSIONS` `:94`).

> **One session = one live `/api/webrtc/ws` browser→HA WebSocket = one driver `ws`.**
> `proxied_connections` = real viewer ws (MSE warm / ghost). `shadow_probes` = `role=shadow` ws.

| Camera transport state | Main `ws` | Shadow `ws` | proxied / shadow |
|---|---|---|---|
| **MSE** (media over ws) | open | — | 1 / 0 |
| **RTC reversible, uncommitted** (MSE kept warm on the ws) | **open** | — | 1 / 0 |
| **RTC committed** (`RTC_COMMIT_MS`, MSE released + ws closed) | closed | — | 0 / 0 |
| MSE **+ live shadow probe** | open | open | 1 / 1 |
| **swapped-in shadow** (now main, still `role=shadow` ws) | — | open→main | 0 / 1 * |

\* Quirk: a shadow that swaps in keeps its `role=shadow` ws, so the server still counts it
under `shadow_probes` (not `proxied_connections`) until that ws commits/closes. There is **no
RTC-active sensor** — that feature was analysed (client-reported state vs dedicated idle ws)
and **deferred** on 2026-08-09.

## 3. Driver (`video-rtc.js`) — one ws, one pc, REVERSIBLE handoff (explicit phase machine, v2.3.5)

Default `this.mode = 'webrtc,mse,hls,mjpeg'`. The RTC handoff is the driver's **only** RTC path
(the legacy non-reversible branch and the `reversible` flag were removed in v2.3.5). It is an
**explicit 4-state machine** on `this._rtcPhase`, every edge routed through `_setPhase()` (`:979`,
logs the transition):

| `_rtcPhase` | meaning | set at |
|---|---|---|
| `'warm'` | no RTC overlay, MSE only (initial + after revert) | ctor + `_revertToWarmMSE` (`:1014`) |
| `'negotiating'` | overlay decoding, hidden (opacity 0), MSE warm — REVERSIBLE | `_startReversibleRTC` (`:841`) |
| `'promoted'` | overlay revealed, MSE still warm — REVERSIBLE | `promote()` (`:873`) |
| `'committed'` | overlay collapsed onto `this.video`, MSE released, ws closed — IRREVERSIBLE | `commit()` (`:895`) |

Legal edges: `warm→negotiating→promoted→committed`, plus `negotiating/promoted→warm` (revert).
`onpcvideo()` is now a **no-op stub** (`:1058`) the card wraps for its UI update — the reveal,
priority gate, and socket handoff all live in `_startReversibleRTC`/`commit()`.

- `set src` → `onconnect()` (`:382`) opens the ws (bails if `this.ws || this.pc`).
- `onopen()` (`:495`): parses `this.mode`. **MSE and WebRTC start in PARALLEL** — `onmse()`
  and `onwebrtc()` on the same ws.
- `onmse()` (`:601`): binary chunks → SourceBuffer. Keeps last 5s, catch-up playbackRate,
  2MB staging buffer with overflow guard.
- `onwebrtc()` (`:699`): builds `pc`, sends offer over the ws. On `connectionstatechange`
  `connected` → `_startReversibleRTC()` (no legacy branch any more). `failWebRTC` (the shared
  reaper): **if `_rtcVideo && _rtcPhase !== 'committed'` → `_revertToWarmMSE()`** (`:711`); else
  drops only the pc, keeps MSE, emits `rtc_failed`.
- `onpcvideo()` (`:1077`): **no-op stub** — the quality gate + reveal + handoff moved into the
  phase machine below; the card wraps this only for its UI update.
- **`_startReversibleRTC(pc, pcStart, failWebRTC)` (`:824`)** — the whole reversible flow; a poll
  (`_firstFramePoll`, 500ms) drives the phase transitions:
  - enters **`negotiating`** (`:841`): RTC decodes on an **overlaid `_rtcVideo`** (rendered,
    opacity 0), MSE stays warm on `this.video`.
  - **`promote()` (`:858`)** → phase **`promoted`** (`:873`) at `RTC_PROMOTE_MS = 2000` (`:196`):
    the **quality gate** lives here (`rtcPriority` H265/H264+audio vs `msePriority`); if RTC <
    MSE it emits `rtc_rejected` and stays on MSE, else reveal overlay (opacity→1) and call
    `this.onpcvideo(rtcVideo)` for the card's UI.
  - **`rtc_sustained`** at `RTC_SWAP_PROVE_MS = 30000` (`:221`, v2.3.4, was 20000): once RTC has
    decoded **gaplessly** for this window, emit a **one-shot** `ui_sync {signal:'rtc_sustained'}`
    (`:948`, guarded by `_sustainedSignaled`). This is the **shadow-swap gate** (see §4).
  - **first-frame backstop** `FIRSTFRAME_TIMEOUT = 120000` (`:161`, v2.3.4, was 600000): a pc
    `connected` but decoding no frame is reaped after this and reverts to warm MSE.
  - Both knobs overridable per-card via YAML `rtc_swap_prove_ms` / `firstframe_timeout` (ms),
    injected in the card's `startStream()` (`webrtc-camera.js:680-683`).
  - **`commit()` (`:902`)** → phase **`committed`** (`:895`) at `RTC_COMMIT_MS = 180000` (`:206`):
    path proven; collapse overlay onto `this.video`, release MSE, close ws. **Only irreversible
    edge.** Any decode gap > `RTC_STALL_RESET` pushes `_stableSince` forward, so bursty cams
    never commit.
- `_revertToWarmMSE(why)` (`:1018`): drop the overlay (MSE already on screen), phase → **`warm`**,
  emit `ui_sync {signal:'rtc_failed'}`. No black frame.
- `_setPhase(next)` (`:979`): the single phase-transition point; logs every edge.
- `applyAudio(muted)`: routes mute to the on-screen element (RTC overlay while promoted, else
  `this.video`). Called by the card after a swap.
- `onclose()` (`:541`): re-entrancy-guarded; closes ws; dispatches `connection-closed`.
- `ondisconnect()` (`:419`): destructor — closes ws + pc, stops tracks, clears video. Called
  by the card's `_nukeDriver`.
- No-data watchdog (`_feedWatchdog`, 5s): forces `onclose()` if the ws is open but no bytes arrive.

## 4. Card (`webrtc-camera.js`) — the state machine

### Drivers
- `this.driver` = main (visible). `this.shadowDriver` = ephemeral upgrade probe.
- **Each driver = its own ws = its own session.** Both run the reversible RTC phase machine
  (the driver's only RTC path since v2.3.5 — there is no per-driver flag).

### Key state fields
- `_activeMode` : `'mse' | 'rtc' | null` — last negotiated MAIN transport.
- `_isReconnecting`, `_retryCount`, `_retryTimer` — cold-restart backoff.
- `_streamHealthy` — a media mode came up (distinguishes fatal vs per-mode error).
- `_shadowAttempts` (`:85`) — fast-upgrade counter.
- `_upgradeTimer` (`:91`) — the fast 2s shadow after MSE lands (defensively kept).
- `_reprobeTimer`/`_reprobeDelay` — the periodic re-probe loop (30s→…→600s).
- `_shadowTimeout` — backstop watchdog on an in-flight shadow.
- `_paused` — auto-pause (off-screen/hidden) teardown.

### `startStream()` (`:621`)
- `isShadowMode = !!this.driver && !this._isReconnecting` (`:634`).
- `effectiveConfig = {...config, ...currentStream}`; `newDriver.mode = effectiveConfig.mode`
  (`:674`). (No `reversible` flag any more — the driver's only RTC path is reversible.)
- Main path: append visible, wire `connection-closed` → retry.
- Shadow path: append **hidden** (`position:absolute; width:1px; opacity:0` `:918-921` — never
  `display:none`, which suspends decode), ws gets `&role=shadow` (`:1098`),
  `this.shadowDriver = newDriver` (`:926`), backstop `_shadowTimeout = FIRSTFRAME_TIMEOUT+5000`
  (~605s) (`:942/961`).

### `onmessage.ui_sync` handler (`:695`)
Signal frames (`msg.type === 'signal'`):
- **Pre-swap shadow** (`isShadowMode && shadowDriver === newDriver`, `:705`):
  - `rtc_sustained` → **`_promoteShadowToMain(newDriver)`** (`:711`) — THE swap point.
  - `rtc_failed`/`rtc_rejected` → **nuke shadow + reschedule/stop reprobe** (`:718`) (no lingering
    to the backstop). Everything else swallowed.
- Non-shadow `rtc_sustained` → no-op (`:730`) (main already committed via its own flow).
- Main `rtc_failed` → `_activeMode='mse'` + `_scheduleReprobe()`; `rtc_rejected` → `_stopReprobe()`.

### `onpcvideo` wrapper
- **Pre-swap shadow PROMOTE is a no-op `return`** (`:873`) — the 2s promote no longer swaps.
- Direct main RTC (main negotiated on its own) → `_activeMode='rtc'` (`:895`), etc.

### `_promoteShadowToMain(newDriver)` (`:368`) — the PROVEN swap
Fired only on `rtc_sustained` (RTC held gaplessly ≥ `RTC_SWAP_PROVE_MS`): stop `_shadowTimeout`,
`_nukeDriver(this.driver,'Old Main (MSE)')` (`:382`), promote shadow, re-attach `connection-closed`
(`:397`), `applyAudio` (`:404`), reveal (clear inline styles + `appendChild` `:419`),
`_streamHealthy=true` / `_activeMode='rtc'` (`:427-428`), `_stopReprobe()` (`:429`), `setupTools()`,
dispatch `handover-complete` (`:436`).

### Three MSE→WebRTC upgrade mechanisms (coexist)
1. **Main's own parallel WebRTC** — `onwebrtc()` alongside MSE on the main's ws; on success the
   main goes RTC in place (reversible). Empirically slower/less reliable than a dedicated shadow.
2. **Fast 2s shadow** (`_upgradeTimer`, `case 'mse'` `:806`) — a shadow driver shortly after MSE
   lands. Reliable fast path.
3. **Periodic re-probe loop** (`_scheduleReprobe` `:548` / `_attemptReprobe` `:568` /
   `_stopReprobe` `:585`, backoff 30s→…→600s) — a stream settled on MSE retries the shadow later
   when the network recovers. The fork's core resilience. `_attemptReprobe` bails if paused,
   reconnecting, or a shadow is already running (`:574-575`).

### Teardown paths (all funnel through `_nukeDriver` (`:441`) → `ondisconnect()` → `ws.close()`)
`_cleanupDriver`, `_scheduleRetry`, `hardReset`, `_pauseStream`, `disconnectedCallback`, `nextStream`.

## 5. Counter behaviour, fully explained

- **MSE / RTC-reversible-uncommitted camera → `proxied_connections` 1** (ws open, MSE warm).
  **RTC committed → 0** (ws closed). **+1 `shadow_probes`** per live probe.
- A camera **stuck on MSE** + the re-probe loop ⇒ a shadow ws lives ~15s of every 30–60s ⇒
  `shadow_probes` **oscillates 0↔1** for that camera. This is a **real second proxy ws**
  (the probe), not a miscount. See memory `webrtc-session-counter-model`.
- Since v14.2.3 the swap is **prove-gated** (§4): the shadow only swaps in after `rtc_sustained`
  (~20s gapless), so on throttled paths it never swaps — no black tile, no swap/revert churn,
  and the reprobe backoff escalates normally (memory `webrtc-shadow-is-the-upgrade-path`).

## 6. Regression log (things proven wrong on hardware)

- **v14.1.10** removed the fast 2s shadow assuming mechanism 1 covered it. **Reverted (v14.1.11):**
  cameras reached RTC slower AND the counter still showed +1 (it was the **re-probe** shadow).
- **v14.2.1** shadow-swap was still irreversible → a swapped-in shadow froze black on a later RTC
  stall. **v14.2.2:** every driver reversible + `applyAudio`.
- **v14.2.2** swapped the shadow in at its 2s PROMOTE → on throttled paths it nuked a healthy MSE
  main for a replacement that stalled seconds later (black tile) and reset the reprobe backoff on
  each swap (proxy/shadow stuck at 2). **v14.2.3:** prove-gated swap (`rtc_sustained` @ ~20s).
- Lesson: promotion proves RTC can START, not SUSTAIN; and `pc.connected` ≠ media flowing —
  first-frame/gapless decode is the only success signal (memory `webrtc-connected-is-false-positive`).

## 7. History: the counter split (already implemented)

The old single `SESSIONS` counted probes and viewers together (the field "+1"). The surgical fix
described in earlier revisions of this doc — **tag the shadow ws and count it separately** — is
now the shipped design: `role=shadow` → `SHADOW_SESSIONS` → `shadow_probes` sensor, viewers →
`CLIENT_SESSIONS` → `proxied_connections`. A distinct **RTC-active** sensor remains **deferred**
(no reliable server-side signal; would need client-reported state or a dedicated idle ws).
