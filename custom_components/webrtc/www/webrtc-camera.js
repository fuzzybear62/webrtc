/*!
 * Copyright (c) 2023 Alexey Khit (https://github.com/AlexxIT/WebRTC)
 * Copyright (c) 2026 fuzzybear62 (https://github.com/fuzzybear62/webrtc)
 * Derived from AlexxIT/WebRTC. Licensed under the MIT License — see LICENSE.
 */
/**
 * WebRTC Camera Card v14.1.0
 *
 * DESIGN PHILOSOPHY
 * -----------------
 * This card is intentionally built around an EPHEMERAL driver model.
 *
 * The VideoRTC element is treated as disposable state, never as a long-lived object.
 * Every reconnect, stream switch, page navigation or failure results in a full teardown
 * and recreation of the driver.
 *
 * WHY:
 * - Browsers (especially Safari / iOS) are extremely sensitive to lingering references
 * involving <video>, MediaSource, RTCPeerConnection and WebSocket objects.
 * - Previous legacy implementations reused drivers and connections to optimize latency,
 * but this caused steady and irreversible browser memory growth.
 *
 * This implementation deliberately trades reconnect cost for long-term memory stability.
 * Any attempt to "optimize" by reusing the driver will almost certainly reintroduce leaks.
 *
 * CHANGELOG
 * ---------
 * v14.6.18 — [DRIVER CHANGE, pin ?v=2.12.0 → 2.12.1 — needs a PWA hard reload] Alg.4.1: fix the LAN
 *   regression. The v2.12.0 band primitive (bufferbloat INFLATION = rttEwma / session-min RTT) is scale-
 *   free and EXPLODES at a tiny LAN baseline (min 2-3ms): a few ms of harmless jitter (2ms→7ms) fabricated
 *   infl 3-4×, so the network dot flickered through all colours on every camera and the continuous abort
 *   severity accrued to a false RTC abort across the whole 0%-loss grid, in a loop ("su lan sempre peggio").
 *   Driver v2.12.1 swaps the ratio for the ABSOLUTE standing-queue EXCESS = rttEwma − session-min RTT (ms):
 *   scale-correct (5ms of queue is 5ms → LAN stays green/perf, no abort) while still relative (subtracts the
 *   link's own floor → a real 4G runaway of hundreds of ms still aborts, ~before it storms HA). Card side:
 *   only the metrics token changed (`infl=` → `exc=Nms`); the dot still parses `band=`, so no card logic
 *   change. See webrtc-mobile-collapse-is-rtc-additive memory.
 * v14.6.17 — [DRIVER CHANGE, pin ?v=2.11.0 → 2.12.0 — needs a PWA hard reload] Alg.4: self-calibrating
 *   band + network-state dot. The 20:36 direct-4G log was a "disastro" (lost the HA connection): Alg.2
 *   SERIAL held (only the canary ramped, no cascade — a real win over the 19:37 storm) but the SINGLE
 *   canary still stormed the weak uplink to rtt 3546ms because Alg.3 aborted ~15s late — the canary
 *   never promoted, band sat at 'degr' (rtt 1147ms = 5.7× its floor, loss 15%) accruing NOTHING for
 *   ~10s, flipping to 'path' only once rtt had already run away. Root cause: the band used ABSOLUTE RTT
 *   ceilings, which are both too lenient to catch a bad path early AND wrong for a non-deterministic 4G
 *   (the same link held 4 RTC in another test). Driver v2.12.0 replaces them with a RELATIVE bufferbloat
 *   INFLATION signal (rttEwma / session-min RTT) feeding a CONTINUOUS abort severity — no 'degr' dead-
 *   zone, a runaway gives up in ~2s, and an in-form 4G (infl≈1) now OPENS the gate instead of being
 *   mislabelled degr. Card adds an opt-in `network_indicator: true` dot: white = no fresh sample,
 *   green = perf, yellow = degr, red = path (parsed off the metrics `band=` token). See
 *   webrtc-mobile-collapse-is-rtc-additive memory.
 * v14.6.16 — [DRIVER CHANGE, pin ?v=2.10.0 → 2.11.0 — needs a PWA hard reload] Alg.2 goes band-adaptive.
 *   The serializer no longer holds cameras in a queue on a fat pipe: it uses the FIRST probe as a canary and
 *   serializes ramps only until that probe's Alg.1 band verdict lands (~2s). band=perf → OPEN the gate (no
 *   storm possible on wideband/LAN → drain the queue, ramp every camera in PARALLEL, zero serialization
 *   cost); band=path → stay/return to SERIAL (constrained link → one ramp at a time, storm prevented);
 *   band=degr/'' → unchanged (cautious). Fixes the ~8s/camera convergence penalty the v14.6.15 LAN log
 *   showed (only the first camera reached RTC in a 7s session) while keeping the 4G storm guard intact.
 *   The band is a property of the shared uplink, so one canary verdict generalizes; a later path report
 *   re-arms serialization. Purely driver-side (in _rtcProbeGate); no card wiring, no YAML knob.
 * v14.6.15 — [DRIVER CHANGE, pin ?v=2.9.0 → 2.10.0 — needs a PWA hard reload] Alg.2, cross-grid RTC probe
 *   serializer. One module-level single-flight gate in the driver (_rtcProbeGate), shared by every VideoRTC
 *   on the page — each card's main driver AND its background shadow — so at most ONE RTC probe is ramping at
 *   a time. This is the fix for the simultaneous-ramp "bufferbloat storm": N cameras promoting RTC at once
 *   each fire an uncoordinated GCC bitrate ramp, and on one constrained 4G uplink the N ramps overshoot
 *   together → a grid-wide RTT balloon (Alg.3 then aborts them all in a cascade). Serializing bounds the
 *   double-load peak to MSE(all)+RTC(one) instead of MSE(all)+RTC(N). The token is held from the offer until
 *   the earliest of: promote-settle (~8s gapless, GCC plateaued — the next camera ramps without waiting the
 *   full 180s commit), warm/committed, any failWebRTC path, or a 20s lease backstop. MSE keeps flowing while
 *   a camera waits its turn, so queueing adds ZERO extra load. Purely in the driver — no card wiring — but
 *   the pin bump forces the new driver to load. See webrtc-mobile-collapse-is-rtc-additive memory.
 * v14.6.14 — [DRIVER CHANGE, pin ?v=2.8.0 → 2.9.0 — needs a PWA hard reload] Alg.3, class-driven RTC abort
 *   (the first DECISION to consume the Alg.1 band verdict). The driver retires the v2.7.0 blind abort, which
 *   keyed on absolute jbuf/RTT ceilings and was therefore blind to the pure-LOSS pathology the 2026-08-26
 *   direct-4G logs exposed (esternacancello: RTT pinned 107ms, loss 10-29% — healthy by every ceiling, stream
 *   unusable). Abort now integrates the loss-aware band verdict through a leaky ASYMMETRIC accumulator: each
 *   500ms poll adds time while `band=path`, HOLDS on `band=degr`, and bleeds (slower) while `band=perf`;
 *   reverting to the warm MSE once the integral crosses `mse_abort_hold` (shortened by futility). The
 *   accumulator gives an intrinsic stability window that absorbs verdict flapping and the optimistic opening
 *   verdict. NO-DEAD-CODE: the retired ceilings and their knobs (`mse_abort_jbuf`/`mse_abort_rtt`) are deleted
 *   here and in the driver; surviving knobs `mse_abort` (false = extend-only) and `mse_abort_hold`/
 *   `mse_abort_futility_k`. No card-UI behaviour change.
 * v14.6.13 — [DRIVER CHANGE, pin ?v=2.7.1 → 2.8.0 — needs a PWA hard reload] Alg.1, early band classifier
 *   (first step of the self-configuring rework: parameters like `mse_timeout` must NOT be a user's job, and
 *   one card must work on both 4G and wide-band). Field analysis (2026-08-26) established that the driver's
 *   instrumentation already tells a PERFORMANT link from a non-performant one within ~2s of a probe. The
 *   driver now folds the per-poll RTT + short-window loss ALREADY harvested for the metrics line into a live
 *   verdict — 'perf' | 'degr' | 'path' — surfaced as `band=` on the metrics line. OBSERVE-ONLY: no stream
 *   decision keys on it yet — this ships the instrument so its thresholds can be validated against real
 *   4G/LAN logs BEFORE Alg.2 (serialized ramp) and Alg.3 (class-driven commit) consume it; at that point the
 *   blind step-3 abort it supersedes is removed. No new YAML knobs (thresholds stay internal, by design). No
 *   card behaviour change.
 * v14.6.12 — [DRIVER CHANGE, pin ?v=2.7.0 → 2.7.1 — needs a PWA hard reload] Observability. The driver's
 *   RTC revert now carries its REASON on the `rtc_failed` signal (`detail`); the card mirrors it to the HA
 *   log as `rtc-revert: <why>`. Field logs previously showed every revert — a step-3 abort, a stall, a
 *   firstframe timeout, an ICE drop — as an identical bare `mode: rtc -> mse`, so we could not confirm from
 *   HA logs whether/why an abort fired (the reason was client-console only). Now `rtc-revert` self-identifies
 *   (e.g. "RTC aborted: pathological path (rtt=…, jbuf=… sustained)"), on both the main and shadow paths.
 *   Name-keyed throttle: first revert lands live, a burst collapses to "(repeated N×)" — flood-safe under
 *   the red/green ping-pong storm. No behaviour change; diagnosis only.
 * v14.6.11 — [DRIVER CHANGE, pin ?v=2.6.0 → 2.7.0 — needs a PWA hard reload] Two changes.
 *   (1) [Strato-1 step 3] RTC ABORT propagation. The v2.7.0 driver gives up a non-committing RTC probe
 *   that holds a pathological jitter-buffer/RTT reading (measured cause of the direct-4G collapse =
 *   bufferbloat: jbuf 1500-2100ms, RTT standing ~1.5s, pkt sub-MTU, path srflx/…/udp), reverting to the
 *   warm MSE in a deterministic ~6-9s instead of letting the adaptive watchdog balloon to 30×. The
 *   revert emits the existing `rtc_failed`, so the card's backed-off re-probe loop is the suppression —
 *   no new signal. New per-card knobs (parametric, defaults sane): `mse_abort` (false = classic
 *   extend-only), `mse_abort_jbuf` (1200 ms), `mse_abort_rtt` (5000 ms), `mse_abort_hold` (6000 ms),
 *   `mse_abort_futility_k` (0.5 — a repeatedly-doomed path gives up faster). The driver also fixed the
 *   futility inversion (futility now shortens the abort hold, no longer lengthens the extend).
 *   (2) [FIX] `url_fullscreen` never actually switched to hi-res on ANY platform. The signed WS URL in
 *   _fetchWebsocketURL — the stream the driver really dials — was built without `_fsStreamOverride`, so
 *   the card-path fullscreen swap reached only mode/ice/tunables while the connect URL stayed on the
 *   substream. Now the override is spread into that URL too, so entering fullscreen streams
 *   `url_fullscreen` (desktop / Android PWA). The iOS webkit path still shows the substream (fullscreen
 *   is bound to the <video>; documented limitation, unchanged).
 * v14.6.10 — [DRIVER CHANGE, pin ?v=2.5.0 → 2.6.0 — needs a PWA hard reload] Transport diagnostics.
 *   No behaviour change: the driver `metrics` line now also carries `jbuf`/`nack`/`pkt`/`path` from
 *   the same getStats poll, to settle bufferbloat-vs-fragmentation on the direct-4G path (the
 *   2026-08-26 direct run collapsed to 20s RTT and dropped HA; the SAME grid over a Cloudflare tunnel
 *   rode a transient storm and converged). `path` = selected candidate-pair type+protocol
 *   (srflx/relay/host, udp/tcp) — tests "UDP-to-TURN vs TCP-over-CF" directly; `jbuf` = avg
 *   jitter-buffer delay (bufferbloat tell); `nack` = retransmit requests (loss/frag tell); `pkt` =
 *   avg received packet size (MTU tell). This lands BEFORE Strato-1 step 3 so the abort trigger is
 *   tuned on measured cause, not on the saturating `cong`.
 * v14.6.9 — [DRIVER CHANGE, pin ?v=2.4.6 → 2.5.0 — needs a PWA hard reload] Strato-1: the MSE
 *   no-data watchdog now SELF-ADAPTS. The driver derives a smoothed `congestion` score (rttExcess =
 *   rtt − session-min-rtt, i.e. bufferbloat, reinforced by loss and by recent RTC-promote futility)
 *   and EXTENDS the effective watchdog up to `mse_adapt_max_extend`× the base — never below it — but
 *   only while an un-committed RTC probe is starving the warm MSE (negotiating/promoted). 'warm' /
 *   'committed' keep the tight base, so a dead MSE-only stream is still reaped promptly. This makes
 *   the high/low-band paths diverge from identical code (the substream keeps the base; the main
 *   earns the extension) so the user no longer sets per-card timeouts by hand. Field-validated: the
 *   mse_timeout:0 run proved the socket survives a 21s-rttExcess storm and converges to clean RTC —
 *   the fixed 5s watchdog was the reconnect storm, not the cure. New per-card knobs (all optional,
 *   defaults sane): `mse_adaptive` (false = classic fixed), `mse_adapt_rtt_excess`, `mse_adapt_loss`,
 *   `mse_adapt_max_extend`, `mse_adapt_alpha`. `mse_timeout` remains the base/escape-hatch. The
 *   driver `metrics` line now ends with `cong=N.NN`.
 * v14.6.8 — [card-only, no driver change] Lever B: `url_fullscreen` — a per-card hi-res stream
 *   shown ONLY in fullscreen, so the grid tile can run the light substream while fullscreen gets
 *   the full-resolution main. On the card-fullscreen path (desktop / Android PWA) entering
 *   fullscreen cold-restarts the driver onto `url_fullscreen` and exiting reverts to the configured
 *   substream — fullscreen lives on the .card container, not the <video>, so the inner driver can
 *   be swapped without leaving fullscreen. The iOS webkit path (fullscreen bound to the <video>)
 *   keeps the substream upscaled — a swap there would drop out of fullscreen. Example:
 *   `url: cam_sub` + `url_fullscreen: cam`. No driver change (pin stays ?v=2.4.6).
 * v14.6.7 — [card-only, no driver change] New per-card tunable `mse_timeout` (ms): exposes the
 *   driver's MSE no-data watchdog (`DISCONNECT_TIMEOUT`, default 5000) as YAML config. The watchdog
 *   is fed by binary WS bytes = MSE liveness only, so it governs how long a stalled MSE stream is
 *   tolerated before a teardown+cold-restart. On lossy 4G the 5s default false-fires on transient
 *   TCP stalls that would self-recover, turning a recoverable pause into a reconnect storm; raising
 *   it (e.g. 12000) lets mobile links ride out stalls. `0` EXPLICITLY disables the watchdog. Read
 *   live in the driver, so per-card changes take effect on a card reload — no driver pin bump / PWA
 *   hard reload. Default unchanged (driver still 5000); set it per-camera. Complements the config
 *   cure (multi-cam grid on /stream2 substream) and v14.6.6 anti-lockstep backoff.
 * v14.6.6 — [card-only, no driver change] Anti-lockstep retry backoff. Cameras mounted together
 *   die together on a congested link; the old deterministic backoff (1000*2^n, capped 30s, no
 *   jitter) made all of them re-fire at the identical instant -> simultaneous keyframe bursts ->
 *   the congestion spike recurred -> self-synchronizing collapse that never broke on its own
 *   (observed: 4x MSE-only on weak 4G, all four flapping in step every 5-7s). _scheduleRetry now
 *   floors the delay at 2s (breathing room instead of a 1s hammer) and spreads it across 60-140%
 *   of the target via jitter so the fleet de-syncs after the first collision. The exponential is
 *   capped at 20s BELOW the 30s hard ceiling so jitter keeps room to spread near the top (a cap
 *   applied after jitter would re-collapse every camera onto exactly 30000). Complements the
 *   config-side cure (multi-cam grid on the camera substream) which addresses the raw bandwidth.
 * v14.6.5 — [driver-only fixes, pin ?v=2.4.5 → 2.4.6] (1) MSE strand recovery: a frozen MSE
 *   stream that only started after pressing pause+play — the 5s buffer eviction could strand
 *   currentTime below the buffered window (late initial autoplay, or a stall behind an evicted
 *   region) and the element waited forever for removed data. onmse now seeks to the live edge once
 *   on that condition. (2) No-data watchdog reverted to always 5s: the v2.4.3 phase-aware 2.5s
 *   shortening false-fired on bursty-but-alive MSE over congested 4G and tore down the working MSE
 *   (retry storm), and starved the A0 severity gate; 5s lets 4×MSE settle. No card logic changed —
 *   version bump + pin only.
 * v14.6.4 — [mute fix] Same on-screen-element root cause as v14.6.3: the volume button set
 *   `this.video.muted` directly, so during a promoted RTC stream it muted the hidden MSE while the
 *   audible overlay `_rtcVideo` kept its sound, and the next handoff transition overwrote the
 *   choice. Now routed through the driver's new `setMuted()` (v2.4.5), which mutes the on-screen
 *   element AND records `_mseWanted` so promote/commit/revert restore the intended state. Icon
 *   init, `volumechange` handler, and `hasAudio` also read the on-screen element.
 * v14.6.3 — [play/pause + live-dot fixes] Both bugs had ONE root cause: the card bound the play/
 *   pause button and the live-indicator dot to `this.driver.video` (the MSE element), but during
 *   the reversible-RTC `promoted` phase the on-screen pixels are the overlay `_rtcVideo` while MSE
 *   is hidden underneath. Driver v2.4.4 adds `get onscreenVideo()`; the card now targets it.
 *   (1) PLAY/PAUSE: pause used to call video.pause() on the hidden MSE element → the icon flipped
 *   to ▶ but the visible RTC kept playing. Now the button calls the driver's suspend()/resume()
 *   (chosen semantics "C"): soft-pause the ON-SCREEN element AND hold the commit/revert poll so the
 *   handoff machine can't call play() and auto-resume. Instant freeze/resume (<100ms); decoder+
 *   socket kept warm on purpose — bandwidth teardown stays the off-screen auto-pause's job.
 *   (2) LIVE-DOT: the dot watched the hidden, no-longer-fed MSE element → RED on a perfect RTC
 *   stream, and never recovered because the commit's srcObject swap cancelled the pending rVFC.
 *   The dot now binds to `onscreenVideo`, re-targets when the on-screen element changes
 *   (promote/commit/revert), and re-arms after a source swap. Pin bumps ?v=2.4.3 → 2.4.4.
 * v14.6.2 — [Lever A + D1] Two latency/UX fixes shipped together (pin bumps ?v=2.4.2 → 2.4.3).
 *   LEVER A (driver): the no-data watchdog is now phase-aware. While an un-committed RTC probe is
 *   live (_rtcPhase negotiating/promoted) a doomed probe is declared dead after 2.5s
 *   (NEGOTIATING_DISCONNECT_TIMEOUT) instead of the full 5s DISCONNECT_TIMEOUT. On a narrow link
 *   the additive RTC probe starves the MSE ws, so the old 5s tolerance was a fleet-wide collateral
 *   stall window; halving it during probes shortens the collateral damage without touching the
 *   committed-stream watchdog. Answers the field hypothesis "we wait too long before declaring the
 *   non-MSE attempt dead."
 *   D1 (card): reconnect gap now shows a freeze-frame instead of a black box with a play glyph. The
 *   last decoded frame is captured to a JPEG data URL in _scheduleRetry() (while the dying <video>
 *   is still alive, same instant as _lockHeight) and applied as the NEXT driver's video.poster —
 *   the browser natively shows it until the new stream decodes its first frame, and a poster also
 *   suppresses the empty-state play glyph. One-shot (cleared once applied); Main driver only (the
 *   Shadow negotiates hidden). Opt out with `freeze_frame: false`. Canvas is same-origin/untainted
 *   (same as saveScreenshot). No static poster configured → freeze survives untouched to first frame.
 * v14.6.1 — [A0] Severity trigger for the suppression latch. Field logs of the real "pessima" 4G
 *   pattern showed the cumulative flap score never latched: the 4 cameras die together once per
 *   ~2-min burst (each counts only 1 flap on its own card state) and the 45s decay wiped the score
 *   between bursts → stuck at 1.0/3, RTC never suppressed, all cameras black with no recovery. But
 *   the metrics sampled the instant before each death read loss 35-50% — proof the link is narrow.
 *   Now the card parses loss% from the metrics line; a within-probation death preceded by a FRESH
 *   (≤8s) sample with loss ≥ FLAP_LOSS_PCT (20%) weighs a full FLAP_SUPPRESS_AT → latches on the
 *   FIRST such death instead of never. Decay widened 45s→120s so the slow cumulative path still
 *   accumulates across bursty failures. Card-only, pin stays ?v=2.4.2. Using loss ONLY for the
 *   suppress policy is consistent with v14.5.2 (promote/commit/revert stay framesDecoded-only).
 * v14.6.0 — [A0/B1] History-driven narrow-link RTC suppression + retry-storm damping. Card-only
 *   (driver unchanged, pin stays ?v=2.4.2). Acts on the v14.5.2 field finding (memory
 *   webrtc-mobile-collapse-is-rtc-additive): the multi-camera mobile collapse is RTC-ADDITIVE load,
 *   not MSE concurrency — with RTC on, 4G streams land then die in 5-14s (RTC never promotes,
 *   20-59% loss, MSE starved past the 5s watchdog), while the SAME 4 cameras MSE-only hold ~550KB/s
 *   with zero watchdog trips. Fix, all as CARD state so it survives driver churn:
 *     • [B1] A stream now becomes "healthy" (backoff reset) only after surviving STREAM_PROBATION_MS
 *       (20s). Previously every 5-14s land reset _retryCount → the fixed-looking "retry #1 in 1000ms"
 *       storm. A land that dies within probation lets the exponential backoff CLIMB instead.
 *     • [A0] Each within-probation death is a "flap" feeding a decaying score (FLAP_DECAY_MS 45s).
 *       At FLAP_SUPPRESS_AT (3) we LATCH MSE-only: every new driver is built with 'webrtc' stripped
 *       from its mode and the re-probe loop is silenced, removing the additive RTC load entirely.
 *       Self-releasing: after RTC_RETEST_MS (5min) the next build re-tests full mode; if it flaps
 *       again it re-suppresses. A happy MSE-only stream is left undisturbed (re-test is lazy, at the
 *       next cold start). Fat links never accumulate 3 flaps → behaviour byte-for-byte unchanged.
 *       Opt out with `rtc_adaptive: false`. New HA log lines: rtc-flap / rtc-suppressed (warn) /
 *       rtc-retest / stream-stable.
 * v14.5.3 — Driver v2.4.2 hotfix: onopen() null-mode crash guard. A null this.mode made the
 *   driver throw at ws-open (0-byte channel) and reconnect immediately -> reconnect storm, seen
 *   even on LAN. Card-side unchanged; pin bumped to ?v=2.4.2 (cache-bust).
 * v14.5.2 — Passive bandwidth instrumentation (driver v2.4.1). The card now logs the driver's
 *   compact `metrics` line (RTT + min-baseline, loss%, goodput, jitter, RTC phase) at debug,
 *   bypassing the dedup throttle so each 3s sample lands intact. Diagnostic ONLY — no stream
 *   behaviour changes on any path. First data-gathering step toward history-driven adaptation of
 *   the fixed RTC/retry/watchdog constants: on real links, does RTT bufferbloat / rising loss
 *   PRECEDE the mse->rtc->mse reverts that collapse multi-camera mobile sessions? Enable with
 *   `logger: logs: custom_components.webrtc.card: debug` and read in Settings → System → Logs.
 * v14.5.1 — HA native ICE (#923) cold-start gate: resolve HA's ICE servers BEFORE building the
 *   first driver, so the primary reversible-RTC path relays via Nabu Casa TURN from t=0 (~2s
 *   promote) instead of catching up 30s+ later through a shadow reprobe. Previously the one-shot
 *   fetch raced the cold start and always lost, so the FIRST stream after every (re)load carried
 *   only the 2×STUN default — a remote CGNAT user glancing at a camera for <~35s never reached the
 *   relay. The fetch is now a bounded (300ms), one-flight promise: `set hass` warms it, startStream
 *   awaits the SAME promise on a cold start only (shadow/reprobe/reconnect skip it — already
 *   cached). A `_coldStartInFlight` latch coalesces concurrent `set hass` ticks across the await,
 *   and a post-await re-validation (isConnected/paused/driver) prevents resurrecting a card
 *   detached mid-fetch. Fail-soft: timeout or old HA → 2×STUN default (worst case = prior
 *   behaviour), with the periodic reprobe still the backstop for the rare timeout path. Added cost:
 *   the single WS round-trip (~10ms) on the first frame. Card only; driver unchanged (v2.4.0).
 * v14.5.0 — HA native ICE (#923): the card now also reuses Home Assistant's OWN ICE servers —
 *   the user's `webrtc:` config plus any cloud-provided TURN (Nabu Casa / Homeway) — fetched
 *   once via the native `web_rtc/ice_servers` WS command (pure JS; zero Python; fails soft on
 *   older HA). This is the only way to reach the rotating, non-pasteable Nabu Casa TURN creds,
 *   giving CGNAT / symmetric-NAT users relay for free. Precedence, most specific wins:
 *   per-card `ice_servers` (#952, incl. `[]` opt-out) → HA native ICE (#923) → 2×STUN default
 *   (#915). Logging (card sub-logger): resolved ICE source + HA-fetch outcome at `debug` (`ice` /
 *   `ice-ha`, like the `mode` mirror); a configured-but-malformed per-card `ice_servers` is flagged
 *   at `warning` (`ice-config`, default-visible) instead of being silently dropped. (video-rtc → v2.4.0.)
 * v14.4.1 — ICE defaults (#915): the built-in default now offers TWO independent public STUN
 *   servers (Google + Cloudflare) instead of Google alone, so a blocked/filtered/down provider
 *   no longer kills srflx discovery out-of-the-box. Applies to every camera. `_normalizeIceServers`
 *   now distinguishes an unset `ice_servers` (→ keep default) from an EXPLICIT `ice_servers: []`
 *   (→ zero servers, a documented privacy opt-out); the injection uses `!== null` so `[]` is honored.
 *   A per-card `ice_servers` list still fully REPLACES the default. (video-rtc → v2.4.0.)
 * v14.4.0 — Custom-UI enhancement batch (all gated behind `ui: true`, no effect on the MSE↔RTC
 *   path): (1) #913 — the `.play` control is now a real play/pause toggle: it stays visible and
 *   mirrors the element state (`mdi:play`/`mdi:pause`), so a live stream can be frozen and resumed
 *   (before, it only appeared to resume a pause). (2) #953 — `unmute_in_fullscreen: true` unmutes
 *   while fullscreen and restores the prior muted state on exit (iOS `webkitendfullscreen` +
 *   standard `fullscreenchange`). (3) #924 — `spinner: false` omits the loading spinner entirely;
 *   `spinner_delay: <ms>` defers showing it on a `waiting`, so brief stalls don't flash it.
 *   Also noted: #949 (local PNG poster) already works via the `poster` option (documented).
 * v14.3.4 — Fix iOS 26.1 MSE stutter (#910/#884): the fork had inherited upstream v3.6.1's MSE
 *   live-sync in `video-rtc.js` (`currentTime = start` re-seek + `playbackRate = gap`). On iOS 26.1
 *   WebKit this pins playbackRate to the 0.1 floor near the live edge → video crawls at ~0.1x
 *   ("~1 frame / 3s"). Removed the catch-up: MSE now plays at 1x (pre-3.6.1 behavior). WebRTC
 *   remains the low-latency path; MSE is the reliable fallback.
 * v14.3.3 — Fix `"webrtc-camera" has already been used` on double module load (#932): the
 *   `customElements.define('webrtc-camera')` at the bottom was unconditional while `video-rtc` was
 *   guarded. A second evaluation (swipe-card, scoped registry, service-worker / `?v=` cache-bust
 *   race) threw and aborted load. Now wrapped in `if (!customElements.get('webrtc-camera'))`, which
 *   also de-dupes the `window.customCards` entry.
 * v14.3.2 — Two upstream items: (1) browser-side `ice_servers` (#952) — an optional card option
 *   that replaces the driver's default Google STUN with user-supplied STUN/TURN on every driver
 *   (main + shadow), for CGNAT homes without Nabu Casa; injected where the driver is created,
 *   normalized by `_normalizeIceServers`. (2) `fire-dom-event` from `shortcuts` (#940) — a shortcut
 *   with `service: fire-dom-event` now dispatches `ll-custom` (for browser_mod close_popup etc.)
 *   instead of failing a bogus `fire-dom-event.undefined` service call (fix in ui-interaction.js).
 * v14.3.1 — Fix `tap_action` (#668): the card now EXECUTES the action itself instead of
 *   dispatching a `hass-action` event that nothing catches for a standalone custom card
 *   (so `more-info` etc. silently did nothing). `handleAction` handles more-info
 *   (via `hass-more-info`), navigate (`location-changed`), url, toggle, perform-action /
 *   call-service (`hass.callService`) and fire-dom-event, with entity fallback
 *   action.entity → config.entity → current stream's entity.
 * v14.3.0 — Feature batch: media_player /api/ffmpeg (#942) + volume_entity (#945),
 *   tap_action (#668, pinch/PTZ-safe), live_indicator dot (#922).
 * v14.2.16 — Fix a regression from the always-on server-side logging (v14.2.11): a failed
 *   `system_log.write` popped a user-facing "Impossibile eseguire l'azione system_log.write"
 *   toast — one PER CARD — on the Android companion when resuming from a long lock-screen (the
 *   page-visible lifecycle write fires while the WS is still reconnecting, so it rejects with
 *   unknown_error). `_emitLog` now passes `notifyOnError=false` to `hass.callService` (HA's
 *   frontend defaults it to true and pops the toast itself) and `.catch()`es the returned promise
 *   (the async rejection was never caught by the synchronous try/catch → unhandled rejection).
 *   Diagnostic logging is now truly silent on failure. Also guards `!this._hass`.
 * v14.2.15 — Memory-hygiene pass. (1) Load driver v2.3.8 (MSE blob-URL revoke on teardown) via
 *   the `video-rtc.js?v=` import pin; the manifest bump re-fetches the card and pulls the new
 *   driver past the browser/PWA cache. (2) Store each main driver's `connection-closed` listener
 *   ON the driver (`_connClosedHandler`, via `_attachMainConnClosed`) instead of a single shared
 *   card field, so `_nukeDriver` always removes the exact right listener regardless of call order
 *   (removes a latent correctness fragility — see the `_attachMainConnClosed` docblock).
 * v14.2.14 — Fix a retry-latch deadlock: a recovered camera never reconnected. `_scheduleRetry`
 *   cleared `_retryTimer` BEFORE the `_isReconnecting` guard, so a burst of errors from the same
 *   dying driver (mse-fail → webrtc/offer-fail → ws-close, all within ms) landing inside the backoff
 *   window cancelled the armed retry and then early-returned without rescheduling — stranding the
 *   camera forever (`_isReconnecting` only clears in the timer callback that now never runs). Most
 *   visible at the longer 4000ms+ backoff, where the burst reliably beats the timer. Fix: guard on
 *   `_isReconnecting` FIRST so the pending retry survives the burst; the backoff loop resumes and
 *   the camera recovers when it comes back online. No behaviour change to a healthy stream.
 * v14.2.13 — Fix `_logHA` throttle for the `mode` event. The dedup-throttle keyed only by event
 *   name, so the two startup transitions (`none -> mse`, `mse -> rtc`) collapsed into one 10s
 *   bucket: the MSE→RTC upgrade — the very line v14.2.12 added for app visibility — was delayed up
 *   to 10s and mislabelled `(repeated 1× in 10s)`, and a revert in the same window lost its detail.
 *   `mode` now keys by event+detail so distinct transitions each emit live, while a same-direction
 *   flap still collapses (flood-safe). retry/driver-error keep the event-only key (their detail is
 *   high-cardinality — keying by it would defeat the throttle).
 * v14.2.12 — Field visibility: mirror every mode transition to the HA log. `_setActiveMode()` is
 *   the single choke-point for all mode changes (initial land, shadow swap, direct-RTC, RTC→MSE
 *   revert), but `stream-up` only fired on the initial ui_sync land — so on the HA Companion apps
 *   (no browser console) the fork's defining MSE→RTC upgrade and its reverts were invisible. Added
 *   a `_logHA('debug','mode', 'a -> b')` in `_setActiveMode`; the app log can now answer "did this
 *   camera reach RTC / fall back?". Rare event (once per upgrade/revert) → negligible SD cost. No
 *   behaviour change.
 * v14.2.11 — Removed the card's custom debug GATE for coherence: the server-side lifecycle
 *   mirror (_logHA → custom_components.webrtc.card) is now ALWAYS emitted, at rationalized levels,
 *   and the native HA logger level is the only filter — same model as the JS console and the
 *   Python backend. Dropped the `debug` card option, `_debugEnabled()`, and the missing-entity
 *   warn. Levels: connection-closed / driver-error = warning (shown by default); retry, stream-up,
 *   page-hidden/visible, auto-pause/resume = debug (need custom_components.webrtc.card: debug).
 *   The 10s dedup-throttle still bounds the service-call rate during failure storms.
 * v14.2.10 — Console log-level rationalization (no behaviour change). All routine lifecycle,
 *   negotiation and shadow-upgrade traces moved from info to `console.debug` (hidden at the
 *   browser console's default level, shown with Verbose). `Main Driver Error` reclassified
 *   error → warn (a `no route to host` / `i/o timeout` is a recoverable network transient the
 *   retry loop handles, not a code fault). Kept: the version banner + the two user-action lines
 *   (Hard Reset, Next Stream) at info; connection-closed / auth-failed at warn/error. The native
 *   console level filter now acts as the gate — no custom console gating. Consumes driver v2.3.7.
 *   Backend Python re-levelled in lockstep: per-stream Client/Stream-ended/BENCHMARK traces
 *   info → debug, server `Stream error` error → warning.
 * v14.2.9 — Debug events now log under a dedicated sub-logger `custom_components.webrtc.card`
 *   (was `custom_components.webrtc`). Lets you raise ONLY the card events to info without also
 *   un-muting the backend proxy's own chatty info logging (handshake/benchmark/counters).
 * v14.2.8 — Warn once on the console when `debug` points to a non-existent HA entity_id, so a
 *   typo'd / not-yet-created helper doesn't look like broken logging. Debug still stays off.
 * v14.2.7 — Field-debug pack (no streaming-behaviour change on the happy path). Three additions
 *   aimed at diagnosing stream loss on the HA mobile app, where no browser console exists:
 *   (1) LAYOUT: on a retry the card now LOCKS its rendered height (_lockHeight) until the new
 *   stream is healthy, then releases it. Previously a retry removed the <video>, the card
 *   collapsed to ~0, and in a Sections/Masonry view HA re-packed the whole section — reflowing
 *   (and disturbing) every sibling camera. (2) STATUS: a connection error now shows a localized
 *   generic ("Reconnecting…") instead of the raw driver string; the raw reason is kept in the
 *   console and the tooltip. (3) LOGGING: opt-in `debug` (true | an entity_id) mirrors the
 *   stream lifecycle (errors, closes+reason, retries, recovery, visibility) to home-assistant.log
 *   via system_log.write, dedup-throttled to avoid flooding. Consumes driver v2.3.6 (adds
 *   connection-closed `detail.reason`). Off by default → existing cards are byte-for-byte unaffected.
 * v14.2.6 — [SMELL #2/#3] Message-handler role split + _activeMode setter. The driver's
 *   overloaded rtc_* signals are now hard-dispatched on the receiver's role
 *   (_onPreSwapShadowMessage vs _onMainMessage) instead of branch-order + a "never fall
 *   through" convention; also corrects post-swap 'error' routing. All _activeMode writes go
 *   through _setActiveMode() (single audit point + transition log). No streaming behaviour
 *   change on either reference net beyond the post-swap error fix. Driver unchanged (v2.3.5).
 * v14.2.5 — Driver RTC refactor (driver v2.3.5), no card behaviour change. Consumes a driver
 *   whose RTC handoff is now an explicit `_rtcPhase` state machine and whose dead legacy
 *   (non-reversible) path was removed. The vestigial `newDriver.reversible = true` assignment
 *   is dropped (the driver no longer reads it — the reversible flow is its only RTC path).
 * v14.2.4 — Tunable RTC knobs. New per-card YAML options `rtc_swap_prove_ms` (default 30000,
 *   raised from 20000) and `firstframe_timeout` (default 120000, lowered from 600000) are
 *   injected into the driver in startStream(). Defaults revised per the good-vs-badass-net
 *   log analysis: both changes only affect degraded paths, not the clean direct-upgrade path.
 * v14.2.3 — Prove-gated shadow swap. The background shadow no longer swaps in at its 2s RTC
 *   PROMOTE; the working MSE main stays visible until the shadow's RTC has held gaplessly for
 *   RTC_SWAP_PROVE_MS (~20s), signalled by `rtc_sustained` from the driver. On throttled paths
 *   the shadow stalls before proving and is reaped (no black tile, no swap/revert churn, backoff
 *   escalates normally); on good paths it swaps cleanly. Swap logic extracted to
 *   _promoteShadowToMain().
 */

