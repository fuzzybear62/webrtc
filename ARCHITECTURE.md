# WebRTC Camera — Architecture & Workflows Index

> Fork of AlexxIT/WebRTC. go2rtc streaming engine. HA custom integration.
> This file is the **authoritative map** of what the code actually does. Consult it
> instead of re-reading the large JS files; **keep it in sync** on every change.
> Anchors (`file:line`) current as of **card v14.2.9 / driver v2.3.6**.

## 1. File map

| File | Lines | Role |
|---|---|---|
| `__init__.py` | 371 | Backend. HTTP views, **`/api/webrtc/ws` proxy**, **two** session registries, go2rtc server mgmt, services (`create_link`, `dash_cast`). |
| `utils.py` | 311 | `websocket_forward` (the blind byte pump), go2rtc binary download/run (`Server`), signed-request validation, lovelace resource registration. |
| `sensor.py` | 93 | **Two** diagnostic sensors: `proxied_connections` = `len(CLIENT_SESSIONS)`, `shadow_probes` = `len(SHADOW_SESSIONS)`. Shared base `_WebRTCSessionSensor`. |
| `media_player.py` | 99 | Chromecast/media_player entity (dash_cast target). Peripheral. |
| `config_flow.py` | 106 | Config entry UI. Peripheral. |
| `www/video-rtc.js` | 1243 | **The driver** (`<video-rtc>`). Dumb, disposable. Owns ONE WebSocket + ONE PeerConnection. MSE/WebRTC/HLS/MJPEG. Runs the **reversible** RTC handoff. |
| `www/webrtc-camera.js` | 1475 | **The card** (`<webrtc-camera>`). Owns driver lifecycle, main+shadow orchestration, retry/upgrade state machine, UI. |
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
- `onclose()` (`:541`): re-entrancy-guarded; closes ws; dispatches `connection-closed` with
  `detail.reason` (v2.3.6) = `'ws-close'` (server/browser close) | `'no-data-watchdog'` (5s silent
  freeze, socket still open) | `'ws-error'` (strict-mode error). `this._closeReason` is set by the
  proactive closers (watchdog `:426`, strict handler `:400`), reset each `onconnect()` and after
  dispatch. The card logs it (server-side debug).
- `ondisconnect()` (`:419`): destructor — closes ws + pc, stops tracks, clears video. Called
  by the card's `_nukeDriver`.
- No-data watchdog (`_feedWatchdog`, 5s): forces `onclose()` if the ws is open but no bytes arrive.
- `strictMode` (`:235`, default `false`) — gates **exactly one** path: the ws `'error'` handler in
  `onconnect()` (`:397`). `true` = fail-fast (call `onclose()` on any ws error); `false` = relaxed
  (log + ignore, keep the socket). Recovery does **not** depend on it: the WHATWG spec guarantees a
  `'close'` after every `'error'` (→ `onclose()` fires ~ms later anyway), and the silent/frozen
  paths this fork targets emit no `'error'` at all (the 5s no-data watchdog reaps them). The
  `onclose()` re-entrancy guard (`_notifiedClosed`) stops the strict early-close + the browser's
  following `'close'` from double-firing `connection-closed`. Set from the card's `network_strict`.

## 4. Card (`webrtc-camera.js`) — the state machine