import {VideoRTC} from './video-rtc.js?v=2.12.1';
import {DigitalPTZ} from './digital-ptz.js?v=3.3.0';
// [SIDECAR INTEGRATION] Import the Interaction module.
// This module handles legacy features (Shortcuts, PTZ, Styles) to keep the core driver clean.
import {UIInteraction} from './ui-interaction.js?v=1.1.1';

// Ensure the dumb driver is registered exactly once.
// The driver itself contains no UI logic and must remain isolated.
if (!customElements.get('video-rtc')) {
    customElements.define('video-rtc', VideoRTC);
}

// [I18N] On-screen status strings. Kept as a tiny local map (a custom card cannot use HA's
// core `hass.localize`, whose keys live in the frontend translation bundles). Picked by the
// user's HA language with an English fallback. Add a language by adding its two-letter key.
const STRINGS = {
    en: { error: 'Error', reconnecting: 'Reconnecting…' },
    it: { error: 'Errore', reconnecting: 'Riconnessione…' },
    de: { error: 'Fehler', reconnecting: 'Neu verbinden…' },
    fr: { error: 'Erreur', reconnecting: 'Reconnexion…' },
    es: { error: 'Error', reconnecting: 'Reconectando…' },
};

class WebRTCCamera extends HTMLElement {
    constructor() {
        super();
        this.attachShadow({mode: 'open'});

        // Home Assistant instance reference.
        // Stored only to request signed URLs and never cached elsewhere.
        this._hass = null;

        // Index of the active stream.
        // This is mutable state, everything else is recreated.
        this.streamID = -1;

        // Current VideoRTC driver instance.
        // IMPORTANT: this reference is always temporary.
        this.driver = null;

        // [SEAMLESS HANDOVER] Shadow driver reference.
        // This driver runs in background to probe for better connections (WebRTC)
        // without disturbing the active playback.
        this.shadowDriver = null;

        // [B / url_fullscreen] When non-null ({url}), forces the high-res stream while the card
        // is fullscreen. Merged over the effective config in startStream(); cleared on exit.
        this._fsStreamOverride = null;

        // [SIDECAR INTEGRATION] Reference to the UI Sidecar.
        // This object manages buttons, styles and mechanical PTZ logic.
        this.interaction = null;

        // [MEMORY FIX] Reference to the active DigitalPTZ instance.
        // We must track this to call .destroy() before creating a new one,
        // otherwise event listeners accumulate on the static DOM elements.
        this.digitalPTZ = null;

        // Reconnection state machine.
        // These flags exist to avoid reconnect storms and overlapping drivers.
        this._isReconnecting = false;
        this._retryCount = 0;
        this._retryTimer = null;
        // True once a media mode has actually come up. Lets us tell a fatal
        // "stream never started" error (retry) from a non-fatal per-mode error
        // on an already-playing stream (ignore).
        this._streamHealthy = false;

        // [HA NATIVE ICE (#923) — COLD-START GATE] State for resolving Home Assistant's
        // own ICE servers (Nabu Casa / Homeway TURN) BEFORE the first driver is built, so
        // the primary reversible-RTC path can relay from t=0 (2s promote) instead of
        // catching up 30s+ later via a shadow reprobe. See _ensureHaIceReady().
        this._haIceServers = null;         // resolved value: RTCIceServer[] | null (none/unavailable)
        this._haIceReady = false;          // true once the fetch RESOLVED or timed out (fail-soft)
        this._haIcePromise = null;         // one-flight fetch promise (warm-up + gate join the same one)
        this._coldStartInFlight = false;   // latch: coalesce concurrent set-hass ticks during the await

        // [SEAMLESS HANDOVER] Retry counter for background upgrades
        this._shadowAttempts = 0;
        // [SEAMLESS HANDOVER] Watchdog timer to kill stuck shadow connections
        this._shadowTimeout = null;
        
        // [PHANTOM FIX] Timer for delayed upgrade trigger.
        // Must be cancelable if WebRTC connects spontaneously.
        this._upgradeTimer = null;

        // [RTC RE-PROBE] Periodic background WebRTC re-probe while settled on MSE.
        // The initial _upgradeTimer is a single fast attempt right after MSE lands;
        // this loop is the long-term safety net. Since a failed WebRTC no longer
        // tears down MSE (driver v2.2.14 #6), a stream that started on MSE because
        // WebRTC was momentarily unavailable (UDP briefly blocked, TURN down, ICE
        // timeout) can still be upgraded minutes later, without ever disturbing the
        // live MSE picture. Attempts back off (30s, 60s, 120s ... capped at 10min)
        // so a permanently WebRTC-incapable network settles to one cheap probe every
        // 10 minutes. Opt out with `rtc_reprobe: false`.
        this._reprobeTimer = null;   // pending re-probe timer handle
        this._reprobeDelay = 0;      // current backoff delay in ms (0 = loop idle)
        this._activeMode = null;     // last negotiated main-driver transport: 'mse' | 'rtc'

        // [A0/B1] Narrow-link RTC suppression + retry-storm damping. Pure CARD state, so it
        // survives the driver's per-reconnect teardown (the learning must outlive the churn).
        // Signal: a stream that reaches media then dies within STREAM_PROBATION_MS is a "flap".
        // On constrained mobile the reversible RTC negotiation + MSE keep-warm is ADDITIVE load
        // that starves the MSE feed past the 5s no-data-watchdog seconds after it lands (validated
        // 2026-08-25: MSE-only 4G holds ~550KB/s with 0 watchdog trips; RTC-on 4G = reconnect
        // storm, RTC never even promotes, 20-59% loss). Flaps feed a decaying score; past
        // FLAP_SUPPRESS_AT we LATCH _rtcSuppressed → every new driver is built MSE-only and the
        // re-probe loop is silenced (A0), and the retry-backoff reset is withheld until a stream
        // survives probation (B1) so the storm slows instead of hammering at 1000ms. The latch
        // is self-releasing (RTC_RETEST_MS). Fat links never accumulate enough flaps to latch, so
        // their behaviour is byte-for-byte unchanged. Opt out entirely with `rtc_adaptive: false`.
        //
        // [A0 v14.6.1] Severity trigger. Field logs of the real "pessima" pattern (2026-08-25) show
        // the cumulative score alone never latches: the 4 cameras die *together* once per ~2-min
        // burst (each camera counts only 1 flap on its own state) and the 45s decay wiped the score
        // between bursts → stuck at 1.0/3 forever, RTC never suppressed. But the metrics sampled the
        // instant before each death read loss 35-50% — unambiguous proof the link is narrow. So a
        // within-probation death preceded by a FRESH high-loss sample (_lastLossPct ≥ FLAP_LOSS_PCT)
        // now weighs a full FLAP_SUPPRESS_AT → latches on the FIRST such death; the decaying score is
        // kept as the slow path for moderate degradation (decay widened 45s→120s so bursty-but-
        // repeated failures accumulate instead of resetting). Using loss ONLY for the suppress policy
        // is consistent with the v14.5.2 principle: promote/commit/revert stay framesDecoded-only;
        // the metrics feed adaptation, which is exactly this. See webrtc-mobile-collapse-is-rtc-additive.
        this._healthyTimer = null;   // [B1] probation timer; on fire → confirm healthy, reset backoff
        this._streamUpAt = 0;        // when the current media mode landed (ms)
        this._flapScore = 0;         // decaying count of within-probation stream deaths
        this._flapLast = 0;          // last flap/decay timestamp, for linear decay
        this._lastLossPct = 0;       // most recent inbound-rtp loss% parsed from the metrics line
        this._lastLossAt = 0;        // when that sample arrived, for the freshness gate
        this._lastBand = '';         // most recent band verdict parsed from the metrics line (net dot)
        this._lastBandAt = 0;        // when that band sample arrived (staleness -> white)
        this._netTimer = null;       // network-indicator staleness interval handle
        this.NET_DOT_STALE_MS = 5000; // no band sample for this long -> net dot back to white (emit ~3s)
        this._rtcSuppressed = false; // [A0] latch: build MSE-only, no re-probe
        this._rtcSuppressedAt = 0;   // when the latch engaged, for the RTC_RETEST_MS re-test
        this.STREAM_PROBATION_MS = 20000; // survive this long before a stream counts as healthy
        this.FLAP_DECAY_MS = 120000;      // one flap point ages linearly to zero over this span
        this.FLAP_SUPPRESS_AT = 3;        // score ≥ this → suppress RTC (≈3 quick deaths)
        this.FLAP_LOSS_PCT = 20;          // a within-probation death with loss ≥ this → latch at once
        this.LOSS_FRESH_MS = 8000;        // only trust a loss sample this recent for the severity gate
        this.RTC_RETEST_MS = 300000;      // suppressed this long → next build re-tests full mode

        // Groups the .ui overlay's video/click listeners so they can be dropped
        // in one shot on every rebuild (idempotent renderCustomUI).
        this._uiAbort = null;

        // [AUTO-PAUSE] Off-screen / tab-hidden lifecycle. Disabled unless the
        // user opts in with `background: false`. Because our driver is a hard
        // teardown, "pause" means _cleanupDriver() (frees decoder, closes the WS
        // so go2rtc stops pushing) and "resume" is a cold startStream().
        this._paused = false;      // stream torn down because it is not watchable
        this._docHidden = false;   // document.visibilityState === 'hidden'
        this._offScreen = false;   // host is outside the viewport (IntersectionObserver)
        this._pauseTimer = null;   // debounce so a quick scroll/flick doesn't tear down
        this._io = null;           // IntersectionObserver instance
        this._visAbort = null;     // AbortController for the document visibilitychange listener

        // [DEBUG LOGGING] Dedup state for the opt-in Home Assistant server-side log. null until
        // the first _logHA() call. Keyed by event name → {last, count, level, detail, timer}.
        this._logThrottle = null;
        // [DEBUG LOGGING] AbortController for the debug-gated document visibilitychange listener
        // (correlates stream loss with the mobile app backgrounding / 5G handoff).
        this._logVisAbort = null;

        console.info('[WebRTC Camera] v14.6.18');
    }

    setConfig(config) {
        // Configuration must always contain at least one stream source.
        // Validation here prevents undefined runtime states later.
        if (!config.url && !config.entity && !config.streams) {
            throw new Error('Missing `url` or `entity` or `streams`');
        }

        // Merge defaults with user configuration.
        // Defaults are chosen to favor compatibility and stability.
        this.config = Object.assign({
            mode: config.mse === false
                ? 'webrtc'
                : config.webrtc === false
                    ? 'mse'
                    : 'webrtc,mse,hls,mjpeg',

            media: 'video,audio',

            // Normalize streams into a single internal format.
            streams: [{url: config.url, entity: config.entity}],

            // Remote posters are trusted URLs and must not be rewritten.
            poster_remote: config.poster &&
                (config.poster.indexOf('://') > 0 || config.poster.charAt(0) === '/'),

            // Background mode allows the driver to decide autoplay strategy.
            background: true,

            // Global mute exists to satisfy browser autoplay policies.
            muted: false,

            // Network strict mode controls fail-fast vs recovery behavior.
            network_strict: false
        }, config);

        // Initialize stream index only once.
        if (this.streamID === -1) {
            this.streamID = 0;
        }

        this.renderStructure();

        // Build (or rebuild) the interaction sidecar from the current config.
        // HA reuses the element and calls setConfig again when the card is edited,
        // so this must run every time to reflect live shortcuts/ptz/style changes.
        this._initSidecar();

        // Reflect live `ui` / stream-count changes on the built-in overlay too.
        // Safe no-op until a driver is connected (guarded inside renderCustomUI).
        this.renderCustomUI();

        // [AUTO-PAUSE] (Re)wire off-screen / tab-hidden watching from the current
        // config. Idempotent: tears down any previous observer/listener first.
        this._setupVisibility();

        // [DEBUG LOGGING] Ensure the debug visibility logger is wired (idempotent). setConfig can
        // run before connectedCallback when HA builds the card, so wire it here too.
        this._setupDebugVisibilityLog();
    }

    connectedCallback() {
        // Re-arm visibility watching if the card was detached and re-attached
        // (HA can move cards around the masonry). No-op until setConfig ran.
        if (this.config) this._setupVisibility();
        // [DEBUG LOGGING] Attach the debug-gated visibility logger (emit self-gates on `debug`).
        this._setupDebugVisibilityLog();
    }

    // [AUTO-PAUSE] Wire (or re-wire) the off-screen + tab-hidden observers.
    // Only active when the user opts in with `background: false`; otherwise the
    // stream runs 24/7 as before. Fully idempotent so a live config edit or a
    // re-attach never stacks duplicate observers/listeners.
    _setupVisibility() {
        // Always clear any previous wiring first.
        this._teardownVisibility();

        // Opt-in only. `background: true` (default) => never auto-pause.
        if (this.config.background !== false) return;

        // Off-screen detection on the host element. `intersection` (0..1) is the
        // visible fraction below which the stream counts as off-screen.
        const threshold = this.config.intersection || 0;
        this._io = new IntersectionObserver((entries) => {
            // isIntersecting is true while the visible fraction is at/above the
            // threshold, false once it drops below it.
            const e = entries[entries.length - 1];
            this._offScreen = !e.isIntersecting;
            this._evaluateVisibility();
        }, {threshold: [threshold]});
        this._io.observe(this);

        // Tab-hidden / minimized / screen-off detection.
        this._visAbort = new AbortController();
        this._docHidden = document.visibilityState === 'hidden';
        document.addEventListener('visibilitychange', () => {
            this._docHidden = document.visibilityState === 'hidden';
            this._evaluateVisibility();
        }, {signal: this._visAbort.signal});

        // Reconcile immediately with the current state.
        this._evaluateVisibility();
    }

    _teardownVisibility() {
        if (this._io) {
            this._io.disconnect();
            this._io = null;
        }
        if (this._visAbort) {
            this._visAbort.abort();
            this._visAbort = null;
        }
        if (this._pauseTimer) {
            clearTimeout(this._pauseTimer);
            this._pauseTimer = null;
        }
    }

    // [AUTO-PAUSE] Decide whether the stream should be running and act on it,
    // debounced so a quick scroll-past or tab flick never tears the stream down.
    _evaluateVisibility() {
        const shouldStream = !this._docHidden && !this._offScreen;

        if (shouldStream) {
            // Became watchable again: cancel any pending pause, resume if paused.
            if (this._pauseTimer) {
                clearTimeout(this._pauseTimer);
                this._pauseTimer = null;
            }
            if (this._paused) this._resumeStream();
            return;
        }

        // Not watchable: schedule a debounced teardown (once).
        if (this._paused || this._pauseTimer) return;
        const delay = this.config.pause_delay != null ? this.config.pause_delay : 5000;
        this._pauseTimer = setTimeout(() => {
            this._pauseTimer = null;
            this._pauseStream();
        }, delay);
    }

    // [AUTO-PAUSE] Hard teardown: frees the decoder and closes the WS so go2rtc
    // stops pushing. This is the whole point — a soft video.pause() would keep
    // burning bandwidth and hold the decoder.
    _pauseStream() {
        if (this._paused) return;
        console.debug('[WebRTC Camera] Auto-pause: off-screen/hidden, tearing down stream');
        this._logHA('debug', 'auto-pause', 'off-screen/hidden');
        this._paused = true;

        // Kill every pending timer so nothing revives the stream while paused.
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        if (this._upgradeTimer) { clearTimeout(this._upgradeTimer); this._upgradeTimer = null; }
        if (this._shadowTimeout) { clearTimeout(this._shadowTimeout); this._shadowTimeout = null; }
        if (this._healthyTimer) { clearTimeout(this._healthyTimer); this._healthyTimer = null; }
        this._stopReprobe(); // [RTC RE-PROBE] no background upgrades while paused
        this._isReconnecting = false;

        this._cleanupDriver();
        this._streamHealthy = false;
        this._setActiveMode(null);
        this.setStatus(null, null, 'Paused (off-screen)');
    }

    // [AUTO-PAUSE] Resume with a clean cold start.
    _resumeStream() {
        if (!this._paused) return;
        console.debug('[WebRTC Camera] Auto-resume: back on-screen, restarting stream');
        this._logHA('debug', 'auto-resume', 'back on-screen');
        this._paused = false;
        this._retryCount = 0;
        if (this._hass && this.config && this.shadowRoot && !this.driver) {
            this.startStream();
        }
    }

    // [I18N] Resolve a status string in the user's HA language, falling back to English.
    _t(key) {
        const lang = (this._hass && (this._hass.language ||
            (this._hass.locale && this._hass.locale.language))) || 'en';
        const table = STRINGS[String(lang).slice(0, 2)] || STRINGS.en;
        return table[key] || STRINGS.en[key] || key;
    }

    // [LAYOUT] Freeze the card's rendered height across a retry teardown.
    //
    // WHY: the card has no fixed aspect-ratio — its height comes from the <video>. A retry
    // removes the driver, so between teardown and the next healthy frame the card would
    // collapse to ~0. In a Sections/Masonry view HA measures each card (ResizeObserver →
    // grid-row span) and re-packs the whole section on that height change, reflowing — and
    // disturbing the live streams of — every sibling camera. Locking a min-height on .player
    // (the video area; the header is position:absolute and never contributes) keeps the box
    // stable, so the section never re-packs. Released by _unlockHeight() once a real media
    // mode comes up (the new stream may have a different aspect ratio: one clean adjustment at
    // the end beats a collapse-then-grow flash).
    _lockHeight() {
        const player = this.shadowRoot && this.shadowRoot.querySelector('.player');
        if (!player) return;
        const h = player.offsetHeight;
        if (h > 0) player.style.minHeight = h + 'px';
    }

    _unlockHeight() {
        const player = this.shadowRoot && this.shadowRoot.querySelector('.player');
        if (player) player.style.minHeight = '';
    }