### Drivers
- `this.driver` = main (visible). `this.shadowDriver` = ephemeral upgrade probe.
- **Each driver = its own ws = its own session.** Both run the reversible RTC phase machine
  (the driver's only RTC path since v2.3.5 — there is no per-driver flag).

### Key state fields
- `_activeMode` : `'mse' | 'rtc' | null` — last **accepted** MAIN transport (advisory cache).
  Written ONLY via `_setActiveMode()` (`:755`, v14.2.6, mirrors the driver's `_setPhase` — logs
  every change). Read in ONE place that matters: the re-probe gate `_attemptReprobe` (`:715`,
  `_activeMode !== 'mse'` stops the loop). Deliberately NOT derived from the driver's `_rtcPhase`:
  `'mse'` covers driver phases `warm` AND `negotiating` (keep probing while the main tries RTC),
  and `'rtc'` is a card-level "quality gate passed / proven shadow swapped in" decision. See the
  `_setActiveMode` docblock + memory `webrtc-fsm-maintainability` smell #3.
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
- Knob propagation (`:848-857`): `rtc_swap_prove_ms`→`RTC_SWAP_PROVE_MS`, `firstframe_timeout`→
  `FIRSTFRAME_TIMEOUT`, `network_strict`→`strictMode`. All set **before** the `isShadowMode` branch,
  so **both main and shadow** inherit them (per-stream override via `effectiveConfig`). Note: on the
  shadow `strictMode` is largely inert — a shadow has no `connection-closed` listener and is reaped
  via firstframe-timeout/reprobe, so it can never touch the live MSE (HARD CONSTRAINT holds).
- Main path: append visible, wire `connection-closed` → retry.
- Shadow path: append **hidden** (`position:absolute; width:1px; opacity:0` `:918-921` — never
  `display:none`, which suspends decode), ws gets `&role=shadow` (`:1098`),
  `this.shadowDriver = newDriver` (`:926`), backstop `_shadowTimeout = FIRSTFRAME_TIMEOUT+5000`
  (~605s) (`:942/961`).

### `onmessage.ui_sync` handler — role-dispatched (`:885`, v14.2.6)
The driver's three signals (`rtc_sustained`/`rtc_failed`/`rtc_rejected`) are **overloaded** — the
same name means opposite things for a background shadow vs the live main. Instead of one handler
disambiguating by branch order + a "never fall through" convention (smell #2), the card now
**hard-dispatches up front** on the RUNTIME predicate `this.shadowDriver === newDriver` (NOT the
frozen `isShadowMode`, so a swapped-in shadow is correctly handled as a main):
```
ui_sync(msg) = (this.shadowDriver === newDriver)
                 ? _onPreSwapShadowMessage(newDriver, msg)   // :461
                 : _onMainMessage(newDriver, msg)            // :508
```
- **`_onPreSwapShadowMessage` (`:461`)** — probe-local signals + errors:
  - `rtc_sustained` → **`_promoteShadowToMain(newDriver)`** (`:468`) — THE swap point.
  - `rtc_failed`/`rtc_rejected` → nuke shadow + reschedule/stop reprobe (no lingering to backstop).
  - `error` → nuke `Failed Shadow` + `shadow-failed` event + reprobe. Everything else swallowed.
- **`_onMainMessage` (`:508`)** — the live main (genuine or swapped-in shadow):
  - `rtc_sustained` → no-op (main already committed via its own flow).
  - `rtc_failed` → `_setActiveMode('mse')` + `_scheduleReprobe()`; `rtc_rejected` → `_stopReprobe()`.
  - non-signal `switch(msg.type)`: `error` (retry only if `!_streamHealthy`), `mse`
    (`_setActiveMode('mse')`), `hls/mp4/mjpeg/webrtc` (mark healthy, reset retry).
  - **Behaviour delta vs ≤v14.2.5**: a post-swap driver emitting `error` now takes THIS main path
    (keep a healthy stream) instead of the old shadow-error path (self-nuke without proper retry).

### `onpcvideo` wrapper (`:906`)
- **Pre-swap shadow PROMOTE is a no-op `return`** (`:911`) — the 2s promote no longer swaps.
- Direct main RTC (main negotiated on its own) → `_setActiveMode('rtc')` (`:937`), etc.

### `_promoteShadowToMain(newDriver)` (`:382`) — the PROVEN swap
Fired only on `rtc_sustained` (RTC held gaplessly ≥ `RTC_SWAP_PROVE_MS`): stop `_shadowTimeout`,
`_nukeDriver(this.driver,'Old Main (MSE)')` (`:390`), promote shadow, re-attach `connection-closed`
(`:405`), `applyAudio` (`:411`), reveal (clear inline styles + `appendChild` `:427`),
`_streamHealthy=true` / `_setActiveMode('rtc')` (`:435-442`), `_stopReprobe()` (`:437`), `setupTools()`,
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

### Field-debug pack (v14.2.7) — status i18n, height-lock, server-side logging
Three additions for diagnosing stream loss on the HA **mobile app**, where there is no browser
console. All off/inert by default — existing cards are byte-for-byte unaffected.

- **Status i18n** — a driver `error` shows the localized generic `_t('reconnecting')` instead of the
  raw string (`_onMainMessage` `error` case). Raw reason kept in `console.error` + the `.mode`
  tooltip. `STRINGS` map (module-level, en/it/de/fr/es) picked by `hass.language`, English fallback;
  `_t(key)`.
- **Height-lock** — the card has no fixed aspect-ratio (height comes from the `<video>`). A retry
  removes the driver → the card would collapse to ~0 → in a **Sections/Masonry** view HA re-packs the
  whole section (ResizeObserver → `grid-row` span), reflowing and disturbing **every sibling
  camera's** stream. `_lockHeight()` (called at the top of `_scheduleRetry`, while the frozen
  `<video>` is still sized) pins `.player { min-height }`; `_unlockHeight()` releases it once a real
  media mode lands (the three healthy points: shared negotiated block, direct-RTC `onpcvideo`,
  `_promoteShadowToMain`). The header is `position:absolute` and never contributed to height — the
  reflow was always the video teardown, never the status text.
- **Server-side logging** — opt-in `debug` card option: `true` (always) | `<entity_id>` e.g.
  `input_boolean.debug` (gated LIVE on that entity `== 'on'`, so one switch toggles the whole fleet)
  | unset/false (off). `_logHA(level,event,detail)` mirrors lifecycle events to the HA log (Settings →
  System → Logs; no on-disk file in modern HA) via `system_log.write` (logger
  `custom_components.webrtc.card` — a DEDICATED sub-logger, so it can be raised to info alone without
  un-muting the backend proxy's chatty handshake/benchmark info logging on `custom_components.webrtc`;
  message `[url] event: detail`),
  **dedup-throttled** (`_logThrottle` Map, 10s window: first emits, repeats counted + flushed once as
  `(repeated N× in 10s)`) so a flapping stream can't flood the log. Events: `driver-error` (W),
  `connection-closed`+reason (W), `retry` (I), `stream-up` (I), `auto-pause`/`auto-resume` (I),
  `page-hidden`/`page-visible` (I — the 5G/backgrounding correlation, from an always-attached,
  emit-self-gated `visibilitychange` listener `_setupDebugVisibilityLog`, torn down + throttle
  cleared in `disconnectedCallback`). The two W events surface in the Logs panel by default; the I
  events need `logger: { logs: { custom_components.webrtc.card: info } }` in `configuration.yaml`.

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