    // [D1 FREEZE-FRAME] Grab the last decoded frame from the dying driver's <video> and stash it
    // as a JPEG data URL. Called from _scheduleRetry() while the old driver is still alive (frozen
    // last frame, same point _lockHeight() relies on). The stashed frame is applied as the NEXT
    // driver's video.poster (see startStream), so the reconnect gap shows the last live frame
    // instead of a black box with a browser play glyph. One-shot: consumed and cleared when applied.
    //
    // Same-origin, so the canvas is never tainted (saveScreenshot() proves this). Opt out with
    // `freeze_frame: false`. Silently no-ops if nothing has decoded yet (videoWidth 0) — cold start
    // has no frame to freeze, and that's fine (falls back to any static poster, else black).
    _captureFreezeFrame() {
        if (this.config.freeze_frame === false) return;
        const video = this.driver && this.driver.video;
        if (!video || !video.videoWidth || !video.videoHeight) return;
        try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            this._freezeFrameUrl = canvas.toDataURL('image/jpeg', 0.7);
        } catch (e) {
            // Tainted canvas or draw failure: leave the gap black rather than throw.
            this._freezeFrameUrl = null;
        }
    }

    // [LIFECYCLE LOGGING] Mirror one stream-lifecycle event to the HA log via system_log.write,
    // under the dedicated sub-logger `custom_components.webrtc.card`. ALWAYS emitted — there is NO
    // custom gate: the native HA logger level is the filter, exactly like the JS console and the
    // Python backend. The `warning` events (connection-closed, driver-error) show in Settings →
    // System → Logs by default; the `debug`-level lifecycle (retry, stream-up, page-hidden/visible,
    // auto-pause/resume) needs `logger: logs: custom_components.webrtc.card: debug`. Dedup-throttled
    // (10s window): the first occurrence emits immediately; repeats are counted and flushed once as
    // a summary, so a continuously failing stream cannot flood the log even at warning level.
    _logHA(level, event, detail) {
        if (!this._hass) return;
        // [BW INSTRUMENTATION] `metrics` is a periodic diagnostic sampler already rate-limited at
        // the driver (METRICS_EMIT_MS=3s). Bypass the dedup throttle so each sample lands intact:
        // its detail is high-cardinality (numbers change every time), so the name-keyed throttle
        // would collapse successive samples into "(repeated N×)" and destroy the trend we're after.
        if (event === 'metrics') { this._emitLog(level, event, detail); return; }
        if (!this._logThrottle) this._logThrottle = new Map();

        const WINDOW = 10000;
        const now = Date.now();
        // Throttle key: normally the event name, so identical repeats (retry / driver-error spam)
        // collapse into one summary. `mode` is the exception — each occurrence carries a DISTINCT,
        // meaningful transition in `detail`, so key it by event+detail: different transitions
        // (none->mse, mse->rtc, rtc->mse) each emit LIVE, while a real same-direction flap still
        // collapses (flood-safe). Do NOT extend this to events whose detail is high-cardinality
        // (retry: "attempt #N in Xms") — the key would never match and the throttle would be lost.
        const key = event === 'mode' ? `${event}|${detail}` : event;
        const rec = this._logThrottle.get(key);

        if (rec && (now - rec.last) < WINDOW) {
            rec.count++;
            rec.last = now;
            rec.level = level;
            rec.detail = detail;
            if (rec.timer) clearTimeout(rec.timer);
            rec.timer = setTimeout(() => this._flushLog(key), WINDOW);
            return;
        }

        this._emitLog(level, event, detail);
        this._logThrottle.set(key, { last: now, count: 0, level, event, detail, timer: null });
    }

    _flushLog(key) {
        const rec = this._logThrottle && this._logThrottle.get(key);
        if (!rec) return;
        if (rec.count > 0) {
            this._emitLog(rec.level, rec.event,
                `${rec.detail != null ? rec.detail + ' ' : ''}(repeated ${rec.count}× in 10s)`);
        }
        this._logThrottle.delete(key);
    }

    _emitLog(level, event, detail) {
        if (!this._hass) return;
        const cam = (this.config && (this.config.url || this.config.entity)) || '?';
        const message = `[${cam}] ${event}${detail != null ? ': ' + detail : ''}`;
        try {
            // [SILENT] This is best-effort diagnostic logging — it must never surface to the
            // user. Two guards are required:
            //  (1) notifyOnError=false (5th arg): HA's frontend callService defaults to
            //      notifyOnError=true and pops a "Impossibile eseguire l'azione system_log.write"
            //      toast on failure. On the Android companion resume-from-lock the WS is briefly
            //      reconnecting, so a page-visible/lifecycle write can reject with unknown_error —
            //      one toast PER CARD. false suppresses that toast.
            //  (2) .catch() on the returned promise: callService is async, so the surrounding
            //      try/catch only traps a synchronous throw (e.g. _hass gone), NOT a promise
            //      rejection — without .catch() the rejection is unhandled.
            const p = this._hass.callService(
                'system_log', 'write',
                {
                    level,
                    // Dedicated sub-logger so the card's lifecycle events can be raised alone
                    // (logger: logs: custom_components.webrtc.card: debug) without un-muting the
                    // chatty backend proxy logging (handshake/benchmark) on `custom_components.webrtc`.
                    logger: 'custom_components.webrtc.card',
                    message,
                },
                undefined,   // target
                false,       // notifyOnError — stay silent; this is diagnostic logging
            );
            if (p && typeof p.catch === 'function') {
                p.catch((e) => console.debug('[WebRTC Camera] system_log.write failed', e));
            }
        } catch (e) {
            // Logging must never break the stream.
            console.debug('[WebRTC Camera] system_log.write failed', e);
        }
    }

    _clearLogThrottle() {
        if (!this._logThrottle) return;
        for (const rec of this._logThrottle.values()) {
            if (rec.timer) clearTimeout(rec.timer);
        }
        this._logThrottle.clear();
    }

    // [LIFECYCLE LOGGING] A lightweight visibilitychange listener that mirrors page-hidden/visible
    // to the HA log (at debug level; the native logger level filters it). With `background: true`
    // (default) the card does NOT tear down when the tab/app hides, so these lines are the only
    // server-side signal that a stream loss coincided with the mobile app backgrounding or a
    // 5G→Wi-Fi handoff.
    _setupDebugVisibilityLog() {
        if (this._logVisAbort) return; // already wired
        this._logVisAbort = new AbortController();
        document.addEventListener('visibilitychange', () => {
            this._logHA('debug', document.visibilityState === 'hidden' ? 'page-hidden' : 'page-visible');
        }, { signal: this._logVisAbort.signal });
    }

    _teardownDebugVisibilityLog() {
        if (this._logVisAbort) {
            this._logVisAbort.abort();
            this._logVisAbort = null;
        }
    }

    // [SIDECAR INTEGRATION] (Re)create the UI sidecar overlays (shortcuts, PTZ, style).
    // Tears down the previous instance first so a config-driven rebuild never
    // duplicates the .shortcuts / .ptz-controls DOM or their listeners.
    _initSidecar() {
        if (this.interaction && typeof this.interaction.destroy === 'function') {
            this.interaction.destroy();
        }
        this.interaction = new UIInteraction(this);
        this.interaction.render();

        // Resolve reactive templates immediately if HA state is already available.
        if (this._hass) {
            this.interaction.update(this._hass);
        }
    }

    set hass(hass) {
        this._hass = hass;

        // [HA NATIVE ICE (#923)] Warm up the one-shot fetch of Home Assistant's own ICE
        // servers (user `webrtc:` config + Nabu Casa / Homeway TURN, if any) via the native
        // `web_rtc/ice_servers` WS command — the ONLY path to the rotating, non-pasteable
        // Nabu Casa TURN credentials, so CGNAT / symmetric-NAT users get relay for free.
        // Fire-and-forget here so the fetch starts as early as possible; the cold-start gate
        // in startStream() AWAITS the same one-flight promise so the FIRST driver already
        // carries the TURN (2s promote) instead of catching up via a 30s+ shadow reprobe.
        this._ensureHaIceReady();

        // Start the stream only when:
        // - HA is available
        // - the DOM exists
        // - no driver is currently alive
        // - we are not already reconnecting
        if (this.shadowRoot && !this.driver && !this._isReconnecting && !this._paused) {
            this.startStream();
        }

        // [SIDECAR INTEGRATION] Update the interaction module.
        // We pass the new 'hass' state to the sidecar so it can update
        // reactive templates (e.g. change icon colors) without re-rendering the video.
        if (this.interaction) {
            this.interaction.update(hass);
        }
    }

    get hass() {
        return this._hass;
    }

    disconnectedCallback() {
        // Component removal must fully stop retries and free all resources.
        if (this._retryTimer) clearTimeout(this._retryTimer);
        // [PHANTOM FIX] Ensure upgrade timer is killed on unmount
        if (this._upgradeTimer) clearTimeout(this._upgradeTimer);
        // [B1] Kill the probation timer on unmount.
        if (this._healthyTimer) clearTimeout(this._healthyTimer);
        // [RTC RE-PROBE] Kill the periodic re-probe loop on unmount.
        this._stopReprobe();

        // Drop the .ui overlay listeners bound to the (soon-to-be-gone) video.
        if (this._uiAbort) this._uiAbort.abort();

        // [AUTO-PAUSE] Disconnect the IntersectionObserver and remove the document
        // visibilitychange listener — the document outlives the card, so leaving it
        // wired would leak the card (and fire on a dead element).
        this._teardownVisibility();

        // [DEBUG LOGGING] Drop the visibility logger and any pending dedup flush timers so the
        // detached card leaks nothing (the document outlives the card).
        this._teardownDebugVisibilityLog();
        this._clearLogThrottle();

        this._cleanupDriver();

        // [MEMORY FIX] Ensure DigitalPTZ listeners are removed.
        this._cleanupPTZ();

        // [SIDECAR INTEGRATION] Clear reference to help garbage collection
        this.interaction = null;
    }

    // [SEAMLESS HANDOVER] Helper to clean a specific driver instance
    /**
     * [SEAMLESS HANDOVER] Swap a PROVEN background shadow in to replace the MSE main.
     *
     * Called ONLY from the ui_sync `rtc_sustained` signal — i.e. after the shadow's RTC has
     * held gaplessly for RTC_SWAP_PROVE_MS (~20s). This is deliberately NOT triggered by the
     * shadow's 2s promote: promotion proves RTC can START, not that it can SUSTAIN. Swapping on
     * an unproven shadow was the black-screen + swap-churn bug (nuking a healthy MSE main for a
     * replacement that stalls seconds later). By the time we get here the shadow is durable, so
     * the swap is safe and the working main is only ever torn down for a better proven stream.
     */
    _promoteShadowToMain(newDriver) {
        // Identity re-check: only the current pre-swap shadow may promote.
        if (this.shadowDriver !== newDriver) return;

        console.debug('[WebRTC Camera] Shadow RTC proven durable — SWAPPING DRIVERS NOW.');

        // [CRITICAL] Stop the backstop watchdog immediately.
        if (this._shadowTimeout) {
            clearTimeout(this._shadowTimeout);
            this._shadowTimeout = null;
        }

        // 1. Kill old MSE main. Safe: the shadow carries its OWN warm MSE (reversible), so if
        // its RTC later stalls it reverts to that warm MSE, never to a black screen.
        if (this.driver) this._nukeDriver(this.driver, 'Old Main (MSE)');

        // 2. Promote shadow to main.
        this.driver = newDriver;
        this.shadowDriver = null;
        this._shadowAttempts = 0; // Reset counter on success

        // [RESILIENCE] Now that the shadow is the live main, wire its connection-closed to the
        // global retry. Pre-swap shadows deliberately have no such listener (they must fail
        // silently); without re-attaching it here a genuine ws death after the swap would go
        // unhandled (the old webrtc-only shadow froze black in exactly this gap).
        this._attachMainConnClosed(newDriver);

        // [AUDIO] The shadow was force-muted for background negotiation. Restore the configured
        // audio state via the driver, which routes it to the correct element (RTC overlay while
        // promoted, MSE element once committed) — unmuting newDriver.video directly would play
        // the hidden warm MSE's audio under the RTC video and desync it.
        if (typeof newDriver.applyAudio === 'function') {
            newDriver.applyAudio(!!this.config.muted);
        } else if (newDriver.video && !this.config.muted) {
            newDriver.video.muted = false;
        }

        // 3. Reveal the promoted driver: it was attached hidden as a shadow, so clear the inline
        // overrides and let the `video-rtc` CSS rule size it back to full frame. It is already
        // inside .ptz-transform; the appendChild is a harmless same-parent reorder that also
        // puts it last (on top of the now-nuked MSE slot).
        this.driver.style.position = '';
        this.driver.style.width = '';
        this.driver.style.height = '';
        this.driver.style.opacity = '';
        this.driver.style.pointerEvents = '';
        const container = this.shadowRoot.querySelector('.ptz-transform');
        if (container) container.appendChild(this.driver);

        // 4. Update UI & notify. Force the spinner off in case a post-swap 'waiting' beats
        // 'playing'.
        const spinner = this.shadowRoot.querySelector('.spinner');
        if (spinner) spinner.style.display = 'none';

        this.setStatus('RTC', this.config.title || '', 'Seamless connection active via WebRTC (Handover Success)');
        this._streamHealthy = true;
        this._unlockHeight();
        this._setActiveMode('rtc');
        this._stopReprobe();
        this._applyPoster();

        // Rebind tools/PTZ to the promoted video (else .ui controls / digital PTZ stay bound to
        // the old, nuked MSE element).
        this.setupTools();

        this.dispatchEvent(new CustomEvent('handover-complete', {
            detail: { mode: 'webrtc', from: 'mse' }
        }));
    }

    /**
     * [SMELL #2] Messages from a driver that is CURRENTLY the pre-swap background shadow probe
     * (`this.shadowDriver === newDriver`). Its rtc_* signals concern its OWN probe WebRTC and
     * must never touch the live main's state. Once _promoteShadowToMain clears shadowDriver,
     * this same driver is routed through _onMainMessage instead (it is then the live main).
     */
    _onPreSwapShadowMessage(newDriver, msg) {
        if (msg.type === 'signal') {
            // [SHADOW-SWAP GATE] The shadow's RTC has now held gaplessly for RTC_SWAP_PROVE_MS —
            // PROVEN durable. THIS is where we swap it in to replace the MSE main (never at the
            // 2s promote in onpcvideo). On a throttled path the shadow stalls before this fires,
            // so we simply never swap and the working MSE main is left untouched.
            if (msg.value === 'rtc_sustained') {
                this._promoteShadowToMain(newDriver);
                return;
            }
            // The probe's RTC gave up before proving durable. Don't leave it lingering until the
            // backstop watchdog (~600s) — reap it now and let the backed-off reprobe loop
            // schedule the next attempt. rtc_rejected (a quality decision) is stable for this
            // connection, so stop reprobing; rtc_failed is a transient failure worth retrying.
            if (msg.value === 'rtc_failed' || msg.value === 'rtc_rejected') {
                // [OBSERVABILITY, v14.6.12] Mirror the shadow probe's revert reason (abort/stall/
                // ICE) to the HA log, same as the main path — otherwise a shadow step-3 abort is
                // invisible (the shadow never touches the visible mode line).
                if (msg.value === 'rtc_failed' && msg.detail) {
                    this._logHA('warning', 'rtc-revert', msg.detail);
                }
                this._nukeDriver(newDriver, 'Unproven Shadow');
                this.shadowDriver = null;
                if (this._shadowTimeout) {
                    clearTimeout(this._shadowTimeout);
                    this._shadowTimeout = null;
                }
                if (msg.value === 'rtc_failed') {
                    this._scheduleReprobe();
                } else {
                    this._stopReprobe();
                }
            }
            return;
        }

        // A hard driver error on the probe: kill it and retry later on backoff.
        if (msg.type === 'error') {
            console.debug(`[WebRTC Camera] Shadow Driver Failed: ${msg.value}. Aborting upgrade.`);
            this._nukeDriver(newDriver, 'Failed Shadow');
            this.shadowDriver = null;
            this.setStatus(null, null, `WebRTC Upgrade Failed: ${msg.value}`);
            this.dispatchEvent(new CustomEvent('shadow-failed', { detail: { error: msg.value } }));
            this._scheduleReprobe();
        }
        // The shadow ignores every other message — it never updates the UI.
    }

    /**
     * [SMELL #2] Messages from the LIVE MAIN driver — either a genuine cold-start main or a
     * shadow that has already swapped in. Owns the visible UI and the main's own reversible RTC
     * signals. (`newDriver` is accepted for symmetry; the main path is global to the card.)
     */
    _onMainMessage(newDriver, msg) {
        if (msg.type === 'signal') {
            if (msg.value === 'rtc_sustained') return; // main already committed via its own flow
            if (msg.value === 'rtc_rejected' || msg.value === 'rtc_failed') {
                // rtc_rejected: WebRTC negotiated but discarded (quality < MSE).
                // rtc_failed:   WebRTC could not deliver — ICE failed, the offer was rejected, or
                //               ICE "connected" but no first frame ever arrived. The driver kept
                //               the MSE stream alive in all cases.
                if (this._upgradeTimer) {
                    clearTimeout(this._upgradeTimer);
                    this._upgradeTimer = null;
                }

                const reason = msg.value === 'rtc_failed'
                    ? 'WebRTC unavailable on this network — staying on MSE'
                    : 'WebRTC upgrade discarded by driver (Quality < MSE)';
                console.debug(`[WebRTC Camera] ${reason}. Cancelling upgrade.`);
                this.setStatus(null, null, reason);

                // [OBSERVABILITY, v14.6.12] Mirror the driver's revert REASON to the HA log. The
                // `mode: rtc -> mse` line that follows says a revert happened but not why; the detail
                // string self-identifies the cause — a step-3 abort ("RTC aborted: pathological
                // path …"), a stall, a firstframe timeout or an ICE drop — so field logs are
                // diagnosable without the client console. Throttled by event name in _logHA.
                if (msg.detail) this._logHA('warning', 'rtc-revert', msg.detail);

                // [RTC RE-PROBE / OPTION 3] rtc_failed means the main's own WebRTC attempt has
                // actually given up: arm the backed-off loop here. rtc_rejected is a deliberate
                // quality decision, stable for this connection — re-probing would only be
                // rejected again, so stop instead.
                if (msg.value === 'rtc_failed') {
                    this._setActiveMode('mse');
                    this._scheduleReprobe();
                } else {
                    this._stopReprobe();
                }
            }
            return;
        }

        // Normal UI logic.
        switch (msg.type) {
            case 'error':
                console.warn(`[WebRTC Camera] Main Driver Error: ${msg.value}`);
                this._logHA('warning', 'driver-error', msg.value);
                // Show a localized generic to the user; keep the raw reason in the console (above)
                // and the tooltip. The raw strings ("no route to host", "i/o timeout") are noise
                // on-screen and, arriving in bursts on a flaky path, made the status flicker.
                this.setStatus(this._t('error'), this._t('reconnecting'), msg.value);
                // [RESILIENCE] An unreachable source (e.g. "no route to host") is reported as an
                // error frame while the socket stays open, so no 'connection-closed' fires. Retry
                // only if the stream never came up: on an already-healthy stream this is a
                // non-fatal per-mode error (e.g. a failed webrtc/offer while MSE plays) and must
                // NOT tear it down — a genuine mid-stream freeze is caught by the no-data watchdog.
                if (!this._streamHealthy) this._scheduleRetry();
                break;
            case 'mse':
                console.debug('[WebRTC Camera] Main Driver negotiated: MSE');
                this.setStatus(msg.type.toUpperCase(), this.config.title || '', 'Stream via MSE (TCP)');
                // [OPTION 3] Settle on MSE and do nothing else. The parallel WebRTC attempt from
                // onopen is still running on this same connection, bounded by the driver's
                // first-frame watchdog, and will either promote itself (onpcvideo) or emit
                // rtc_failed. A WebRTC retry is meaningful only once the main's attempt has
                // failed, so the re-probe loop is armed from rtc_failed, never from an MSE land.
                this._setActiveMode('mse');
                if (this._upgradeTimer) { clearTimeout(this._upgradeTimer); this._upgradeTimer = null; }
            // falls through: MSE shares the tail below (reset _retryCount). The shared block is
            // guarded by `msg.type !== 'mse'` so the "negotiated" log is skipped for MSE. Do NOT
            // add a `break` here.
            case 'hls':
            case 'mp4':
            case 'mjpeg':
            case 'webrtc':
                if (msg.type !== 'mse') {
                    console.debug(`[WebRTC Camera] Main Driver negotiated: ${msg.type.toUpperCase()}`);
                    // [PHANTOM FIX] If we upgraded to WebRTC (or anything better than MSE), cancel
                    // the pending shadow upgrade immediately.
                    if (this._upgradeTimer) {
                        console.debug('[WebRTC Camera] Spontaneous upgrade detected. Canceling shadow schedule.');
                        clearTimeout(this._upgradeTimer);
                        this._upgradeTimer = null;
                    }
                    this.setStatus(msg.type.toUpperCase(), this.config.title || '',
                        msg.type === 'webrtc' ? 'Connected via WebRTC (Low Latency)' : '');
                }
                // [B1] streamHealthy=true now, but the backoff reset is deferred until this
                // stream survives probation (_markHealthy) — a land that dies in 5-14s must not
                // keep restarting the retry backoff at 1000ms.
                this._markHealthy();
                // A real media mode is on screen: release any retry height-lock (the new stream
                // now sizes the card) and log the recovery.
                this._unlockHeight();
                this._logHA('debug', 'stream-up', msg.type);
                break;
        }
    }

    // [RESILIENCE] Attach the main driver's connection-closed → global retry handler.
    // The exact listener reference is stored ON the driver (`_connClosedHandler`) — NOT in a
    // single shared card field — so _nukeDriver always removes the right one no matter the call
    // order. The previous shared-field design was correct only because nuke-before-reassign
    // happened to hold; storing per-driver makes removal self-consistent by construction.
    // Pre-swap shadows never get this handler (they must fail silently).
    _attachMainConnClosed(driver) {
        const handler = (e) => {
            const reason = (e && e.detail && e.detail.reason) || 'closed';
            console.warn(`[WebRTC Camera] Main Driver Connection Closed (${reason})`);
            this._logHA('warning', 'connection-closed', reason);
            this._scheduleRetry();
        };
        driver._connClosedHandler = handler;
        driver.addEventListener('connection-closed', handler);
    }

    _nukeDriver(driverRef, label) {
        if (!driverRef) return;

        if (label) console.debug(`[WebRTC Camera] Nuking driver: ${label}`);

        // [CRITICAL] Cleanup watchdog if we are killing the shadow driver.
        // Failing to do so might cause the timer to kill a future valid driver.
        if (driverRef === this.shadowDriver && this._shadowTimeout) {
            clearTimeout(this._shadowTimeout);
            this._shadowTimeout = null;
        }

        // Remove THIS driver's own connection-closed listener (stored on the driver), so
        // removal never depends on a shared card field that may have been reassigned.
        if (driverRef._connClosedHandler) {
            driverRef.removeEventListener('connection-closed', driverRef._connClosedHandler);
            driverRef._connClosedHandler = null;
        }

        // Break callbacks
        driverRef.onmessage = () => {};
        driverRef.onpcvideo = () => {};
        driverRef.ondata = () => {};
        
        if (typeof driverRef.ondisconnect === 'function') {
            driverRef.ondisconnect();
        }
        driverRef.remove();
    }

    _cleanupDriver() {
        /**
         * HARD DRIVER TEARDOWN (CRITICAL)
         *
         * WHY THIS IS AGGRESSIVE:
         * - Browsers may keep internal references to video decoders, tracks,
         * peer connections and event listeners even after DOM removal.
         * - Failing to explicitly break these references causes memory to grow
         * across reconnects and page changes.
         *
         * This method intentionally:
         * - removes event listeners
         * - nullifies callbacks
         * - calls driver-level cleanup hooks
         * - removes the element from the DOM
         *
         * Do NOT weaken this logic.
         * Memory stability depends on this exact behavior.
         */
        
        // [SEAMLESS HANDOVER] Cleanup both Active and Shadow drivers
        if (this.driver) {
            this._nukeDriver(this.driver, 'Main');
            this.driver = null;
        }
        
        if (this.shadowDriver) {
            console.debug('[WebRTC Camera] Cleaning up Shadow Driver');
            this._nukeDriver(this.shadowDriver, 'Shadow');
            this.shadowDriver = null;
        }
    }

    // [MEMORY FIX] Helper to clean up DigitalPTZ instance
    _cleanupPTZ() {
        if (this.digitalPTZ) {
            // Check if destroy exists to be safe and call it to remove listeners
            if (typeof this.digitalPTZ.destroy === 'function') {
                this.digitalPTZ.destroy();
            }
            this.digitalPTZ = null;
        }
    }

    _scheduleRetry() {
        /**
         * Exponential backoff exists to:
         * - avoid hammering the server
         * - avoid spawning multiple drivers
         * - give the browser time to release resources
         */
        // [RETRY LATCH FIX] Guard BEFORE touching the timer. A retry is already armed and counting
        // down; a burst of further errors from the same dying driver (mse-fail → webrtc/offer-fail →
        // ws-close all fire within a few ms) must NOT disturb it. The old order cleared _retryTimer
        // FIRST and then bailed on _isReconnecting — cancelling the armed retry without rescheduling,
        // so the reconnect latched dead forever (_isReconnecting only clears inside the timer
        // callback, which then never runs). When _isReconnecting is false no timer is pending anyway
        // (it already fired and cleared the flag), so the top-level clear only ever hit the case we
        // must preserve. Guard first; the pending retry survives the burst.
        if (this._isReconnecting) return;
        if (this._retryTimer) clearTimeout(this._retryTimer);

        // [A0/B1] Classify this teardown while the health state is still intact (before the
        // _streamHealthy=false below). A stream that CAME UP and then died WITHIN probation
        // (_healthyTimer still armed) is a "flap" — the constrained-link RTC-starvation signature
        // — and feeds the decaying suppression score. A stream that never came up, or that died
        // AFTER probation confirmed it healthy, is an ordinary reconnect and does NOT accuse RTC.
        // Placed after the _isReconnecting guard so an error-burst from one dying driver counts
        // once (the timer is cleared here; burst repeats return at the guard above).
        if (this._streamHealthy && this._healthyTimer) this._noteRtcFlap();
        if (this._healthyTimer) { clearTimeout(this._healthyTimer); this._healthyTimer = null; }

        // [LAYOUT] Freeze the current card height BEFORE the driver is torn down, so the video
        // area does not collapse during the retry gap and trigger a section-wide re-pack. The
        // <video> is still sized here (frozen last frame); released once a new mode comes up.
        this._lockHeight();

        // [D1 FREEZE-FRAME] Same instant, same reason the <video> is still live here: grab its last
        // decoded frame so the reconnect gap shows that frame (as the new driver's poster) instead
        // of a black box with a play glyph. Must run before _cleanupDriver() removes the element.
        this._captureFreezeFrame();

        this._isReconnecting = true;
        this._streamHealthy = false;
        // [RTC RE-PROBE] The driver is being torn down and cold-restarted; a fresh
        // negotiation re-arms the loop from scratch, so drop the stale backoff now.
        this._stopReprobe();
        this._setActiveMode(null);

        // [B / anti-lockstep] Cameras mounted together die together on a congested
        // link and, with a purely deterministic backoff, re-fire in lockstep:
        // identical delays -> simultaneous keyframe bursts -> the same congestion
        // spike that killed them recurs -> collapse. It self-synchronizes and never
        // breaks on its own (observed: 4x MSE-only on weak 4G, all four flapping in
        // step). Two changes break the cycle:
        //   - floor (RETRY_FLOOR_MS): never retry faster than this, so a congested
        //     link gets breathing room instead of a 1s hammer on the first death.
        //   - decorrelating jitter: spread each camera's delay across 60-140% of its
        //     target so the fleet de-syncs after the first collision.
        // The exponential is capped BELOW the 30s hard ceiling so jitter still has
        // room to spread near the top; a cap applied AFTER jitter would re-collapse
        // every camera onto exactly 30000 and re-synchronize them.
        const RETRY_FLOOR_MS = 2000;
        const RETRY_CAP_MS   = 30000;
        const backoff = Math.min(1000 * Math.pow(2, this._retryCount), 20000);
        const target  = Math.max(backoff, RETRY_FLOOR_MS);
        const delay   = Math.round(
            Math.min(target * (0.6 + Math.random() * 0.8), RETRY_CAP_MS)
        );

        console.debug(`[WebRTC Camera] Scheduling retry in ${delay}ms`);
        this._logHA('debug', 'retry', `attempt #${this._retryCount + 1} in ${delay}ms`);

        this._retryTimer = setTimeout(() => {
            this._retryCount++;
            this._isReconnecting = false;
            // The previous driver is dead. Drop it explicitly so startStream()
            // does a clean cold start instead of mistaking the stale driver for a
            // live one and launching a shadow probe (which would never revive it).
            this._cleanupDriver();
            this.startStream();
        }, delay);
    }

    // [RTC RE-PROBE] Arm the next periodic upgrade attempt, backing off each time.
    // Idempotent: a second call while a probe is already armed is a no-op, so the
    // various failure paths can all call this without stacking timers.
    _scheduleReprobe() {
        if (this.config && this.config.rtc_reprobe === false) return; // opt-out
        if (this._rtcSuppressed) return;                              // [A0] narrow-link latch: no RTC probes
        if (this._reprobeTimer) return;                               // already armed
        const mode = (this.config && this.config.mode) || '';
        if (mode.indexOf('webrtc') < 0) return;                       // WebRTC not wanted

        const base = (this.config && this.config.rtc_reprobe_base) || 30000;
        const max  = (this.config && this.config.rtc_reprobe_max)  || 600000;
        this._reprobeDelay = this._reprobeDelay
            ? Math.min(this._reprobeDelay * 2, max)
            : base;

        console.debug(`[WebRTC Camera] RTC re-probe armed in ${this._reprobeDelay}ms`);
        this._reprobeTimer = setTimeout(() => {
            this._reprobeTimer = null;
            this._attemptReprobe();
        }, this._reprobeDelay);
    }

    // [RTC RE-PROBE] Fire one background upgrade attempt if conditions still hold.
    _attemptReprobe() {
        // Settled non-MSE state (already upgraded, or stream gone) ends the loop by
        // NOT rescheduling. Transient blockers (paused, reconnecting, a probe already
        // in flight) reschedule so we retry once they clear.
        if (!this._hass || !this.config || !this.shadowRoot) return;
        if (this._activeMode !== 'mse' || !this.driver) return; // upgraded/not streaming -> stop
        if (this._paused || this._isReconnecting) { this._scheduleReprobe(); return; }
        if (this.shadowDriver) { this._scheduleReprobe(); return; } // a probe is already running

        console.debug('[WebRTC Camera] Periodic RTC re-probe: launching background shadow upgrade');
        // startStream() sees the live main driver and runs the shadow path. On success
        // the swap sets _activeMode='rtc' and stops the loop; every failure path
        // (shadow error / timeout / auth) re-arms _scheduleReprobe().
        this.startStream();
    }

    // [RTC RE-PROBE] Stop the loop and reset the backoff (upgrade succeeded, or teardown).
    _stopReprobe() {
        if (this._reprobeTimer) { clearTimeout(this._reprobeTimer); this._reprobeTimer = null; }
        this._reprobeDelay = 0;
    }

    // ─── [A0/B1] Narrow-link RTC suppression ────────────────────────────────────────────────
    //
    // [B1] Called at every media land (direct RTC, or MSE/other). Marks the stream up NOW so the
    // rest of the state machine (error gating, connection-closed retry) behaves as before, but
    // WITHHOLDS the retry-backoff reset until the stream proves it can SURVIVE STREAM_PROBATION_MS.
    // The mobile storm signature is a stream that lands then dies in 5-14s: resetting _retryCount
    // on every such land pinned the backoff at 1000ms and hammered the server. Now only a stream
    // that outlives probation resets the counter (and relaxes the flap score by a whole point — a
    // clean stretch is positive evidence the link is fine).
    _markHealthy() {
        this._streamHealthy = true;
        this._streamUpAt = Date.now();
        if (this._healthyTimer) clearTimeout(this._healthyTimer);
        this._healthyTimer = setTimeout(() => {
            this._healthyTimer = null;
            this._retryCount = 0;
            this._decayFlap(1);
            this._logHA('debug', 'stream-stable', `healthy ${Math.round(this.STREAM_PROBATION_MS / 1000)}s`);
        }, this.STREAM_PROBATION_MS);
    }

    // [A0] Age the flap score toward zero by the wall-clock time since the last flap/decay, then
    // optionally subtract `extra` whole points. Linear decay keeps the maths trivial and auditable.
    _decayFlap(extra) {
        const now = Date.now();
        if (this._flapLast) {
            const decayed = (now - this._flapLast) / this.FLAP_DECAY_MS;
            this._flapScore = Math.max(0, this._flapScore - decayed);
        }
        this._flapLast = now;
        if (extra) this._flapScore = Math.max(0, this._flapScore - extra);
    }

    // [A0] Record one flap (a stream that landed then died within probation) and latch MSE-only
    // once the decaying score crosses FLAP_SUPPRESS_AT. Latching stops the re-probe loop so no
    // shadow RTC probe launches; the mode strip in startStream() handles the main driver.
    _noteRtcFlap() {
        if (this.config && this.config.rtc_adaptive === false) return; // opt-out: never suppress
        this._decayFlap(0);            // age to now …
        // Severity: if a FRESH metrics sample just before this death read high loss, the link is
        // provably narrow — weigh the flap a full threshold so it latches on the first such death
        // instead of waiting for 3 to accumulate (which they never do, one-per-burst per camera).
        const lossFresh = this._lastLossAt && (Date.now() - this._lastLossAt) <= this.LOSS_FRESH_MS;
        const severe = lossFresh && this._lastLossPct >= this.FLAP_LOSS_PCT;
        this._flapScore += severe ? this.FLAP_SUPPRESS_AT : 1;
        this._flapLast = Date.now();
        this._logHA('debug', 'rtc-flap',
            `score=${this._flapScore.toFixed(1)}/${this.FLAP_SUPPRESS_AT}` +
            (severe ? ` (loss ${this._lastLossPct.toFixed(0)}%)` : ''));
        if (!this._rtcSuppressed && this._flapScore >= this.FLAP_SUPPRESS_AT) {
            this._rtcSuppressed = true;
            this._rtcSuppressedAt = Date.now();
            this._stopReprobe();       // no background RTC probes while suppressed
            const why = severe ? `loss ${this._lastLossPct.toFixed(0)}%` : `${this._flapScore.toFixed(1)} flaps`;
            this._logHA('warning', 'rtc-suppressed',
                `link narrow (${why}) — MSE-only, re-test in ${Math.round(this.RTC_RETEST_MS / 1000)}s`);
        }
    }

    // [A0] Release the MSE-only latch once it has held RTC_RETEST_MS, so a link that has since
    // recovered can earn RTC back. Called lazily before each (re)build: no standing timer, and a
    // happy MSE-only stream that never reconnects is deliberately left undisturbed (MSE-only is
    // fully watchable — the whole point of the latch — so RTC is re-tested opportunistically on
    // the next cold start rather than by tearing down a working picture).
    _maybeExpireSuppression() {
        if (!this._rtcSuppressed) return;
        if (Date.now() - this._rtcSuppressedAt < this.RTC_RETEST_MS) return;
        this._rtcSuppressed = false;
        this._flapScore = 0;
        this._flapLast = 0;
        this._logHA('debug', 'rtc-retest', 'suppression window elapsed — re-testing full mode');
    }

    // [A0] Remove 'webrtc' from a mode list, never yielding an empty mode.
    _stripWebrtc(mode) {
        const kept = String(mode || 'webrtc,mse,hls,mjpeg')
            .split(',').map(s => s.trim()).filter(m => m && m !== 'webrtc');
        return kept.length ? kept.join(',') : 'mse';
    }

    /**
     * [SMELL #3] Single write-point for `_activeMode` — the card's advisory cache of the MAIN
     * driver's negotiated transport ('mse' | 'rtc' | null). Mirrors the driver's _setPhase():
     * one auditable place, free observability (logs on change).
     *
     * WHY a cache and NOT derived from the driver's `_rtcPhase` (deliberate — do not "simplify"):
     *   - It is read in exactly ONE place that matters — the re-probe gate in _attemptReprobe()
     *     (`_activeMode !== 'mse'` stops the loop). It answers the CARD's question "should I keep
     *     probing for an upgrade?", which is NOT the driver's phase:
     *       • 'mse' deliberately covers BOTH driver phases 'warm' AND 'negotiating' — while the
     *         main is still attempting its own parallel RTC we keep the loop armed.
     *       • 'rtc' means the card ACCEPTED an RTC transport (quality gate passed at promote, or a
     *         proven shadow swapped in) — a card-level decision distinct from `_rtcPhase`.
     *     Collapsing it into `_rtcPhase` would lose information and change re-probe behaviour.
     *   See memory `webrtc-fsm-maintainability` (smell #3) and `webrtc-v1425-field-validation`.
     *
     * Intentionally a plain cache: no invariant enforcement, just a transition log.
     */
    _setActiveMode(mode) {
        if (this._activeMode === mode) return;
        console.debug(`[WebRTC Camera] activeMode ${this._activeMode} -> ${mode}`);
        // [FIELD VISIBILITY] This is the SINGLE choke-point for every mode transition —
        // initial land, shadow swap (_promoteShadowToMain), direct-RTC (onpcvideo), and any
        // RTC→MSE revert. `stream-up` (:774) only fires on the initial ui_sync land, so on the
        // HA Companion apps (no console) the fork's defining MSE→RTC upgrade and its reverts were
        // otherwise invisible. Mirror the transition here so the app log can answer "did this
        // camera reach RTC / fall back?". Rare (once per upgrade/revert) → negligible SD cost.
        this._logHA('debug', 'mode', `${this._activeMode ?? 'none'} -> ${mode ?? 'none'}`);
        this._activeMode = mode;
    }

    // [HARD RESET] Manually triggered by refresh button.
    // Cleans everything and restarts from scratch (Cold Start).
    hardReset() {
        console.info('[WebRTC Camera] Hard Reset Triggered');
        
        // 1. Kill timers
        if (this._retryTimer) clearTimeout(this._retryTimer);
        if (this._upgradeTimer) clearTimeout(this._upgradeTimer);
        if (this._shadowTimeout) clearTimeout(this._shadowTimeout);
        this._stopReprobe(); // [RTC RE-PROBE] reset the loop on manual refresh
        this._setActiveMode(null);

        // 2. Kill drivers
        this._cleanupDriver();
        
        // 3. Kill PTZ
        this._cleanupPTZ();
        
        // 4. Reset State
        this._isReconnecting = false;
        this._retryCount = 0;
        this._shadowAttempts = 0;
        // [A0/B1] Manual refresh = explicit fresh start: drop the probation timer and clear the
        // narrow-link latch so this restart re-tests full RTC mode from scratch.
        if (this._healthyTimer) { clearTimeout(this._healthyTimer); this._healthyTimer = null; }
        this._rtcSuppressed = false;
        this._flapScore = 0;
        this._flapLast = 0;
        this._lastLossPct = 0;
        this._lastLossAt = 0;

        // 5. Force UI Feedback
        const spinner = this.shadowRoot.querySelector('.spinner');
        if (spinner) spinner.style.display = 'block';
        
        // 6. Restart
        this.startStream();
    }

    async startStream() {
        if (!this._hass || !this.config) return;
        // [AUTO-PAUSE] Never start (or resurrect) a stream while paused off-screen.
        if (this._paused) return;

        // [A0] Lazily release the MSE-only latch if its re-test window has elapsed, so THIS build
        // gets full mode again and can earn RTC back on a recovered link.
        this._maybeExpireSuppression();

        // [HA ICE COLD-START GATE (#923)] On a COLD start only, make sure HA's ICE servers
        // are resolved before we build the first driver, so its own reversible RTC can use
        // the Nabu Casa TURN from t=0. Shadow/reprobe/reconnect starts skip this — by then
        // `_haIceServers` is already resolved (cached). The await opens a window where
        // `this.driver` is still null and more `set hass` ticks could re-enter, so latch it.
        const coldStart = !this.driver && !this._isReconnecting;
        if (coldStart && !this._haIceReady) {
            if (this._coldStartInFlight) return;   // a cold start is already awaiting — coalesce
            this._coldStartInFlight = true;
            try {
                await this._ensureHaIceReady();    // ~10ms typical; 300ms-bounded; fail-soft
            } finally {
                this._coldStartInFlight = false;
            }
            // State may have changed across the await: the card could have been detached
            // (view switch — never resurrect it), paused, or torn down. Re-validate before
            // building. If a driver appeared meanwhile the latch was bypassed — bail.
            if (!this.isConnected || this._paused || !this._hass || !this.config || this.driver) return;
        }

        // Resolve the effective stream configuration.
        // Stream-specific overrides are merged here only.
        const currentStream = this.config.streams[this.streamID] || {};
        // [B / url_fullscreen] While a fullscreen hi-res swap is active, `_fsStreamOverride`
        // forces the high-res `url` on top of the normal stream so the SAME driver machinery
        // (mode/RTC/tunables/adaptive watchdog) runs against the main stream. Cleared on exit.
        const effectiveConfig = {...this.config, ...currentStream, ...(this._fsStreamOverride || {})};

        // [SEAMLESS HANDOVER] Decision Logic
        // If we already have a working driver (this.driver), we are initiating a "Shadow Upgrade".
        // If we don't, it's a "Cold Start".
        const isShadowMode = !!this.driver && !this._isReconnecting;

        if (!isShadowMode) {
            console.debug('[WebRTC Camera] Cold Start: Initializing Main Driver');
            this._streamHealthy = false;
            // [RTC RE-PROBE] Fresh connection: drop any stale re-probe loop/backoff so
            // this negotiation starts clean. The loop re-arms once we settle on MSE.
            this._stopReprobe();
            this._setActiveMode(null);
            this.setStatus('Loading..');
            // UX Spinner: Show immediately to cover Auth/WS handshake latency.
            const spinner = this.shadowRoot.querySelector('.spinner');
            if (spinner) spinner.style.display = 'block';

            // Always destroy any previous driver before creating a new one.
            this._cleanupDriver();
        } else {
            console.debug(`[WebRTC Camera] Seamless Handover: Launching Shadow Driver (Attempt ${this._shadowAttempts + 1})`);
            // [DIAGNOSTICS] Set tooltip to indicate optimization is running
            this.setStatus(null, null, 'Optimizing connection... (Attempting WebRTC Upgrade)');
            
            // Ensure no leftover shadow driver exists
            if (this.shadowDriver) this._nukeDriver(this.shadowDriver, 'Stale Shadow');
        }

        // Create a fresh driver instance.
        // The driver owns all media/network state.
        const newDriver = document.createElement('video-rtc');
        // [REVERSIBLE HANDOFF] Every driver — cold main AND background shadow — negotiates the
        // full webrtc+mse set and promotes WebRTC REVERSIBLY (keeps its own MSE warm on a 2nd
        // <video>, snaps back on an RTC stall). This makes the shadow a self-protecting driver:
        // when it promotes we swap it in and, if its RTC later stalls, it reverts to ITS OWN
        // warm MSE instead of freezing black. The old webrtc-only shadow, once swapped in, had
        // no MSE fallback and no connection-closed listener, so a stall on a flaky network left
        // it frozen. The extra background MSE stream is acceptable (LAN-side; the constrained
        // camera->go2rtc path carries one feed regardless). The reversible handoff is now the
        // driver's ONLY RTC path (the legacy irreversible branch was removed in driver v2.3.5),
        // so there is no per-driver flag to set here any more.
        // [A0] Under the narrow-link latch, strip 'webrtc' so this driver is MSE-only: the
        // reversible RTC negotiation + MSE keep-warm is the additive load proven to starve MSE on
        // constrained mobile (MSE-only 4G holds ~550KB/s, 0 watchdog trips; RTC-on 4G never
        // promotes, 20-59% loss, MSE dies <5s → storm). The latch is card state so it holds across
        // driver churn; it clears itself after RTC_RETEST_MS. Fat links never reach the latch.
        newDriver.mode = this._rtcSuppressed
            ? this._stripWebrtc(effectiveConfig.mode)
            : effectiveConfig.mode;
        newDriver.media = effectiveConfig.media;

        // [ICE SERVERS] Optional browser-side ICE servers on THIS RTCPeerConnection.
        // pcConfig lives on the (disposable) driver, so inject here — every driver, cold
        // main AND shadow, gets it. Three-level precedence, most specific wins:
        //   1. per-card `ice_servers` (#952) — REPLACES everything, incl. `[]` opt-out.
        //   2. HA native ICE (#923) — the user's `webrtc:` config + Nabu Casa/Homeway TURN,
        //      fetched once via `web_rtc/ice_servers`. The only path to rotating cloud TURN.
        //   3. built-in 2×STUN default (#915) — kept if neither of the above applies.
        // Accepts the standard RTCIceServer shape ({urls, username, credential}) or a bare
        // string / array of strings.
        const rawIce = effectiveConfig.ice_servers;
        const perCard = this._normalizeIceServers(rawIce);
        // The user CONFIGURED `ice_servers` but it parsed to nothing (non-empty input, all entries
        // malformed → `_normalizeIceServers` returns null via its typo-guard). That's a user
        // misconfiguration silently dropped — surface it at `warning` (default-visible, unlike the
        // `debug` mirror below), so a fat-fingered STUN/TURN URL is diagnosable. `[]` (opt-out) is
        // NOT flagged: it yields `perCard = []`, a deliberate, valid choice.
        const iceConfigured = rawIce != null && rawIce !== '' &&
            !(Array.isArray(rawIce) && rawIce.length === 0);
        if (iceConfigured && perCard === null) {
            this._logHA('warning', 'ice-config', 'ice_servers has no valid entries — ignored, using default');
        }
        const iceServers = perCard !== null ? perCard : this._haIceServers;
        if (iceServers != null) {   // null/undefined → keep default; [] (opt-out) or list → replace
            newDriver.pcConfig = Object.assign({}, newDriver.pcConfig, {iceServers});
        }
        // Mirror the RESOLVED ICE source on this pc, so the CGNAT/Nabu-Casa path #923 targets is
        // diagnosable from the HA log (matches the `mode` mirror). `debug` + throttled by event
        // name; detail is low-cardinality (source + count).
        const iceSrc = perCard !== null
            ? (perCard.length ? `per-card (${perCard.length})` : 'per-card (opt-out)')
            : (this._haIceServers ? `ha-native (${this._haIceServers.length})` : 'default (2×STUN)');
        this._logHA('debug', 'ice', iceSrc);

        // [TUNABLES] Optional per-card overrides for the reversible-RTC timing knobs; defaults
        // live in the driver constructor. Accept only sane positive numbers, else keep default.
        const proveMs = Number(effectiveConfig.rtc_swap_prove_ms);
        if (Number.isFinite(proveMs) && proveMs > 0) newDriver.RTC_SWAP_PROVE_MS = proveMs;
        const firstFrameMs = Number(effectiveConfig.firstframe_timeout);
        if (Number.isFinite(firstFrameMs) && firstFrameMs > 0) newDriver.FIRSTFRAME_TIMEOUT = firstFrameMs;
        // [TUNABLE] MSE no-data watchdog (ms). Fed by binary WS bytes = MSE liveness ONLY, so this
        // is how long a stalled MSE stream is tolerated before a teardown+cold-restart. Default 5s
        // is aggressive on lossy 4G — a transient TCP stall self-recovers, but the watchdog kills
        // it first, turning a recoverable pause into a reconnect storm. Raise it (e.g. 12000) so
        // mobile links ride out stalls. Unlike the knobs above, 0 is meaningful here: it EXPLICITLY
        // disables the watchdog (never tear down on silence — the driver guards `if (!DISCONNECT_
        // TIMEOUT) return`), so accept >= 0. Read live in `_feedWatchdog`; changing per-card YAML
        // takes effect on a card reload, no driver pin bump / service-worker hard reload needed.
        const mseTimeout = Number(effectiveConfig.mse_timeout);
        if (Number.isFinite(mseTimeout) && mseTimeout >= 0) newDriver.DISCONNECT_TIMEOUT = mseTimeout;
        // [TUNABLE] Adaptive MSE watchdog (Strato-1, driver v2.5.0). The watchdog above self-adapts:
        // it EXTENDS (never shortens) up to `mse_adapt_max_extend`× the base while an RTC probe is
        // congesting the warm MSE, driven by rttExcess/loss. These knobs exist for tuning even
        // though the loop auto-adapts; the driver defaults are sane. `mse_adaptive: false` pins the
        // classic fixed watchdog. Driver change → served under the bumped ?v=2.5.0 pin.
        if (effectiveConfig.mse_adaptive !== undefined) {
            newDriver.ADAPTIVE_WATCHDOG = effectiveConfig.mse_adaptive !== false;
        }
        const adaptRttExcess = Number(effectiveConfig.mse_adapt_rtt_excess);
        if (Number.isFinite(adaptRttExcess) && adaptRttExcess > 0) newDriver.ADAPT_RTT_EXCESS_MS = adaptRttExcess;
        const adaptLoss = Number(effectiveConfig.mse_adapt_loss);
        if (Number.isFinite(adaptLoss) && adaptLoss > 0) newDriver.ADAPT_LOSS_PCT = adaptLoss;
        const adaptMaxExtend = Number(effectiveConfig.mse_adapt_max_extend);
        if (Number.isFinite(adaptMaxExtend) && adaptMaxExtend >= 1) newDriver.ADAPT_MAX_EXTEND = adaptMaxExtend;
        const adaptAlpha = Number(effectiveConfig.mse_adapt_alpha);
        if (Number.isFinite(adaptAlpha) && adaptAlpha > 0 && adaptAlpha <= 1) newDriver.ADAPT_EWMA_ALPHA = adaptAlpha;
        // [TUNABLE] RTC abort (Alg.3, driver v2.9.0). Gives up a non-committing RTC probe once the
        // band verdict (Alg.1) integrates enough sustained-bad time (`mse_abort_hold` ms, shortened by
        // futility) — a deterministic teardown instead of babying it via the adaptive extend. The band
        // verdict already folds BOTH rttExcess and loss, so the former blind jbuf/RTT ceiling knobs
        // (`mse_abort_jbuf`/`mse_abort_rtt`) are RETIRED — the internal band thresholds are the tuning
        // surface now. `mse_abort: false` pins the classic (extend-only) behaviour.
        if (effectiveConfig.mse_abort !== undefined) {
            newDriver.RTC_ABORT_ENABLED = effectiveConfig.mse_abort !== false;
        }
        const abortHold = Number(effectiveConfig.mse_abort_hold);
        if (Number.isFinite(abortHold) && abortHold > 0) newDriver.RTC_ABORT_HOLD_MS = abortHold;
        const abortFutilityK = Number(effectiveConfig.mse_abort_futility_k);
        if (Number.isFinite(abortFutilityK) && abortFutilityK >= 0 && abortFutilityK <= 1) newDriver.RTC_ABORT_FUTILITY_K = abortFutilityK;

        // Network strict mode propagates directly to the driver.
        newDriver.strictMode =
            effectiveConfig.network_strict !== undefined
                ? effectiveConfig.network_strict
                : this.config.network_strict;

        // Any unexpected connection close triggers a controlled retry.
        // [SEAMLESS HANDOVER] Only main driver triggers global retry. Shadow driver just dies silently.
        if (!isShadowMode) {
            this._attachMainConnClosed(newDriver);
        }

        // Driver → UI messaging is intentionally minimal; the driver never touches the UI.
        //
        // [SMELL #2 FIX, v14.2.6] The three driver signals (rtc_sustained / rtc_failed /
        // rtc_rejected) are OVERLOADED — the same name means opposite things for a background
        // shadow probe vs the live main. This used to be disambiguated inside one handler purely
        // by branch order plus a fragile "never fall through" convention. We now hard-dispatch on
        // the receiver's role, so a shadow's message can NEVER be processed as a main's.
        //
        // Discriminator = the RUNTIME predicate `this.shadowDriver === newDriver`, NOT the
        // construction-time `isShadowMode`: a shadow that swaps in keeps its shadow-built closure
        // but is thereafter the live main (shadowDriver is cleared in _promoteShadowToMain), so
        // from that point its messages must be handled as a main's. Using the runtime predicate
        // also corrects a latent case — a post-swap driver emitting an 'error' now takes the main
        // error path (keep a healthy stream) instead of the shadow path (self-nuke as "Failed
        // Shadow" without a proper retry).
        newDriver.onmessage = {
            ui_sync: (msg) => {
                // [BW INSTRUMENTATION] Metric lines are diagnostic and driver-cadence-gated (3s);
                // route them straight to the HA log for BOTH main and shadow probes (a shadow's
                // RTT/loss is exactly the bandwidth probe we want to see).
                if (msg.type === 'metrics') {
                    // [A0] Harvest loss% for the severity trigger. The value is a preformatted
                    // string (`… loss=X.X% …`); a defensive regex avoids a driver change (pin bump).
                    const m = /loss=([\d.]+)%/.exec(msg.value);
                    if (m) { this._lastLossPct = parseFloat(m[1]); this._lastLossAt = Date.now(); }
                    // [net dot] Harvest the band verdict for the network-state indicator (opt-in).
                    const b = /band=(perf|degr|path)/.exec(msg.value);
                    if (b) { this._lastBand = b[1]; this._lastBandAt = Date.now(); this._paintNetDot(); }
                    this._logHA('debug', 'metrics', msg.value);
                    return;
                }
                return this.shadowDriver === newDriver
                    ? this._onPreSwapShadowMessage(newDriver, msg)
                    : this._onMainMessage(newDriver, msg);
            },
        };

        // WebRTC success resets retry logic and updates UI.
        const originalOnPcVideo = newDriver.onpcvideo;
        newDriver.onpcvideo = (video) => {
            if (typeof originalOnPcVideo === 'function') {
                originalOnPcVideo.call(newDriver, video);
            }
            
            // FIX: Only update UI to 'RTC' if the driver actually accepted the stream.
            if (newDriver.pc) {
                
                // [PHANTOM FIX] Also cancel upgrade timer here if spontaneous WebRTC happens
                if (this._upgradeTimer) {
                    clearTimeout(this._upgradeTimer);
                    this._upgradeTimer = null;
                }

                // [SEAMLESS HANDOVER] A background shadow PROMOTES its RTC at ~2s (reversible),
                // but we must NOT swap here: promotion only proves RTC can start, not that it can
                // SUSTAIN. Swapping now would nuke the working MSE main for a replacement that, on
                // a throttled/bursty path, stalls seconds later (and whose own warm MSE may not
                // even be healthy) → black screen + endless swap churn. Instead we keep the proven
                // main visible and wait for the shadow's `rtc_sustained` signal (RTC held gaplessly
                // for RTC_SWAP_PROVE_MS) — handled in the ui_sync signal block, which then calls
                // _promoteShadowToMain(). So a pre-swap shadow's promote is a no-op here.
                if (isShadowMode && this.shadowDriver === newDriver) {
                    return;
                }

                console.debug('[WebRTC Camera] Main Driver negotiated WebRTC directly.');
                this.setStatus('RTC', this.config.title || '', 'Connected via WebRTC (Direct)');
                // [B1] Defer the backoff reset to probation; direct RTC that sustains >20s resets
                // the counter and relaxes the flap score, direct RTC that dies fast counts as a flap.
                this._markHealthy();
                this._unlockHeight();
                this._shadowAttempts = 0;
                // [ORPHAN FIX] The main upgraded to WebRTC on its own while a shadow
                // probe was still in flight (launched by the 2s _upgradeTimer or by the
                // re-probe loop). _stopReprobe() below only cancels the *timer*; the
                // shadow's already-open WebSocket would otherwise linger as a second
                // go2rtc consumer for a camera that is now on RTC (observed: the MSE/
                // client counter never drops back from 2 to 1 after a direct upgrade).
                // Tear it down here, exactly as the handover-swap branch does. Nuking
                // this.shadowDriver also clears its 15s watchdog (see _nukeDriver).
                if (this.shadowDriver) {
                    this._nukeDriver(this.shadowDriver, 'Orphaned Shadow (main went RTC)');
                    this.shadowDriver = null;
                }
                // [RTC RE-PROBE] Already on WebRTC — no periodic upgrade needed.
                this._setActiveMode('rtc');
                this._stopReprobe();
                this._applyPoster();
            }
        };

        // Inject driver into DOM.
        // [SEAMLESS HANDOVER] Both drivers are injected: the main one visibly, the
        // shadow one hidden (see below). The shadow must be in the DOM to connect at
        // all — the driver gates onconnect() on `isConnected`.
        if (!isShadowMode) {
            const container = this.shadowRoot.querySelector('.ptz-transform');
            if (container) container.appendChild(newDriver);
            this.driver = newDriver;
        } else {
            // [SEAMLESS HANDOVER] The shadow probe MUST be attached to the DOM: the
            // driver's onconnect() bails while `isConnected` is false, and its <video>
            // is created lazily in connectedCallback()->oninit(). A detached shadow can
            // therefore never open its WebSocket, so it always timed out at 15s and the
            // upgrade never happened. Attach it hidden — inline styles override the
            // `video-rtc { width/height:100%; display:block }` rule, and position:absolute
            // pulls it out of the flex flow so it neither resizes nor covers the main
            // picture. Never display:none: that would suspend decoding and stall the probe.
            newDriver.style.position = 'absolute';
            newDriver.style.width = '1px';
            newDriver.style.height = '1px';
            newDriver.style.opacity = '0';
            newDriver.style.pointerEvents = 'none';
            const shadowContainer = this.shadowRoot.querySelector('.ptz-transform');
            if (shadowContainer) shadowContainer.appendChild(newDriver);

            this.shadowDriver = newDriver;

            // [SEAMLESS HANDOVER] Backstop watchdog: kill any shadow that has not been
            // PROMOTED within the driver's first-frame window. A successful promotion nulls
            // this.shadowDriver well before the timer fires, so a shadow still referenced
            // here is stuck.
            //
            // The DRIVER owns first-frame timing (FIRSTFRAME_TIMEOUT): a 'connected' shadow
            // must get the SAME window as the main to decode a slow-but-real first frame and
            // swap (observed to take minutes on repeater paths). A hardcoded short cap here
            // reaped the shadow long before that frame could arrive — the shadow never got
            // the window we agreed on. So track the driver's cap and add a small margin, so
            // the driver's own watchdog is the primary reaper for a 'connected'-but-medialess
            // shadow; this card timer stays a backstop that ALSO covers the case the driver
            // can't (pc stuck in ICE 'checking' forever, no 'connected'/'failed' transition,
            // so the driver's state handler never arms) and drives the reprobe on failure.
            const shadowCap = (newDriver.FIRSTFRAME_TIMEOUT || 120000) + 5000;
            this._shadowTimeout = setTimeout(() => {
                if (this.shadowDriver) {
                    console.debug('[WebRTC Camera] Shadow timeout – killing unpromoted probe');
                    this._nukeDriver(this.shadowDriver, 'Timeout Shadow');
                    this.shadowDriver = null;
                    this._shadowAttempts = 0; // Reset to allow future attempts
                    
                    // [DIAGNOSTICS] Update tooltip
                    this.setStatus(null, null, 'WebRTC Upgrade Failed: Network Timeout');
                    
                    // Notify failure
                    this.dispatchEvent(new CustomEvent('shadow-failed', {
                        detail: { error: 'timeout' }
                    }));

                    // [RTC RE-PROBE] Probe timed out; schedule the next attempt on backoff.
                    this._scheduleReprobe();
                }
            }, shadowCap);
        }

        // Apply global mute synchronously.
        // This avoids autoplay failures caused by async timing.
        if (newDriver.video) {
            newDriver.video.controls = false;
            
            // [SEAMLESS HANDOVER] Apply poster to new driver immediately (including shadow).
            // [D1 FREEZE-FRAME] Prefer the last live frame captured from the dying driver at
            // teardown: it fills the reconnect gap with the real last frame (no black box, no play
            // glyph) until the new stream decodes. One-shot — cleared once applied, so it only ever
            // covers the gap that just opened, and never leaks onto an unrelated later start. Only
            // the Main driver is user-visible; the Shadow negotiates hidden, so it keeps the static
            // poster path. Absent a freeze frame (cold start, or opted out), fall back to any static
            // poster exactly as before.
            if (!isShadowMode && this._freezeFrameUrl) {
                newDriver.video.poster = this._freezeFrameUrl;
                this._freezeFrameUrl = null;
            } else if (this.config.poster) {
                if (this.config.poster_remote) {
                    newDriver.video.poster = this.config.poster;
                } else if (!newDriver.video.poster) {
                    newDriver.video.poster = this.config.poster;
                }
            }

            if (this.config.muted) {
                newDriver.video.muted = true;
                newDriver.video.defaultMuted = true;
                newDriver.video.setAttribute('muted', '');
            } else if (isShadowMode) {
                // Shadow driver MUST be muted to play in background without audio glitch
                console.debug('[WebRTC Camera] Muting Shadow Driver for background negotiation');
                newDriver.video.muted = true;
            }
        }

        // Authenticate and start the connection.
        try {
            // [CRITICAL] Pass the correct driver instance to fetch URL.
            // If we are in shadow mode, we must apply the signed poster/URL to the shadow driver, not Main.
            const url = await this._fetchWebsocketURL(isShadowMode ? newDriver : null);

            // [AUTO-PAUSE] The card may have been paused off-screen while we were
            // awaiting the signed URL. Abandon this connection so we don't leave a
            // live driver running behind a paused card.
            if (this._paused) {
                this._cleanupDriver();
                return;
            }

            // Apply URL to the correct instance
            const target = isShadowMode ? this.shadowDriver : this.driver;
            
            if (target) {
                console.debug(`[WebRTC Camera] Connecting ${isShadowMode ? 'Shadow' : 'Main'} driver to WS`);
                target.src = url;
                if (!isShadowMode) {
                    this.setStatus('Loading...');
                    this.setupTools();
                    this._applyPoster();
                }
            } else {
                console.debug('[WebRTC Camera] Target driver vanished before connection');
            }
        } catch (e) {
            if (!isShadowMode) {
                console.error('[WebRTC Camera] Main Driver Auth Failed', e);
                this.setStatus('Auth Fail', 'Retry...');
                this._scheduleRetry();
            } else {
                console.warn('[WebRTC Camera] Shadow Auth Failed');
                this._nukeDriver(this.shadowDriver, 'Auth Failed Shadow');
                this.shadowDriver = null;

                this.dispatchEvent(new CustomEvent('shadow-failed', {
                    detail: { error: 'auth_failed' }
                }));

                // [RTC RE-PROBE] Auth hiccup on the probe; retry later on backoff.
                this._scheduleReprobe();
            }
        }
    }

    _applyPoster() {
        // Poster application is intentionally deferred and optional.
        // It must never block stream startup.
        
        // Poster Implementation.
        if (this.config.poster &&
            this.driver &&
            this.driver.video) {
            
            // Apply only if remote (trusted) or if local logic allows.
            if (this.config.poster_remote || !this.driver.video.poster) {
                this.driver.video.poster = this.config.poster;
            }
        }
    }

    async _fetchWebsocketURL(targetDriver = null) {
        /**
         * The WebSocket URL is always freshly signed.
         * URLs are never cached to avoid token reuse and invalid sessions.
         */
        const stream = this.config.streams[this.streamID];
        // [B / url_fullscreen] The signed WS URL is the ACTUAL stream the driver dials (target.src
        // below). It MUST honour the fullscreen hi-res override — without this spread the override set
        // by _applyFullscreenStream() reached only newDriver's mode/ice/tunables in startStream(), while
        // the connect URL here stayed on the substream, so the card-path fullscreen never switched to
        // `url_fullscreen` (it always showed the low-res substream, on every platform, not just iOS).
        const effectiveConfig = {...this.config, ...stream, ...(this._fsStreamOverride || {})};

        const data = await this._hass.callWS({
            type: 'auth/sign_path',
            path: '/api/webrtc/ws'
        });

        // [SEAMLESS HANDOVER] Apply poster to specific driver (Main or Shadow) if provided, 
        // otherwise fallback to Main (legacy behavior).
        // This ensures the shadow driver gets the signed poster URL before swap.
        const target = targetDriver || this.driver;

        if (this.config.poster &&
            !this.config.poster_remote &&
            target &&
            target.video) {
            target.video.poster =
                this._hass.hassUrl(data.path) +
                '&poster=' +
                encodeURIComponent(this.config.poster);
        }

        let wsUrl = 'ws' + this._hass.hassUrl(data.path).substring(4);

        if (effectiveConfig.entity) {
            wsUrl += '&entity=' + effectiveConfig.entity;
        } else if (effectiveConfig.url) {
            wsUrl += '&url=' + encodeURIComponent(effectiveConfig.url);
        }

        if (this.config.server) {
            wsUrl += '&server=' + encodeURIComponent(this.config.server);
        }

        // [SESSION ACCOUNTING] Mark shadow probes so the backend counts them in a
        // separate registry (shadow_probes sensor) and keeps the real-client counter
        // clean. targetDriver is non-null only in shadow mode (see caller). Signature
        // is unaffected: auth/sign_path signs the base path, not the query string.
        if (targetDriver) {
            wsUrl += '&role=shadow';
        }

        return wsUrl;
    }

    nextStream() {
        // Stream switching is implemented as a full restart
        // to guarantee a clean media state.
        console.info('[WebRTC Camera] User initiated Next Stream (Soft Handover)');
        this.streamID = (this.streamID + 1) % this.config.streams.length;
        this._retryCount = 0;
        this._shadowAttempts = 0; // Reset shadow attempts
        
        // Reset timers
        if (this._retryTimer) clearTimeout(this._retryTimer);
        if (this._upgradeTimer) clearTimeout(this._upgradeTimer);
        
        this._isReconnecting = false;
        this.startStream();
    }

    renderStructure() {
        // Render UI structure only once.
        if (this.shadowRoot.querySelector('.card')) return;

        this.shadowRoot.innerHTML = `
        <style>
            ha-card {
                width: 100%;
                height: 100%;
                margin: auto;
                overflow: hidden;
                position: relative;
                display: block;
                background: black;
            }
            .player { background-color: black; height: 100%; position: relative; }
            .ptz-transform { height: 100%; display: flex; align-items: center; justify-content: center; }
            .header {
                position: absolute;
                top: 6px;
                left: 10px;
                right: 10px;
                color: white;
                display: flex;
                justify-content: space-between;
                pointer-events: none;
                z-index: 10;
            }
            .right-controls {
                display: flex;
                align-items: center;
                gap: 8px; /* Space between refresh icon and mode text */
                pointer-events: auto;
            }
            .mode { cursor: pointer; opacity: 0.6; }
            .refresh { cursor: pointer; opacity: 0.6; }
            .refresh:hover, .mode:hover { opacity: 1; }

            /* Live indicator (opt-in via live_indicator: true). Red = no fresh
               frames, green = video advancing. Driven by requestVideoFrameCallback
               on the driver's ON-SCREEN element (onscreenVideo: the RTC overlay while
               promoted, else this.video) — UI-only, independent of the driver's
               promotion/first-frame logic. */
            .live-dot {
                width: 8px; height: 8px; border-radius: 50%;
                background-color: #D2122E; align-self: center;
                transition: background-color 0.3s;
            }
            .live-dot.live { background-color: #90EE90; }

            /* Network-state dot (opt-in via network_indicator: true). Mirrors the driver's live band
               classifier: white = no fresh sample (not probing / unknown), green = perf (queue ~empty),
               yellow = degr (mild bufferbloat), red = path (standing queue / lossy). UI-only. */
            .net-dot {
                width: 8px; height: 8px; border-radius: 50%;
                background-color: #FFFFFF; align-self: center;
                transition: background-color 0.3s;
            }
            .net-dot.perf { background-color: #90EE90; }
            .net-dot.degr { background-color: #FFD400; }
            .net-dot.path { background-color: #D2122E; }

            video-rtc { width: 100%; height: 100%; display: block; }
            ha-icon { color: white; cursor: pointer; }
            
            /* [FIX 1/2] Spinner Styles */
            .spinner { 
                position: absolute; 
                top: 50%; 
                left: 50%; 
                transform: translate(-50%, -50%); 
                z-index: 5; 
                display: none; 
                pointer-events: none;
            }
        </style>
        <ha-card class="card">
            <div class="player">
                ${this.config.spinner === false ? '' : '<ha-circular-progress class="spinner"></ha-circular-progress>'}
                <div class="ptz-transform"></div>
            </div>
            <div class="header">
                <div class="status"></div>
                <div class="right-controls">
                    ${this.config.live_indicator === true ? '<div class="live-dot"></div>' : ''}
                    ${this.config.network_indicator === true ? '<div class="net-dot" title="Network state"></div>' : ''}
                    <ha-icon class="refresh" icon="mdi:refresh" title="Hard Reset"></ha-icon>
                    <div class="mode"></div>
                </div>
            </div>
        </ha-card>
        `;

        // Bind Hard Reset to Refresh Icon
        this.shadowRoot
            .querySelector('.refresh')
            .addEventListener('click', (e) => {
                e.stopPropagation(); // Prevent bubbling issues
                this.hardReset();
            });

        // Bind Next Stream (Soft Handover) to Mode Text
        this.shadowRoot
            .querySelector('.mode')
            .addEventListener('click', () => this.nextStream());

        // The interaction sidecar is created/rebuilt by _initSidecar(), invoked
        // from setConfig(), so it can reflect live config changes.
    }

    // [DIAGNOSTICS] Updated to support optional tooltip
    setStatus(mode, status, tooltip) {
        const divMode = this.shadowRoot.querySelector('.mode');
        const divStatus = this.shadowRoot.querySelector('.status');
        
        if (divMode) {
            if (mode) divMode.innerText = mode;
            if (tooltip) {
                divMode.title = tooltip;
            } else if (tooltip === null || mode) {
                // Clear a stale tooltip when explicitly cleared (null), or when a new
                // mode is set without its own tooltip — otherwise the previous state's
                // message (e.g. "Connected via WebRTC") would linger on an error/loading.
                // Tooltip-only updates pass mode=null with a tooltip, so they are preserved.
                divMode.removeAttribute('title');
            }
        }
        
        if (divStatus && status) divStatus.innerText = status;
    }

    setupTools() {
        /**
         * Tools must bind to the CURRENT video element only.
         * Video elements are never reused.
         */
        const checkVideo = () => {
            if (this.driver && this.driver.video) {
                this.driver.video.controls = false;

                if (this.config.muted) {
                    this.driver.video.muted = true;
                }

                // [MEMORY FIX] Clean up any existing PTZ instance before creating a new one.
                // This prevents listener accumulation on the static .player element.
                this._cleanupPTZ();

                if (this.config.digital_ptz !== false) {
                    // [MEMORY FIX] Save reference to the new PTZ instance
                    this.digitalPTZ = new DigitalPTZ(
                        this.shadowRoot.querySelector('.player'),
                        this.shadowRoot.querySelector('.ptz-transform'),
                        this.driver.video,
                        Object.assign({}, this.config.digital_ptz, {
                            // Fall back to entity so entity-based streams keep a distinct
                            // zoom-persistence bucket instead of all sharing `undefined`.
                            persist_key: this.config.url || this.config.entity
                        })
                    );
                }

                this.renderCustomUI();
            } else {
                setTimeout(checkVideo, 50);
            }
        };
        checkVideo();
    }

    // --- UI logic below intentionally remains imperative and isolated ---
    // UI state is always rebuilt when the driver changes.

    renderCustomUI() {
        // Detach listeners bound by a previous invocation. After a driver swap
        // these may live on an old (already nuked) video element, so aborting is
        // the only reliable way to drop them and avoid duplicate handlers.
        if (this._uiAbort) {
            this._uiAbort.abort();
            this._uiAbort = null;
        }

        const root = this.shadowRoot;

        // Remove any existing overlay so a rebuild — or a runtime `ui: false` —
        // always starts from a clean slate.
        const existingUI = root.querySelector('.ui');
        if (existingUI) existingUI.remove();

        if (!this.config.ui) return;

        // Needs a live video to bind to. If the driver isn't ready yet the overlay
        // will be (re)built by setupTools() once it connects.
        if (!this.driver || !this.driver.video) return;

        const card = root.querySelector('.card');

        // Inject the static overlay stylesheet once. `.card` is persistent across
        // reconnects, so a per-call <style> would otherwise accumulate on it.
        if (!root.querySelector('#ui-style')) {
            const style = document.createElement('style');
            style.id = 'ui-style';
            style.textContent = `
                .controls { position: absolute; left: 5px; right: 5px; bottom: 5px; display: flex; align-items: center; z-index: 21; }
                .space { width: 100%; }
                .stream { padding-top: 2px; margin-left: 2px; font-weight: 400; font-size: 20px; color: white; display: none; cursor: pointer; text-shadow: 0 0 2px black;}
                .volume { display: none; }
            `;
            card.appendChild(style);
        }

        // Insert the overlay markup.
        card.insertAdjacentHTML('beforeend', `
            <div class="ui">
                <div class="controls">
                    <ha-icon class="fullscreen" icon="mdi:fullscreen"></ha-icon>
                    <ha-icon class="screenshot" icon="mdi:floppy"></ha-icon>
                    <ha-icon class="pictureinpicture" icon="mdi:picture-in-picture-bottom-right"></ha-icon>
                    <span class="stream">${this.streamName}</span>
                    <span class="space"></span>
                    <ha-icon class="play" icon="mdi:play"></ha-icon>
                    <ha-icon class="volume" icon="mdi:volume-high"></ha-icon>
                </div>
            </div>
        `);

        // Every listener below is tied to this AbortController so the next
        // renderCustomUI() call removes them all in one shot.
        this._uiAbort = new AbortController();
        const {signal} = this._uiAbort;

        // Bind tools to the current driver video
        const video = this.driver.video;
        const ui = root.querySelector('.ui');

        // Select the persistent spinner created in renderStructure
        const spinner = root.querySelector('.spinner');

        const playBtn = root.querySelector('.play');
        const volBtn = root.querySelector('.volume');
        const pipIcon = root.querySelector('.pictureinpicture');

        // Apply initial icon state — reflect the AUDIBLE (on-screen) element, which during a
        // promoted RTC stream is the overlay, not the hidden MSE this.video (v14.6.4).
        volBtn.icon = ((this.driver && this.driver.onscreenVideo) || video).muted
            ? 'mdi:volume-mute' : 'mdi:volume-high';

        // [FIX 1/2] Bind video events to the persistent spinner.
        // #924: `spinner: false` omits the element entirely (querySelector('.spinner')
        // is null → every guard below no-ops). `spinner_delay: <ms>` defers showing it
        // on a `waiting`, so a brief stall doesn't flash the overlay.
        const spinnerDelay = Number(this.config.spinner_delay) || 0;
        let spinnerTimer = null;
        const clearSpinnerTimer = () => { if (spinnerTimer) { clearTimeout(spinnerTimer); spinnerTimer = null; } };
        video.addEventListener('waiting', () => {
            if (!spinner) return;
            if (spinnerDelay > 0) {
                if (spinnerTimer) return;
                spinnerTimer = setTimeout(() => { spinnerTimer = null; spinner.style.display = 'block'; }, spinnerDelay);
            } else {
                spinner.style.display = 'block';
            }
        }, {signal});
        video.addEventListener('playing', () => { clearSpinnerTimer(); if (spinner) spinner.style.display = 'none'; }, {signal});
        // A pending delayed spinner must not fire after this UI is torn down/rebuilt.
        signal.addEventListener('abort', clearSpinnerTimer);

        // #913: play/pause toggle. Under `ui: true` the button stays visible (like the other
        // controls). Driven by the driver's suspend()/resume() (v2.4.4) so it acts on the ON-SCREEN
        // element, not the hidden MSE one: the old code called video.pause() on this.video, which
        // during a promoted RTC stream froze the invisible MSE while the visible overlay kept
        // playing — the icon flipped but the picture didn't stop. The icon is set explicitly here
        // (the pause may land on _rtcVideo, whose events don't bubble through this.video); the
        // this.video listeners below still catch external play/pause (fullscreen, PiP).
        const onScreen = () => (this.driver && this.driver.onscreenVideo) || video;
        playBtn.icon = onScreen().paused ? 'mdi:play' : 'mdi:pause';
        video.addEventListener('play', () => { playBtn.icon = 'mdi:pause'; }, {signal});
        video.addEventListener('pause', () => { playBtn.icon = 'mdi:play'; }, {signal});
        video.addEventListener('loadeddata', () => volBtn.style.display = this.hasAudio ? 'block' : 'none', {signal});
        // Reflect the on-screen (audible) element, not this.video: during promoted RTC the driver
        // force-mutes this.video to kill echo, so reading video.muted here would show 'mute' while
        // the overlay is actually audible (v14.6.4). External changes (fullscreen) still fire here.
        video.addEventListener('volumechange', () => {
             volBtn.icon = onScreen().muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        }, {signal});

        video.addEventListener('enterpictureinpicture', () => pipIcon.icon = 'mdi:rectangle', {signal});
        video.addEventListener('leavepictureinpicture', () => pipIcon.icon = 'mdi:picture-in-picture-bottom-right', {signal});

        ui.addEventListener('click', ev => {
            const {icon} = ev.target;
            if (icon === 'mdi:play') { this.driver.resume(); playBtn.icon = 'mdi:pause'; }
            else if (icon === 'mdi:pause') { this.driver.suspend(); playBtn.icon = 'mdi:play'; }
            // Route through the driver so it mutes the ON-SCREEN element and records the desired
            // state in _mseWanted, which promote/commit/revert restore (v14.6.4). Old code set
            // this.video.muted directly — muted the hidden MSE during a promoted RTC stream, and
            // the next handoff overwrote the choice. Icon is set explicitly (the mute may land on
            // _rtcVideo, whose volumechange doesn't bubble through this.video).
            else if (icon === 'mdi:volume-mute') { this.driver.setMuted(false); volBtn.icon = 'mdi:volume-high'; }
            else if (icon === 'mdi:volume-high') { this.driver.setMuted(true); volBtn.icon = 'mdi:volume-mute'; }
            else if (icon === 'mdi:floppy') this.saveScreenshot();

            else if (icon === 'mdi:fullscreen') this.requestFullscreen(video);

            else if (icon === 'mdi:picture-in-picture-bottom-right') video.requestPictureInPicture().catch(console.warn);
            else if (icon === 'mdi:rectangle') document.exitPictureInPicture().catch(console.warn);

            else if (ev.target.className === 'stream') {
                this.nextStream();
                ev.target.innerText = this.streamName;
            }
        }, {signal});

        const streamLabel = root.querySelector('.stream');
        if (streamLabel) {
            streamLabel.style.display = this.config.streams.length > 1 ? 'block' : 'none';
        }

        // --- tap_action (#668) -------------------------------------------------
        // Fire the standard Lovelace `hass-action` on a CLEAN single-finger tap.
        // Deliberately gated so it never steals a digital-PTZ gesture: a pinch
        // (2 pointers) or a pan (movement) is ignored, and taps on the control
        // overlay (.ui) are ignored. Listeners are passive and never
        // stopPropagation, so digital-ptz keeps receiving the same events.
        const tap = this.config.tap_action;
        if (tap && tap.action && tap.action !== 'none') {
            const player = root.querySelector('.player');
            let sx = 0, sy = 0, active = 0, moved = false, multi = false;
            player.addEventListener('pointerdown', ev => {
                active++;
                if (active > 1) { multi = true; return; }
                sx = ev.clientX; sy = ev.clientY; moved = false; multi = false;
            }, {signal});
            player.addEventListener('pointermove', ev => {
                if (active >= 1 && (Math.abs(ev.clientX - sx) > 10 || Math.abs(ev.clientY - sy) > 10)) {
                    moved = true;
                }
            }, {signal});
            const endPointer = ev => {
                active = Math.max(0, active - 1);
                if (active > 0) return;            // wait for the last finger up
                const clean = !moved && !multi;
                moved = false; multi = false;
                if (!clean) return;
                if (ev.target && ev.target.closest && ev.target.closest('.ui')) return;
                this.handleAction('tap');
            };
            player.addEventListener('pointerup', endPointer, {signal});
            player.addEventListener('pointercancel', () => {
                active = Math.max(0, active - 1);
                if (active === 0) { moved = false; multi = false; }
            }, {signal});
        }

        // --- live indicator (#922) --------------------------------------------
        // UI-only liveness dot. Uses requestVideoFrameCallback (fires per PRESENTED frame, so it
        // also catches a silent freeze that emits no 'waiting') plus a 500ms watchdog.
        //
        // v14.6.3 FIX: bind to the driver's `onscreenVideo` (the element actually on screen), not
        // this.driver.video. During a promoted RTC stream the pixels come from the overlay
        // (_rtcVideo) while the MSE this.video is hidden and no longer fed — the old code watched
        // that stalled MSE element and drove the dot RED on a perfectly live RTC stream. It also
        // never recovered: the commit swaps this.video.srcObject on the SAME element, which cancels
        // the pending rVFC, so beat stopped re-arming. arm() now re-targets whenever the on-screen
        // element changes (promote/commit/revert) AND re-arms after a same-element source swap, so
        // the chain survives every handoff transition.
        if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
        if (this.config.live_indicator === true) {
            const dot = root.querySelector('.live-dot');
            if (dot) {
                let bound = null;              // element rVFC is currently armed on
                let pending = false;           // a rVFC is outstanding on `bound`
                let lastFrame = Date.now();
                const beat = () => { pending = false; lastFrame = Date.now(); arm(); };
                const arm = () => {
                    const v = this.driver && this.driver.onscreenVideo;
                    if (!v || !v.requestVideoFrameCallback) return;
                    if (v !== bound) { bound = v; pending = false; lastFrame = Date.now(); }
                    if (pending) return;
                    pending = true;
                    v.requestVideoFrameCallback(beat);
                };
                arm();
                // A source swap on the SAME element (the commit collapse) cancels the pending rVFC;
                // loadeddata fires right after it, so force a re-arm on the next tick.
                video.addEventListener('loadeddata', () => { pending = false; }, {signal});
                this._liveTimer = setInterval(() => {
                    arm();  // re-target on handoff transitions / re-arm after a swap
                    dot.classList.toggle('live', Date.now() - lastFrame < 500);
                }, 500);
                signal.addEventListener('abort', () => {
                    if (this._liveTimer) { clearInterval(this._liveTimer); this._liveTimer = null; }
                });
            }
        }

        // --- network-state indicator (opt-in) ---------------------------------
        // Paints the .net-dot from the driver's band verdict (parsed off the metrics line in the
        // message router). A staleness sweep returns it to white once band samples stop arriving —
        // metrics only emit while an un-committed probe polls, so "no fresh sample" is the honest
        // MSE-only/idle state. The paint helper is a no-op when the dot isn't in the DOM.
        if (this._netTimer) { clearInterval(this._netTimer); this._netTimer = null; }
        if (this.config.network_indicator === true) {
            this._paintNetDot();
            this._netTimer = setInterval(() => {
                if (this._lastBand && Date.now() - this._lastBandAt > this.NET_DOT_STALE_MS) {
                    this._lastBand = '';
                    this._paintNetDot();
                }
            }, 1000);
            signal.addEventListener('abort', () => {
                if (this._netTimer) { clearInterval(this._netTimer); this._netTimer = null; }
            });
        }
    }

    // Paint the opt-in network-state dot from `_lastBand` ('' | perf | degr | path). White (no class)
    // = no fresh band sample. Safe to call when the dot is absent (indicator off / not yet rendered).
    _paintNetDot() {
        const dot = this.shadowRoot && this.shadowRoot.querySelector('.net-dot');
        if (!dot) return;
        dot.classList.remove('perf', 'degr', 'path');
        if (this._lastBand) dot.classList.add(this._lastBand);
    }

    // Normalize a user-supplied `ice_servers` config. Returns:
    //   • null  → not configured (undefined/null/empty string) → keep the built-in default.
    //   • []    → EXPLICIT empty list (`ice_servers: []`) → deliberate privacy opt-out:
    //             the injection replaces the default with NO STUN/TURN (zero third parties;
    //             WebRTC then works on LAN via host candidates, remote falls back to MSE).
    //   • [..]  → the parsed RTCIceServer list (REPLACES the default).
    // Accepts a bare string, an array of strings, or an array of {urls|url, username?,
    // credential?} objects (the standard HA/WebRTC shape).
    _normalizeIceServers(raw) {
        if (raw == null || raw === '') return null;      // not configured → default
        const arr = Array.isArray(raw) ? raw : [raw];
        if (arr.length === 0) return [];                 // explicit opt-out → no servers
        const out = [];
        for (const s of arr) {
            if (typeof s === 'string') {
                if (s) out.push({urls: s});
            } else if (s && (s.urls || s.url)) {
                const server = {urls: s.urls || s.url};
                if (s.username != null) server.username = s.username;
                if (s.credential != null) server.credential = s.credential;
                out.push(server);
            }
        }
        // Non-empty input that parsed to nothing (all entries malformed) → treat as a
        // typo and keep the default rather than silently wiping STUN.
        return out.length ? out : null;
    }

    // [HA NATIVE ICE (#923)] Ask Home Assistant for its own ICE servers via the native
    // `web_rtc/ice_servers` WS command. This returns the user's `webrtc:` config plus any
    // cloud-provided TURN (Nabu Casa / Homeway) — reusing HA's own list instead of
    // reinventing it in Python. Cached in `this._haIceServers`; consumed at driver
    // creation, below the per-card override. Fails soft: an older HA (command missing)
    // leaves the cache null and we keep the built-in STUN default.
    // [COLD-START GATE] Resolve HA's ICE servers exactly once, bounded by a short timeout,
    // and remember that we resolved (or gave up). Idempotent and one-flight: the eager
    // warm-up in `set hass` and the awaited gate in startStream() share the SAME promise, so
    // in the common case the fetch is already resolving by the time the gate awaits it — the
    // only added first-frame cost is the single WS round-trip (~10ms, field-measured), far
    // below the ~500ms MSE land. `web_rtc/ice_servers` is a synchronous in-memory HA callback
    // (no cloud I/O per call — the provider caches server-side), so N cameras cost N cheap
    // round-trips, not N cloud fetches. FAIL-SOFT: on timeout (wedged WS) or an old HA missing
    // the command, `_haIceServers` stays null and the driver keeps the 2×STUN default — i.e.
    // the worst case is exactly today's behaviour.
    async _ensureHaIceReady() {
        if (this._haIceReady) return;                       // already resolved/timed out (cached)
        if (!this._haIcePromise) {
            // Bound the fetch: a genuinely wedged WS must never stall the first frame. The
            // fetch itself never rejects (its own try/catch sets _haIceServers=null), so the
            // race only trades a late fetch for the default. Old HA rejects fast → no wait.
            const TIMEOUT_MS = 300;
            const timeout = new Promise(resolve => setTimeout(resolve, TIMEOUT_MS));
            this._haIcePromise = Promise.race([this._fetchHaIceServers(), timeout])
                .then(() => { this._haIceReady = true; });
        }
        await this._haIcePromise;
    }

    async _fetchHaIceServers() {
        try {
            const list = await this._hass.callWS({type: 'web_rtc/ice_servers'});
            const servers = this._normalizeIceServers(list);
            this._haIceServers = servers && servers.length ? servers : null;
            // Mirror to the HA log like every other lifecycle event. `debug`: this is
            // diagnostic, not an error. Low-cardinality detail → throttle keys by event name.
            this._logHA('debug', 'ice-ha', this._haIceServers ? `${this._haIceServers.length} server(s)` : 'none');
        } catch (e) {
            this._haIceServers = null;   // command unavailable → keep default
            // Old HA without the command is a benign/expected outcome, not a failure → `debug`.
            this._logHA('debug', 'ice-ha', 'unavailable');
        }
    }

    // Perform the configured `<kind>_action` (kind = 'tap' | 'hold' | 'double_tap').
    // A standalone custom card can't rely on the `hass-action` event bubbling to a
    // Lovelace handler — nothing upstream catches it here — so we execute the action
    // ourselves via the global events HA actually listens for (`hass-more-info`,
    // `location-changed`) and `hass.callService`. Supports the standard action names:
    // more-info, navigate, url, toggle, perform-action (a.k.a. call-service),
    // fire-dom-event, none.
    handleAction(kind) {
        const cfg = (this.config && this.config[`${kind}_action`]) || null;
        if (!cfg || !cfg.action || cfg.action === 'none') return;

        // Entity resolution for entity-scoped actions: explicit action entity,
        // then the card's top-level entity, then the current stream's entity.
        const stream = (this.config.streams && this.config.streams[this.streamID]) || {};
        const entityId = cfg.entity || this.config.entity || stream.entity;

        switch (cfg.action) {
            case 'more-info':
                if (entityId) {
                    this.dispatchEvent(new CustomEvent('hass-more-info', {
                        bubbles: true, composed: true, detail: {entityId},
                    }));
                }
                break;
            case 'navigate':
                if (cfg.navigation_path) {
                    history.pushState(null, '', cfg.navigation_path);
                    this.dispatchEvent(new CustomEvent('location-changed', {
                        bubbles: true, composed: true, detail: {replace: false},
                    }));
                }
                break;
            case 'url':
                if (cfg.url_path) window.open(cfg.url_path);
                break;
            case 'toggle':
                if (entityId && this._hass) {
                    this._hass.callService('homeassistant', 'toggle', {entity_id: entityId});
                }
                break;
            case 'perform-action':
            case 'call-service': {
                const svc = cfg.perform_action || cfg.service;
                if (svc && this._hass) {
                    const [domain, service] = svc.split('.', 2);
                    if (domain && service) {
                        const data = cfg.data || cfg.service_data || {};
                        this._hass.callService(domain, service, data, cfg.target);
                    }
                }
                break;
            }
            case 'fire-dom-event':
                this.dispatchEvent(new CustomEvent('ll-custom', {
                    bubbles: true, composed: true, detail: cfg,
                }));
                break;
        }
    }

    requestFullscreen(video) {
        // #953: optionally unmute while fullscreen (restored on exit). Called from
        // the fullscreen-icon click handler, i.e. inside a user gesture, so the
        // browser autoplay policy allows the unmute.
        if (this.config.unmute_in_fullscreen === true) this._unmuteWhileFullscreen(video);
        if (video.webkitEnterFullscreen) {
            // [B / url_fullscreen] iOS binds fullscreen to THIS <video> element. Swapping the
            // stream cold-restarts the driver, which tears the element down and drops out of
            // fullscreen — so the hi-res swap is NOT applied on the webkit path; iOS shows the
            // substream upscaled. (A gesture-preserving pre-swap is a possible follow-up.)
            video.webkitEnterFullscreen();
        } else {
            const card = this.shadowRoot.querySelector('.card');
            if (card.requestFullscreen) {
                // Fullscreen lives on the .card CONTAINER, not the inner <video>, so we can
                // cold-restart the driver onto the hi-res `url_fullscreen` and revert on exit
                // without ever leaving fullscreen. This is the primary (desktop / Android PWA) path.
                const p = card.requestFullscreen();
                if (this.config.url_fullscreen) {
                    Promise.resolve(p)
                        .then(() => { this._applyFullscreenStream(true); this._watchFullscreenExit(); })
                        .catch(() => { /* fullscreen denied — stay on the substream */ });
                }
            } else if (video.requestFullscreen) {
                video.requestFullscreen();   // fullscreen bound to <video>; no swap (see webkit note)
            }
        }
    }

    // [B / url_fullscreen] Swap the live stream to the high-res `url_fullscreen` (on=true) or back
    // to the configured substream (on=false) by cold-restarting the driver with `_fsStreamOverride`
    // applied in startStream(). No-op when `url_fullscreen` is unset or already in the target state.
    _applyFullscreenStream(on) {
        const hd = this.config.url_fullscreen;
        if (!hd) return;
        if (on) {
            if (this._fsStreamOverride) return;             // already on hi-res
            this._fsStreamOverride = {url: hd, entity: undefined};
        } else {
            if (!this._fsStreamOverride) return;            // already on the substream
            this._fsStreamOverride = null;
        }
        // Cold restart (not a shadow upgrade) so the swap is a clean single negotiation.
        this._isReconnecting = false;
        this._cleanupDriver();
        this.startStream();
    }

    // [B / url_fullscreen] One-shot listener: when fullscreen ends (no fullscreenElement) revert
    // the stream to the substream. Paired with the swap in requestFullscreen (card path only).
    _watchFullscreenExit() {
        const onFsChange = () => {
            if (!document.fullscreenElement) {
                document.removeEventListener('fullscreenchange', onFsChange);
                this._applyFullscreenStream(false);
            }
        };
        document.addEventListener('fullscreenchange', onFsChange);
    }

    // #953: unmute the given video now and restore its previous (muted) state when
    // fullscreen ends. iOS fires `webkitendfullscreen` on the <video>; the standard
    // path fires `fullscreenchange` on document (exit = no fullscreenElement).
    _unmuteWhileFullscreen(video) {
        const prevMuted = video.muted;
        if (!prevMuted) return;                 // already unmuted → nothing to do/restore
        video.muted = false;
        function cleanup() {
            video.removeEventListener('webkitendfullscreen', restore);
            document.removeEventListener('fullscreenchange', onFsChange);
        }
        function restore() { video.muted = prevMuted; cleanup(); }
        function onFsChange() { if (!document.fullscreenElement) restore(); }
        video.addEventListener('webkitendfullscreen', restore);
        document.addEventListener('fullscreenchange', onFsChange);
    }

    saveScreenshot() {
        const video = this.driver.video;
        const a = document.createElement('a');
        if (video.videoWidth && video.videoHeight) {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            a.href = canvas.toDataURL('image/jpeg');
        } else if (video.poster && video.poster.startsWith('data:image/jpeg')) {
            a.href = video.poster;
        } else return;

        const ts = new Date().toISOString().substring(0, 19).replace(/[-:]/g, '');
        a.download = `snapshot_${ts}.jpeg`;
        a.click();
    }

    get hasAudio() {
        // On-screen (audible) element: during promoted RTC the audio is on the overlay, not the
        // hidden MSE this.video — check onscreenVideo so the volume button shows for RTC-only audio.
        const v = this.driver ? this.driver.onscreenVideo : null;
        if (!v) return false;
        return (
            (v.srcObject && v.srcObject.getAudioTracks && v.srcObject.getAudioTracks().length) ||
            v.mozHasAudio ||
            v.webkitAudioDecodedByteCount ||
            (v.audioTracks && v.audioTracks.length)
        );
    }

    // Human-readable label for the active stream, used by the multi-stream UI.
    // Falls back through name -> entity -> url -> a 1-based index.
    get streamName() {
        const stream = this.config.streams[this.streamID] || {};
        return stream.name || stream.entity || stream.url || `Stream ${this.streamID + 1}`;
    }

    getCardSize() { return 5; }
    static getStubConfig() { return {url: ''}; }
}

// (#932) Guard the registration: if this module is evaluated twice — a swipe-card with two
// instances, HA's scoped custom-element registry, a PWA/service-worker re-load, or a `?v=`
// cache-bust race — a second unconditional `define('webrtc-camera', …)` throws
// `"webrtc-camera" has already been used with this registry`, which aborts module load. Mirror
// the guard already used for `video-rtc` above, and de-dupe the customCards entry too.
if (!customElements.get('webrtc-camera')) {
    customElements.define('webrtc-camera', WebRTCCamera);

    window.customCards = window.customCards || [];
    window.customCards.push({
        type: 'webrtc-camera',
        name: 'WebRTC Camera',
        description: 'Ephemeral WebRTC Camera',
        preview: false
    });
}