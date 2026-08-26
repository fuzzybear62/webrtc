/*!
 * Copyright (c) 2023 Alexey Khit (https://github.com/AlexxIT/WebRTC)
 * Copyright (c) 2026 fuzzybear62 (https://github.com/fuzzybear62/webrtc)
 * Derived from AlexxIT/WebRTC. Licensed under the MIT License — see LICENSE.
 */
/**
 * VideoRTC v2.7.1 - carry the revert REASON on the rtc_failed signal so the card mirrors it to HA
 * VideoRTC v2.7.0 - Strato-1 step 3: abort a doomed RTC probe on absolute jbuf/RTT ceilings
 * * Changelog v2.7.0:
 * - STRATO-1 STEP 3 — RTC ABORT on a pathological path. The v2.5.0 adaptive watchdog EXTENDS
 *   tolerance while congested; the 2026-08-26 direct-4G diagnostics run (v2.6.0) confirmed that on a
 *   PATHOLOGICAL path that extend only PROLONGS a doomed storm. Measured cause = BUFFERBLOAT, not
 *   fragmentation: jbuf ballooned to 1500-2100ms, RTT plateaued at a standing ~1.5s that never drained,
 *   pkt stayed well under MTU (272-1012B, content-shaped, no MTU pinning), loss moderate; path was
 *   srflx/…/udp (direct UDP hole-punch, NOT TURN — the "many gateways fragment" hypothesis is out).
 *   New `_evaluateAbort` (called once per 3s metrics emit) reverts a still-un-committed RTC probe to
 *   the warm MSE when jitter-buffer delay (jbuf) OR candidate-pair RTT holds at/over a hard ceiling for
 *   RTC_ABORT_HOLD_MS — a deterministic ~6-9s teardown replacing the up-to-30× watchdog balloon. The
 *   trigger uses ABSOLUTE ceilings on purpose: `cong` SATURATES past ADAPT_RTT_EXCESS_MS (~1.0 for both
 *   800ms and 20s RTT) so it cannot tell recoverable bufferbloat (the CF-tunnel run that converged at
 *   cong 0.5-0.82) from pathological — a cong-based abort would have killed that run. jbuf/RTT don't
 *   saturate. A jbuf=? window neither arms nor disarms the hold (only a definitively healthy sample
 *   clears it). Knobs (per-card, parametric): RTC_ABORT_ENABLED/JBUF_MS/RTT_MS/HOLD_MS/FUTILITY_K.
 * - FUTILITY INVERSION FIXED. `_rtcFutility` (bumped on every revert) used to feed `inst` in
 *   _updateCongestion, RAISING congestion → LENGTHENING the watchdog extension after a failure —
 *   i.e. it babied the doomed probe (backwards). It no longer touches congestion; it now SHORTENS the
 *   next probe's abort hold toward HOLD*(1-FUTILITY_K), so a repeatedly-doomed path gives up faster.
 *   Futility drives suppression, as intended. Its decay still lives in _updateCongestion (per emit).
 *   No change to the extend logic (_effectiveDisconnectTimeout) or the promote/commit/revert gates.
 * * Changelog v2.6.0:
 * - TRANSPORT DIAGNOSTICS (no behaviour change — purely observational). The `metrics` line now also
 *   carries `jbuf`/`nack`/`pkt`/`path`, harvested from the SAME getStats poll, to settle a field
 *   question the 2026-08-26 runs raised: the direct-4G (ha-native/TURN) path collapsed to 20s RTT
 *   and killed HA, while the SAME grid over a Cloudflare tunnel rode a transient storm and converged
 *   — is the direct path dying of bufferbloat or of IP fragmentation? The new fields discriminate:
 *     • `path=local/remote/proto` — selected candidate-pair candidateType + protocol
 *       (e.g. srflx/host/udp, relay/relay/udp, host/host/tcp). Tests the "UDP-to-TURN vs TCP-over-CF"
 *       hypothesis directly instead of guessing the transport.
 *     • `jbuf=Nms` — avg jitter-buffer delay over the window (Δ jitterBufferDelay / Δ emittedCount).
 *       The receiver-side BUFFERBLOAT tell: grows as packets queue.
 *     • `nack=N` — retransmit requests over the window (Δ nackCount). The LOSS/fragmentation tell.
 *     • `pkt=NB` — avg received packet size (Δ bytesReceived / Δ packetsReceived). The MTU tell:
 *       sustained near/over ~1200B with high loss ⇒ suspect IP fragmentation.
 *   Reading: RTT↑ + jbuf↑ + nack/loss low ⇒ bufferbloat. loss/nack high + pkt near MTU + RTT bounded
 *   ⇒ fragmentation. This lands BEFORE Strato-1 step 3 so the abort trigger (RTT-ceiling vs a
 *   loss-based one) is tuned on measured cause, not on the saturating `cong` signal.
 * * Changelog v2.5.0:
 * - ADAPTIVE WATCHDOG (Strato-1). The MSE no-data watchdog is no longer a fixed 5s: a tiny in-loop
 *   controller (_updateCongestion / _effectiveDisconnectTimeout) turns the existing passive metrics
 *   into a smoothed `congestion` score [0,1] and EXTENDS the effective timeout up to ADAPT_MAX_EXTEND×
 *   the base (this.DISCONNECT_TIMEOUT / per-card `mse_timeout`) — never below it — but ONLY while an
 *   un-committed RTC probe is live (negotiating/promoted), the one window where the MSE is starved by
 *   additive RTC load. Signal = rttExcess (rtt - session-min-rtt, the bufferbloat leading indicator)
 *   reinforced by loss% and a decaying `_rtcFutility` penalty bumped on every _revertToWarmMSE (a
 *   doomed RTC promote). In 'warm'/'committed' the base is used unchanged, so a genuinely dead
 *   MSE-only stream is still reaped on time. Field motivation: the 2026-08-26 mse_timeout:0 run
 *   proved the socket SURVIVES a 21s-rttExcess congestion storm and all 4 cams converge to clean RTC
 *   — the fixed 5s watchdog was the disease (the reconnect storm), not the cure. High/low-band paths
 *   now diverge from identical code (the substream keeps the tight base; the main earns the
 *   extension). All thresholds parametric (ADAPTIVE_WATCHDOG / ADAPT_RTT_EXCESS_MS / ADAPT_LOSS_PCT /
 *   ADAPT_MAX_EXTEND / ADAPT_EWMA_ALPHA), overridable per-card. The `metrics` line now ends with
 *   `cong=N.NN`. Reprobe-suppression on sustained futility (Strato-1 step 3) is a follow-up.
 * * Changelog v2.4.6:
 * - FIX (MSE strand → frozen stream, "press pause+play to start"): the 5s buffer eviction
 *   (sb.remove) can leave the element's currentTime BELOW the buffered window — initial autoplay
 *   never started before the window slid past currentTime=0 (slow-4G / backgrounded first-frame),
 *   or an MSE stall stranded currentTime behind an evicted region. The element then waits forever
 *   for removed data and freezes; only a manual pause→play (resume() seeks to live) cleared it.
 *   onmse's updateend now seeks to the live edge ONCE when it detects that strand (guarded by
 *   !_manualHold, and by currentTime<buffered.start so it can't fire on a healthy stream) — NOT
 *   the continuous upstream currentTime=start catch-up that caused the iOS 0.1x crawl.
 * - REVERT of v2.4.3's phase-aware no-data watchdog shortening. `_feedWatchdog` now always uses
 *   the full DISCONNECT_TIMEOUT (5s). That watchdog is fed by binary WS bytes = MSE chunks (RTC
 *   is P2P), so it measures MSE liveness only; the 2.5s window while negotiating false-fired on
 *   bursty-but-alive MSE over congested 4G (loss 29-54%), and `onclose()` tore down the working
 *   MSE too (a retry storm, not the "revert to MSE" the old comment claimed). It also killed
 *   streams before the first loss% metric was emitted, starving the card's A0 severity gate so
 *   suppression latched slowly. At 5s the loss sample lands first and 4xMSE settles. Killing a
 *   doomed RTC probe fast stays the job of the RTC give-up watchdog + card narrow-link suppression.
 * * Changelog v2.4.5:
 * - NEW `setMuted(muted)`: the card's volume button now mutes the ON-SCREEN element (onscreenVideo)
 *   AND records `_mseWanted`, so promote/commit/revert restore the intended audio state. The old
 *   card path set this.video.muted directly — muted the hidden MSE during promoted RTC while the
 *   audible overlay kept its sound, and the next handoff overwrote the choice.
 * * Changelog v2.4.4:
 * - FIX two card-facing bugs whose shared root cause was the card binding to `this.video` (the
 *   hidden MSE element) while, during the reversible-RTC `promoted` phase, the on-screen pixels
 *   are the overlay `_rtcVideo`. New `get onscreenVideo()` returns the element the viewer actually
 *   sees (overlay while promoted, else this.video). The card now targets it for BOTH the live-dot
 *   and play/pause.
 * - NEW manual-pause API: `suspend()` soft-pauses the on-screen element and sets `_manualHold`,
 *   which freezes the commit/revert poll (and the give-up timer) so the handoff machine can't call
 *   play() and auto-resume behind the user. `resume()` clears the hold, seeks MSE to the live edge
 *   (RTC unaffected), and plays. Instant freeze/resume — decoder+socket kept warm on purpose;
 *   bandwidth teardown stays the OFF-SCREEN auto-pause's job.
 * * Changelog v2.4.3:
 * - The no-data watchdog (DISCONNECT_TIMEOUT) is now PHASE-AWARE. While an un-committed RTC
 *   probe is live (_rtcPhase 'negotiating' or 'promoted') the RTC overlay is ADDITIVE load on
 *   the link, so a ws MSE-media silence almost certainly means that experiment is choking the
 *   link (the multi-camera 4G collapse). In those phases the watchdog fires at
 *   NEGOTIATING_DISCONNECT_TIMEOUT (2.5s) instead of 5s, so the doomed probe is killed sooner,
 *   the link is freed for the other cameras, and the card reaches MSE-only suppression faster.
 *   Low risk: MSE is still warm underneath in both phases, so a watchdog fire reverts to MSE
 *   (~1 frame), not a black screen; on a fat link MSE never goes 2.5s silent so it never trips.
 *   'warm' (no experiment) and 'committed' (no MSE net) keep the full 5s.
 * * Changelog v2.4.2:
 * - FIX: onopen() guards against a null/undefined this.mode. A stream entry without `mode`
 *   or a teardown<->open race during rapid reconnect churn left this.mode null; the
 *   `this.mode.includes(...)` calls threw, the ws died at open (0-byte channel) and the card
 *   reconnected immediately -> reconnect storm (seen even on LAN). Now restores the default
 *   ('webrtc,mse,hls,mjpeg') + warns once, so onopen can't throw. Behaviour unchanged when
 *   this.mode is already a valid string.
 * * Changelog v2.4.1:
 * - Added a PASSIVE per-pc metric sampler (_sampleMetrics) piggybacking on the getStats poll
 *   already running for framesDecoded. Harvests inbound-rtp (bytesReceived/packetsReceived/
 *   packetsLost/jitter) + the selected candidate-pair currentRoundTripTime, and emits a compact
 *   `metrics` line to the card every METRICS_EMIT_MS (3s). Diagnostic ONLY — the values never
 *   feed the promote/commit/revert logic (that stays framesDecoded-only), so behaviour is
 *   byte-identical on every path (fat LAN included: same stream, the numbers are just now
 *   visible in the HA log). First data-gathering step toward history-driven adaptation: lets us
 *   check on real links whether RTT bufferbloat / rising loss PRECEDES the mse->rtc->mse reverts.
 * * Changelog v2.4.0:
 * - Default pcConfig.iceServers now lists TWO independent public STUN servers
 * (Google + Cloudflare). If one provider is blocked/filtered/down, the other still
 * lets the browser discover its srflx candidate. Applies to every camera (the default
 * lives on each driver). A per-card `ice_servers` REPLACES it; `ice_servers: []`
 * removes all defaults (privacy opt-out). See webrtc-camera.js `_normalizeIceServers`.
 * * Changelog v2.3.9:
 * - FIX: removed the MSE `updateend` live-sync inherited from upstream v3.6.1
 * (`this.video.currentTime = start` re-seek + `this.video.playbackRate = gap`).
 * On iOS 26.1 WebKit the `gap > 0.1 ? gap : 0.1` floor pinned playbackRate to
 * ~0.1x near the live edge, so the picture crawled at "~1 frame / 3s". MSE now
 * plays at 1x (pre-3.6.1 behavior); the 5s buffer trim + setLiveSeekableRange are
 * kept. WebRTC remains the low-latency path, MSE the reliable fallback.
 * * Changelog v2.3.8:
 * - FIX: ondisconnect() now revokes the MSE blob URL (URL.createObjectURL(ms),
 * legacy MediaSource path on Chrome/Firefox) if the {once} 'sourceopen' handler
 * never fired — i.e. a driver torn down before the MediaSource opened (a shadow
 * reaped within ms, or teardown mid-negotiation). Without it the blob->MediaSource
 * mapping leaked one entry per such driver, growing slowly under reprobe churn.
 * Double revoke is a harmless no-op; ManagedMediaSource (srcObject) is unaffected.
 * * Changelog v2.3.7:
 * - CHANGE: routine lifecycle/negotiation traces (Mode:*, pc state, RTC promote/commit/phase,
 * RTC-rejected, autoplay-warn, "WebRTC …; keeping MSE", relaxed-ws-error "Ignored") moved from
 * info/warn to `console.debug` — hidden at the browser console's default level, visible with
 * Verbose on. Genuine recoverable anomalies stay at `console.warn` (video/ICE/SDP/buffer/mic
 * errors, strict ws-error, no-data watchdog, RTC revert). Lets the native console level filter
 * act as the gate; no custom debug flag on the driver.
 * * Changelog v2.3.6:
 * - ADD: the `connection-closed` CustomEvent now carries `detail.reason` so the card can log
 * WHY a stream dropped without a browser console — 'ws-close' (server/browser closed the
 * socket), 'no-data-watchdog' (5s silent freeze, socket still open), or 'ws-error' (strict
 * mode). Purely additive: the field is optional and existing consumers ignore it. Feeds the
 * card's new `debug`-gated Home Assistant logging (card v14.2.7).
 * * Changelog v2.3.5:
 * - REFACTOR (smell #1): the RTC handoff is now an explicit 4-state machine on `_rtcPhase`
 * ('warm' | 'negotiating' | 'promoted' | 'committed') driven through a single `_setPhase()`
 * transition point (which logs every edge — free observability, no counters). Replaces the
 * old implicit `_promoted`/`_committed` boolean constellation; illegal combinations are no
 * longer representable and the poll loop reads as phase comparisons.
 * - REMOVE: the legacy/non-reversible RTC branch (irreversible one-shot handoff) and the
 * `reversible` flag are gone. The card made EVERY driver reversible, so that branch — plus
 * the whole non-reversible body of onpcvideo() and the `RTC_PROVE_MS` knob — was dead code
 * that still shared state fields with the live path (the actual root of smell #1). onpcvideo()
 * is now a no-op the card wraps for its UI update; net −122 lines. Behaviour unchanged.
 * * Changelog v2.3.4:
 * - TUNE: RTC_SWAP_PROVE_MS 20000 -> 30000 (wider evidence window before a shadow may swap in;
 * zero effect on good nets, which upgrade directly and never swap). FIRSTFRAME_TIMEOUT
 * 600000 -> 120000 (reap a connected-but-frameless pc in 2min instead of 10). Both are now
 * overridable per-card via `rtc_swap_prove_ms` / `firstframe_timeout` (ms) in the card YAML.
 * * Changelog v2.3.3:
 * - ADD: RTC_SWAP_PROVE_MS (~20s) + one-shot `rtc_sustained` signal. After PROMOTE, once RTC
 * has decoded gaplessly for RTC_SWAP_PROVE_MS the driver emits ui_sync {signal:'rtc_sustained'}
 * exactly once. This is the SHADOW-SWAP gate: the card swaps a background shadow in to replace
 * the MSE main ONLY on this proven-durable signal, never on the 2s PROMOTE. A shadow that
 * stalls before proving (throttled path) never fires it, so the working MSE main is never
 * torn down for an unproven replacement (kills the black-tile + swap-churn failure mode).
 * * Changelog v2.3.2:
 * - FIX: the shadow-swap upgrade path was still the legacy IRREVERSIBLE mechanism and the
 * remaining crash vector. The card now makes EVERY driver reversible (webrtc+mse), so a
 * shadow that swaps in as the new main carries its own warm MSE and reverts to it on a
 * stall instead of freezing black. New applyAudio(muted) routes the configured mute state
 * to the on-screen element (RTC overlay while promoted, else this.video), which the card
 * calls after the swap to un-mute (the shadow negotiates force-muted); un-muting
 * this.video directly would have played the hidden warm-MSE audio under the RTC video.
 * * Changelog v2.3.1:
 * - FIX: reversible handoff still crash-looped on the COMMIT step. v2.3.0 committed
 * (released MSE + closed ws) after a fixed 30s from promote; a bursty repeater camera
 * held RTC for 30s, got committed, then the next inevitable stall had no MSE to fall
 * back on -> failWebRTC -> connection-closed -> nuke -> cold start -> loop (log 4IRQL:
 * promoted @14s, committed @44s, Connection Closed). Commit is the ONLY irreversible
 * step, so it is now reserved for genuinely rock-solid paths: it requires CONTINUOUS
 * gapless decode for RTC_COMMIT_MS (raised 30s -> 180s), and ANY decode gap
 * > RTC_STALL_RESET restarts that clock. Bursty cameras therefore never commit — they
 * stay in warm-MSE mode and revert harmlessly on each stall (one frame, no reconnect).
 * Also restored RTC_LIVENESS_TIMEOUT 8s -> 15s (the value the historically-working
 * handoff used; 8s reverted on ordinary congestion bursts). Dual bandwidth while warm
 * is LAN-side (go2rtc->viewer), not on the constrained camera->go2rtc repeater path.
 * * Changelog v2.3.0:
 * - FIX (major): the MSE->WebRTC handoff is now REVERSIBLE on the main parallel driver,
 * so reaching WebRTC can no longer crash the working MSE stream. Root problem across
 * v2.2.15-19: onpcvideo closed the MSE ws (irreversible), so any post-handoff RTC stall
 * forced a full reconnect (nuke from zero). On congested repeater paths WebRTC delivers
 * bursts that pass any prove window then stall, so every camera that DID promote entered
 * a prove->stall->reconnect loop; cameras that never sustained decode sat throttled. NEW
 * model (see _startReversibleRTC): MSE stays ATTACHED and warm on this.video; WebRTC
 * decodes on an overlaid, rendered <video> (full-rate decode — the old offscreen probe
 * was browser-throttled, which made good cameras take 90s+ to "prove"). Promotion just
 * reveals the overlay (reversible, near-instant at RTC_PROMOTE_MS=2s); a stall before
 * commit snaps back to the warm MSE in one frame (no reconnect, no black) and re-probes;
 * MSE is released (ws closed) only after RTC_COMMIT_MS=30s of continuous liveness. Gated
 * per-driver by `reversible` (set by the card for the main driver only) so the shadow-
 * swap path stays on the legacy prove-before-commit branch, unchanged.
 * * Changelog v2.2.19:
 * - FIX: reconnect loop / driver churn on congested paths. v2.2.18 promoted (and
 * closed MSE) after ~1s of decode; repeater paths deliver WebRTC in bursts, so a
 * stream would pass that gate, stall, get caught by the post-handoff liveness
 * watchdog, and force a full reconnect that tore down the working MSE too — every
 * ~15s, forever, and via connection-closed so no reprobe/shadow ever armed. NEW
 * model "prove before commit": the visible element stays on MSE while the offscreen
 * probe accumulates ACTUALLY-flowing decode time; onpcvideo (switch + close MSE)
 * fires only after RTC_PROVE_MS (15s) of real flow. Burst-then-stall paths never
 * reach it -> MSE never interrupted, and the 600s watchdog gives up with rtc_failed
 * -> reprobe/shadow. The post-handoff liveness watchdog stays as a backstop.
 * * Changelog v2.2.18:
 * - FIX: promoted RTC streams could freeze BLACK forever. framesDecoded > 0 is a
 * single keyframe; on congested paths RTP then stalled, so we handed off (closing
 * MSE) to a stream delivering no further frames. Because the pc stays 'connected'
 * (ICE/DTLS fine) no state change fires and nothing caught it — black with MSE gone,
 * no reconnect, no reprobe. TWO changes: (1) gate the handoff on SUSTAINED decode
 * (framesDecoded advancing across consecutive polls), not the first frame; (2) keep
 * the getStats poll alive AFTER handoff as an RTC liveness watchdog: if framesDecoded
 * stops advancing for RTC_LIVENESS_TIMEOUT (15s) recover via failWebRTC's no-MSE
 * branch (connection-closed -> card reconnects MSE + re-probes). Restores the "never
 * permanently black" invariant the MSE no-data watchdog can't provide post-handoff
 * (RTC media flows P2P off the ws).
 * * Changelog v2.2.17:
 * - FIX: promote to WebRTC on the first actually-DECODED frame, not on 'loadeddata'.
 * On a WebRTC MediaStream loadeddata fires the moment the track is attached, long
 * before RTP video flows on slow repeater paths — promoting then swapped the visible
 * element to a BLACK video AND tore down the working MSE stream (observed: black
 * screen for minutes until RTP finally started). Gate the swap on
 * inbound-rtp.framesDecoded > 0 (compositing-independent proof a real picture
 * exists), polled from getStats(); loadeddata is no longer used as the success edge.
 * - CHANGE: FIRSTFRAME_TIMEOUT 15000 -> 600000. With the swap gated on a real frame,
 * MSE keeps serving the user while the pc waits, so a slow-but-real first frame (seen
 * to take minutes) must not be reaped early; 15s was far below the observed latency.
 * * Changelog v2.2.16:
 * - ADDED: first-frame watchdog on the WebRTC pc. 'connectionState=connected' is
 * not proof of a working stream — on multi-hop paths ICE/DTLS checks pass while
 * RTP media never flows, leaving the pc "connected" but medialess forever. If no
 * first frame lands within FIRSTFRAME_TIMEOUT of 'connected', the pc
 * is reaped and rtc_failed is signalled so the card retries with a fresh ICE
 * gather (was: main waited forever; shadow was killed blindly by the card's 15s).
 * - CHANGE: a rejected webrtc/offer now routes through the shared failWebRTC path
 * (emits rtc_failed) instead of a bare pc.close() that fired no signal.
 * - ADDED: [DIAGNOSTIC] pc connectionstatechange logging with elapsed ICE time.
 * * Changelog v2.2.14:
 * - FIX: in parallel webrtc+mse mode a WebRTC ICE failure no longer tears down a
 * working MSE stream. When MSE is a live fallback (socket open + codecs
 * negotiated) only WebRTC is dropped and an 'rtc_failed' signal is emitted; the
 * full-teardown/retry path is reserved for when no fallback remains.
 * * Changelog v2.2.13:
 * - FIX: a PeerConnection failure AFTER a successful MSE->RTC handover now
 * notifies the card (retry) instead of silently freezing. onclose() is called
 * before this.pc is nulled so its (!ws && !pc) guard no longer short-circuits.
 * * Changelog v2.2.12:
 * - FIX: onclose() now actually closes the WebSocket on proactive-close paths
 * (no-data watchdog, strict-mode WS error, PC failure) instead of only nulling
 * the reference, which left an orphaned open socket streaming into a discarded
 * driver. Added a re-entrancy guard so the self-triggered close event can't
 * double-fire 'connection-closed'.
 * - FIX: MSE staging buffer now bounds-checks before buf.set(), preventing an
 * uncaught RangeError when the SourceBuffer stalls while media keeps arriving.
 * - CLEANUP: removed dead fields (disconnectTID, background, visibilityThreshold,
 * visibilityCheck) left over from the driver-internal auto-pause that now lives
 * in the card.
 * * Changelog v2.2.11:
 * - ADDED: Emits 'signal' event with value 'rtc_rejected' when WebRTC is discarded due to lower priority.
 * This allows the parent controller to stop upgrade timers immediately.
 * * Changelog v2.2.10:
 * - FIX: 'onopen' no longer wipes external message handlers (ui_sync).
 * * Changelog v2.2.9:
 * - FIX: Renamed 'this.id' to 'this.clientId' to avoid DOM conflict.
 */
export class VideoRTC extends HTMLElement {
    constructor() {
        super();

        // [TRACE] Generate a short random ID for this session (e.g., "X7K9P")
        // Renamed to clientId to avoid conflict with HTMLElement.id
        this.clientId = Math.random().toString(36).substring(2, 7).toUpperCase();

        // No-media watchdog: if the socket stays open but no media bytes arrive
        // for this long, treat the stream as stalled and force a reconnect.
        this.DISCONNECT_TIMEOUT = 5000;

        // Phase-aware variant of the above (v2.4.3). While an un-committed RTC probe is live
        // (_rtcPhase 'negotiating'/'promoted') the RTC overlay is additive load on the link; a
        // ws MSE-media silence there is almost certainly that experiment choking the link (the
        // multi-camera 4G collapse), so we bail at this shorter deadline to free the link and
        // fall back to the still-warm MSE (~1 frame revert, not a black screen). 'warm' and
        // 'committed' keep the full DISCONNECT_TIMEOUT. Set to 0 to disable the shortening.
        this.NEGOTIATING_DISCONNECT_TIMEOUT = 2500;

        // First-frame watchdog: 'connectionState=connected' is NOT proof of a working
        // WebRTC stream. On multi-hop paths ICE/DTLS connectivity checks (tiny packets)
        // can pass while the sustained RTP media never traverses, so the pc sits
        // "connected" but no frame is ever decoded. If no frame decodes within this long
        // after 'connected', treat it as a WebRTC failure so the connection can be
        // dropped and retried with a freshly gathered ICE path instead of lingering as a
        // media-less zombie.
        // 600s: because the swap is gated on a real decoded frame (see onwebrtc), MSE
        // keeps serving the user while the pc waits, so a slow-but-real first frame
        // (observed to take minutes on repeater paths) must not be reaped early. Only
        // genuinely media-less paths hit this deadline. Tunable.
        // Default 120s (v2.3.4, was 600000): on a path where the pc reaches "connected" but
        // never decodes a frame (e.g. cloudflared tunnel), 10min was a wasteful zombie pc;
        // 2min gives a slow-but-real repeater first frame ample room while reaping dead paths
        // far sooner. Overridable per-card via `firstframe_timeout` (ms) in the card YAML.
        this.FIRSTFRAME_TIMEOUT = 120000;
        this._firstFrameTID = 0;   // first-frame watchdog timer handle
        this._firstFramePoll = 0;  // getStats() poll interval handle (framesDecoded)
        // After handoff the RTC media flows P2P off the ws, so the MSE no-data
        // watchdog can never see it stall. This is the liveness deadline for the
        // *promoted* RTC stream: if framesDecoded stops advancing for this long the
        // picture is frozen/black and we recover (reconnect -> MSE + fresh probe).
        // Long enough to ride out a brief congestion pause, short enough that a dead
        // handoff self-heals in seconds instead of staying black forever. Tunable.
        // Post-promotion stall deadline (framesDecoded stops advancing this long).
        // In the reversible flow (see onwebrtc) a stall BEFORE commit reverts to the
        // still-warm MSE instantly (one frame, no reconnect); AFTER commit it reconnects.
        // 15s matches the value the historically-working handoff used: short enough to
        // self-heal fast, long enough to ride the brief congestion pauses that are normal
        // on repeater paths (8s was too twitchy and reverted on ordinary bursts). Tunable.
        this.RTC_LIVENESS_TIMEOUT = 15000;

        // [REVERSIBLE RTC — EXPLICIT PHASE, v2.3.5] The driver keeps its MSE stream ATTACHED
        // and warm on this.video and decodes WebRTC on a second, overlaid <video>
        // (this._rtcVideo). The handoff is a 4-state machine on this._rtcPhase:
        //   'warm'        no RTC overlay — MSE only (initial state, and after a revert).
        //   'negotiating' overlay decoding, still hidden (opacity 0); MSE warm. REVERSIBLE.
        //   'promoted'    overlay revealed to the user; MSE still warm underneath. REVERSIBLE.
        //   'committed'   overlay collapsed onto this.video, MSE released, ws closed. This is
        //                 the ONLY irreversible state (a later stall must reconnect).
        // Legal edges: warm -> negotiating -> promoted -> committed, plus
        // negotiating/promoted -> warm (revert). Every edge goes through _setPhase() so the
        // transition is logged in exactly one place (free observability, no counters).
        this._rtcVideo = null;     // overlaid <video> carrying the RTC MediaStream
        this._rtcPhase = 'warm';   // 'warm' | 'negotiating' | 'promoted' | 'committed'
        this._manualHold = false;  // [MANUAL PAUSE] user soft-paused: freeze the on-screen element
                                   // AND hold the commit/revert poll so it can't auto-resume.
        this._commitTID = 0;       // unused in the poll-driven commit model; kept for _clearRtcTimers
        this._mseWanted = false;   // desired mute state of the MSE element, restored on revert/commit
        // Flowing decode required before we REVEAL RTC (make it visible). Small because
        // the overlay is rendered (full-rate decode) and promotion is reversible, so we can
        // be aggressive and restore near-instant RTC on good paths. Tunable.
        this.RTC_PROMOTE_MS = 2000;
        // CONTINUOUS gapless liveness required AFTER promotion before we commit (release MSE).
        // Committing is the ONLY irreversible step (MSE gone -> a later stall must reconnect),
        // so it must be reserved for paths that are genuinely rock-solid. This is deliberately
        // long: any decode gap > RTC_STALL_RESET restarts the clock (see the poll below), so a
        // bursty repeater camera never reaches it — it just stays in warm-MSE mode and reverts
        // harmlessly on each stall. Only a camera that decodes essentially gaplessly for this
        // whole window releases MSE (freeing the 2nd decoder + the LAN-side dual bandwidth), and
        // for such a camera a post-commit stall is rare. 30s was far too short: cameras that
        // held RTC briefly got committed and then crash-looped on the next stall. Tunable.
        this.RTC_COMMIT_MS = 180000;
        // A decode gap longer than this (but shorter than RTC_LIVENESS_TIMEOUT) counts as
        // instability and restarts the commit stability clock without reverting. Tunable.
        this.RTC_STALL_RESET = 2000;
        // GAPLESS liveness after promotion before we emit a one-shot `rtc_sustained` signal.
        // This is the SHADOW-SWAP gate: the card keeps the old (proven) main visible and only
        // swaps a background shadow in AFTER the shadow's RTC has held gaplessly this long — so
        // a shadow that promotes at 2s but stalls (bursty/throttled path) NEVER triggers a swap,
        // and the working MSE main is never destroyed for an unproven replacement. Deliberately
        // set well beyond RTC_LIVENESS_TIMEOUT (15s) so surviving it is real evidence the path
        // is better than the reverted main, while staying far below the full 180s commit so a
        // genuinely good upgrade still lands quickly. Default 30s (v2.3.4, was 20000): on a
        // throttled path RTC dies at ~15s, so a 5s margin let the odd "lucky" shadow swap in
        // only to fall back seconds later; 30s doubles the evidence window (zero effect on good
        // nets, which never use the swap). Overridable per-card via `rtc_swap_prove_ms` (ms).
        this.RTC_SWAP_PROVE_MS = 30000;

        this._lastLiveness = 0;    // Date.now() of the last framesDecoded advance
        this._stableSince = 0;     // start of the current gapless run (drives the commit clock)
        this._sustainedSignaled = false; // guards the one-shot rtc_sustained (shadow-swap) signal

        // [BW INSTRUMENTATION v2.4.1] Passive metric sampler state (see _sampleMetrics). Emits a
        // compact `metrics` line to the card every METRICS_EMIT_MS, harvested from the getStats
        // poll already running for framesDecoded. Diagnostic only — never feeds stream decisions.
        this._mLastBytes = -1;    // previous inbound-rtp bytesReceived (delta -> goodput)
        this._mLastRecv = -1;     // previous packetsReceived           (delta -> loss %)
        this._mLastLost = -1;     // previous packetsLost               (delta -> loss %)
        this._mRttMin = Infinity; // session-min candidate-pair RTT (bufferbloat baseline)
        this._mNextEmit = 0;      // Date.now() gate for the next emit
        this.METRICS_EMIT_MS = 3000; // sampling cadence; bypasses the card's 10s log throttle
        // [TRANSPORT DIAGNOSTICS v2.6.0] Extra getStats fields to settle bufferbloat-vs-fragmentation
        // on the direct-4G path (see the CF-tunnel control run 2026-08-26). `path` = selected
        // candidate-pair local/remote candidateType + protocol (relay/srflx/host, udp/tcp) — tests the
        // "UDP-to-TURN vs TCP-over-CF" hypothesis directly. `jbuf` = avg jitter-buffer delay (ms),
        // the receiver-side bufferbloat tell (grows when packets queue). `nack` = retransmit requests
        // over the window, the loss/fragmentation tell. `pkt` = avg received packet size (B), the MTU
        // tell (near/over ~1200 sustained -> suspect IP fragmentation). All diagnostic ONLY.
        this._mLastJbDelay = -1;  // previous inbound-rtp jitterBufferDelay (cumulative s)
        this._mLastJbEmit = -1;   // previous inbound-rtp jitterBufferEmittedCount
        this._mLastNack = -1;     // previous inbound-rtp nackCount

        // [ADAPTIVE WATCHDOG v2.5.0 / Strato-1] The MSE no-data watchdog timeout is no longer a
        // fixed constant. A tiny in-loop controller turns the passive metrics above into a smoothed
        // `congestion` score in [0,1] and EXTENDS the effective watchdog up to ADAPT_MAX_EXTEND× the
        // base while a link is congested — it NEVER shortens below the base. Field-validated
        // 2026-08-26 (mse_timeout:0 run): on a congested 4G multi-cam grid the RTC upgrade is
        // ADDITIVE load that transiently starves the warm MSE (rttExcess ballooned to ~21s, loss to
        // 40%+, yet the socket never died and all 4 cams converged to clean RTC once committed). A
        // fixed 5s watchdog tears such a recoverable stream down (the reconnect storm). Extending
        // ONLY while an un-committed RTC probe is live, then decaying back to the tight base, lets a
        // real stall ride out while still reaping a genuinely dead warm MSE-only stream on time.
        // The high/low-band paths thus diverge from IDENTICAL code: the substream rarely congests so
        // it keeps the tight base; the main saturates the link and earns the extension automatically.
        // Signal: rttExcess = rtt - session-min-rtt (bufferbloat, the leading indicator), reinforced
        // by loss and by a decaying penalty for recent doomed RTC promotes (`_rtcFutility`). All
        // thresholds are parametric (overridable per-card) even though the loop self-adapts.
        this.ADAPTIVE_WATCHDOG = true;   // master switch (per-card `mse_adaptive`)
        this.ADAPT_RTT_EXCESS_MS = 400;  // rttExcess (ms) that alone drives congestion -> 1
        this.ADAPT_LOSS_PCT = 20;        // loss (%) that alone drives congestion -> 1
        this.ADAPT_MAX_EXTEND = 6;       // hard cap on the timeout multiplier (5s base -> 30s)
        this.ADAPT_EWMA_ALPHA = 0.3;     // congestion EWMA smoothing (higher = twitchier)
        this._congestion = 0;            // smoothed congestion score [0,1]
        this._rtcFutility = 0;           // decaying penalty for recent doomed RTC promotes [0,1]

        // [STRATO-1 STEP 3 — RTC ABORT, v2.7.0] The adaptive watchdog above EXTENDS tolerance while a
        // link is congested — correct on a RECOVERABLE path (CF-tunnel field run: transient ~2s RTT,
        // converges), but on a PATHOLOGICAL path (direct-4G field run 2026-08-26) it PROLONGS a doomed
        // RTC storm: 4 uncoordinated GCC flows overshoot one 4G uplink into a deep carrier buffer, the
        // jitter-buffer balloons to ~2s and RTT plateaus at a standing 1.5s that never drains — classic
        // bufferbloat (confirmed by the v2.6.0 diagnostics: jbuf 1500-2100ms, RTT standing plateau, pkt
        // NOT MTU-pinned, loss moderate → not fragmentation; path=srflx/…/udp → direct UDP, not TURN).
        // `cong` CANNOT gate the abort: it SATURATES (~1.0 for both 800ms and 20s RTT past
        // ADAPT_RTT_EXCESS_MS), so it can't tell recoverable bufferbloat from pathological — a cong-based
        // abort would have killed the CF run that converged. The abort therefore keys on UNSATURATED
        // ABSOLUTE ceilings: jitter-buffer delay (jbuf) OR RTT above a hard limit, sustained. When an
        // un-committed RTC probe holds a pathological reading for RTC_ABORT_HOLD_MS we revert to the warm
        // MSE at once (deterministic ~6-9s teardown) instead of letting the extend balloon to 30×. The
        // revert bumps `_rtcFutility`, which now SHORTENS the next probe's abort hold (a repeatedly-doomed
        // path gives up faster) — futility drives SUPPRESSION, no longer the extend (that inversion is
        // fixed in _updateCongestion). rtc_failed then arms the card's backed-off re-probe loop. All
        // thresholds parametric (per-card mse_abort* knobs); set mse_abort:false to disable.
        this.RTC_ABORT_ENABLED = true;   // master switch (per-card `mse_abort`)
        this.RTC_ABORT_JBUF_MS = 1200;   // jitter-buffer delay (ms) that flags a pathological path
        this.RTC_ABORT_RTT_MS = 5000;    // candidate-pair RTT (ms) that flags a pathological path
        this.RTC_ABORT_HOLD_MS = 6000;   // both above sustained this long (at futility 0) -> abort
        this.RTC_ABORT_FUTILITY_K = 0.5; // futility [0,1] shortens the hold toward HOLD*(1-K)
        this._abortSince = 0;            // Date.now() the pathological reading first went bad (0 = clear)

        // List of supported codecs to announce to the server
        this.CODECS = [
            'avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0',
            'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus',
        ];

        // CONFIGURATION FLAGS
        // strictMode: false = Ignore minor errors (faster load). true = Disconnect on any error (safer).
        this.strictMode = false; 

        this.mode = 'webrtc,mse,hls,mjpeg';
        this.media = 'video,audio';

        // Standard WebRTC Configuration. Two INDEPENDENT public STUN servers (Google +
        // Cloudflare, #915): STUN only lets the browser discover its own public srflx
        // candidate — the provider identity affects reachability, not function — so two
        // anycast providers on different orgs mean that if one is blocked/filtered/down
        // (some ISPs/countries block Google), the other still answers. Covers ~every
        // STUN-solvable NAT; CGNAT/symmetric NAT still needs the user's own TURN via the
        // per-card `ice_servers` option, which REPLACES this default (see webrtc-camera.js).
        // Privacy opt-out: `ice_servers: []` in the card removes all defaults (no third party).
        this.pcConfig = {
            bundlePolicy: 'max-bundle',
            iceServers: [
                {urls: 'stun:stun.l.google.com:19302'},
                {urls: 'stun:stun.cloudflare.com:3478'},
            ],
            sdpSemantics: 'unified-plan',
        };

        // Internal State
        this.video = null; // The <video> DOM element
        this.ws = null;    // The Signaling WebSocket
        this.wsURL = '';
        this.pc = null;    // The WebRTC PeerConnection
        this.connectTS = 0;
        this.mseCodecs = '';
        this.reconnectTID = 0; // no-data watchdog timer handle
        this.ondata = null;
        this.onmessage = {};

        // Re-entrancy guard for onclose(): once we've dispatched 'connection-closed'
        // for this connection we must not dispatch it again when the socket we
        // proactively closed fires its own (async) close event.
        this._notifiedClosed = false;
        
        // CRITICAL: "Handoff" state.
        // If true, it means we are closing the WebSocket on purpose because
        // we switched to WebRTC. It prevents the "connection-closed" event
        // from triggering a restart loop.
        this.handoff = false;
    }

    /**
     * Entry point: Setting 'src' triggers the connection process.
     * Handles both absolute (http/ws) and relative (/) URLs.
     */
    set src(value) {
        if (typeof value !== 'string') value = value.toString();
        if (value.startsWith('http')) {
            value = 'ws' + value.substring(4);
        } else if (value.startsWith('/')) {
            value = 'ws' + location.origin.substring(4) + value;
        }
        
        // [TRACE] Append Client ID to URL for server-side logging correlation
        const separator = value.includes('?') ? '&' : '?';
        this.wsURL = value + separator + 'client_id=' + this.clientId;
        
        this.onconnect();
    }

    /**
     * Safe Play Method.
     * 1. Checks if already playing to avoid CPU waste (Promise churn).
     * 2. Handles the "Autoplay Policy" error by muting and retrying.
     */
    play() {
        // OPTIMIZATION: If video exists and is playing, do nothing.
        // Saves CPU cycles on mobile devices.
        if (!this.video || !this.video.paused) return;

        this.video.play().catch(er => {
            if (er.name === 'AbortError') return; // Ignore aborts (user navigated away)

            // Mute-fallback ONLY on a real autoplay-policy block (NotAllowedError).
            // Other rejections (transient decode errors, races during reconnect) must
            // NOT force a permanent mute — that silences audio for a non-audio reason.
            if (er.name === 'NotAllowedError' && !this.video.muted) {
                this.video.muted = true;
                this.video.play().catch(e => console.debug(`[VideoRTC:${this.clientId}] Autoplay warn:`, e));
            } else {
                console.debug(`[VideoRTC:${this.clientId}] play() rejected:`, er);
            }
        });
    }

    /**
     * [MANUAL PAUSE — card #913] The element the viewer actually sees. While RTC is REVEALED but
     * not yet committed (`promoted`), the on-screen pixels are the overlay (`_rtcVideo`) and the
     * MSE element (`this.video`) is hidden underneath; warm/negotiating/committed all present
     * `this.video`. The card binds the play/pause button and the live-indicator dot to THIS getter
     * so both act on what's on screen, not on the hidden MSE element (the old bug: pause froze the
     * invisible MSE while RTC kept playing; the dot watched the stalled hidden MSE and went red on
     * a perfect RTC stream).
     */
    get onscreenVideo() {
        return (this._rtcPhase === 'promoted' && this._rtcVideo) ? this._rtcVideo : this.video;
    }

    /**
     * [MANUAL PAUSE] Soft-freeze the on-screen element and HOLD the RTC handoff poll so its
     * commit/revert can't call play() and silently auto-resume (which would defeat the pause).
     * Intentionally does NOT free the decoder or close the socket — that's the OFF-SCREEN
     * auto-pause's job (bandwidth). A viewer pausing a stream they're watching wants an instant
     * freeze and an instant resume, so the flow is kept warm.
     */
    suspend() {
        this._manualHold = true;
        const v = this.onscreenVideo;
        if (v) v.pause();
    }

    resume() {
        this._manualHold = false;
        const v = this.onscreenVideo;
        if (!v) return;
        // MSE keeps only ~5s of buffer, so after a longer pause currentTime lags behind the buffer
        // start; jump to the live edge before playing. A MediaStream/RTC element has empty
        // seekable and is unaffected.
        try {
            const seek = v.seekable;
            if (seek && seek.length > 0) v.currentTime = seek.end(seek.length - 1);
        } catch (e) { /* ignore */ }
        v.play().catch(() => {});
    }

    /**
     * [MUTE — card] Set the audio state the way the card's volume button should: apply it to the
     * element that is actually AUDIBLE (the on-screen one — the overlay while promoted, else
     * this.video) AND record it as `_mseWanted`, the driver's desired-audio state that promote/
     * commit/revert restore. Toggling `this.video.muted` directly (the old card path) muted the
     * hidden MSE while the audible overlay kept its sound, and the next handoff transition then
     * overwrote the user's choice from the stale `_mseWanted`.
     */
    setMuted(muted) {
        this._mseWanted = muted;
        const v = this.onscreenVideo;
        if (v) v.muted = muted;
    }

    /**
     * Helper to send JSON messages over the WebSocket.
     */
    send(value) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(value));
        }
    }

    /**
     * Filter the CODECS list based on what the browser actually supports.
     */
    codecs(isSupported) {
        return this.CODECS
            .filter(codec => this.media.includes(codec.includes('vc1') ? 'video' : 'audio'))
            .filter(codec => isSupported(`video/mp4; codecs="${codec}"`)).join();
    }

    /**
     * Web Component Lifecycle: Called when element is added to DOM.
     * Starts the initialization loop.
     */
    connectedCallback() {
        if (this.video) {
            // Restore playback position if re-attaching
            const seek = this.video.seekable;
            if (seek.length > 0) {
                this.video.currentTime = seek.end(seek.length - 1);
            }
            this.play();
        } else {
            this.oninit();
        }
    }

    disconnectedCallback() { 
        // We do not auto-disconnect here. The parent component controls lifecycle.
    }

    /**
     * Creates the <video> element and appends it to the shadow DOM.
     * Contains specific fixes for Safari.
     */
    oninit() {
        if (this.video) return;
        this.video = document.createElement('video');
        this.video.controls = true;
        this.video.playsInline = true;
        this.video.preload = 'auto';
        this.video.style.display = 'block';
        this.video.style.width = '100%';
        this.video.style.height = '100%';
        this.appendChild(this.video);

        this.video.addEventListener('error', ev => {
            if (this.video.error && this.video.error.code === 4) return;
            console.warn(`[VideoRTC:${this.clientId}] Video Error:`, this.video.error);
        });

        // SAFARI HACK: Safari lies about supported codecs or has bugs with specific ones.
        // We filter out codecs that are known to break on specific Safari versions.
        const m = window.navigator.userAgent.match(/Version\/(\d+).+Safari/);
        if (m) {
            const skip = m[1] < '13' ? 'mp4a.40.2' : m[1] < '14' ? 'flac' : 'opus';
            const idx = this.CODECS.indexOf(skip);
            if (idx > -1) this.CODECS.splice(idx, 1);
        }
    }

    /**
     * Establish the WebSocket connection.
     */
    onconnect() {
        if (!this.isConnected || !this.wsURL || this.ws || this.pc) return false;

        this.connectTS = Date.now();
        this.handoff = false; // Reset handoff state
        this._notifiedClosed = false; // Fresh connection: allow one close notification
        this._closeReason = null; // Fresh connection: reset the diagnostic close reason

        this.ws = new WebSocket(this.wsURL);
        this.ws.binaryType = 'arraybuffer';
        
        this.ws.addEventListener('open', () => this.onopen());
        this.ws.addEventListener('close', () => this.onclose());
        
        // Error Handling Logic
        this.ws.addEventListener('error', (e) => {
            if (this.strictMode) {
                // STRICT: Fail fast on any error
                console.warn(`[VideoRTC:${this.clientId}] WebSocket Error (Strict): Force Closing`, e);
                this._closeReason = 'ws-error';
                this.onclose();
            } else {
                // RELAXED: Log but keep trying (allows recovery from minor glitches)
                console.debug(`[VideoRTC:${this.clientId}] WebSocket Error (Relaxed): Ignored`, e);
            }
        });

        return true;
    }

    /**
     * No-media watchdog.
     * Re-armed on every media byte. If media stops flowing while the socket is
     * still technically open (frozen MSE, or a black-holed path that never sends
     * a FIN/RST), no 'close' event ever fires and the parent never learns the
     * stream is dead. When the timer elapses we force onclose(), which dispatches
     * 'connection-closed' and lets the card reconnect.
     */
    _feedWatchdog() {
        if (!this.DISCONNECT_TIMEOUT) return;
        if (this.reconnectTID) clearTimeout(this.reconnectTID);
        // This watchdog is fed by binary WS bytes = the MSE fMP4 chunks (onopen's message
        // handler). RTC media flows P2P and never touches it, so this measures MSE liveness
        // ONLY. Therefore it always uses the full DISCONNECT_TIMEOUT.
        //
        // v2.4.6 REVERTS the v2.4.3 phase-aware shortening (2.5s while negotiating/promoted).
        // Field data (congested 4G, loss 29-54%, 4 cams) proved it self-defeating on TWO fronts:
        //   (1) It shortened the guardian of the MSE, not the RTC probe. Under TCP-over-lossy-uplink
        //       the MSE arrives in bursts with >2.5s gaps despite 70-114 KB/s average goodput, so
        //       the 2.5s window FALSE-fired and `onclose()` tore down the whole connection — the
        //       working MSE included (the old "reverts to MSE, ~1 frame" claim was wrong: onclose
        //       kills MSE too, hence the mode:mse->none retry storm).
        //   (2) Deaths at ~2.5s landed BEFORE the first `metrics` (loss%) line was emitted, so the
        //       card's A0 severity gate (latch rtc-suppressed on the first death with a fresh
        //       loss ≥20% sample) had no data and never latched fast — the exact opposite of the
        //       "reach MSE-only suppression faster" goal. At the full 5s the loss sample lands
        //       first, so A0 latches on the first bad death and 4xMSE settles.
        // Abandoning a doomed RTC probe fast is the job of the RTC give-up/first-frame watchdog +
        // the card's narrow-link suppression, NOT this MSE no-data watchdog.
        // [ADAPTIVE WATCHDOG v2.5.0] Effective timeout = base, EXTENDED while an un-committed RTC
        // probe is congesting the warm MSE (see _effectiveDisconnectTimeout). Re-armed on every MSE
        // byte, so it tracks live congestion. v2.4.6's "always base" comment above still holds for
        // the 'warm'/'committed' phases; the extension applies only to negotiating/promoted.
        const timeout = this._effectiveDisconnectTimeout();
        this.reconnectTID = setTimeout(() => {
            this.reconnectTID = 0;
            console.warn(`[VideoRTC:${this.clientId}] No-data watchdog fired (${timeout}ms silent, phase=${this._rtcPhase}, cong=${this._congestion.toFixed(2)}). Forcing close.`);
            this.handoff = false; // a stall is a failure, not an intentional handover
            this._closeReason = 'no-data-watchdog';
            this.onclose();
        }, timeout);
    }

    _clearWatchdog() {
        if (this.reconnectTID) {
            clearTimeout(this.reconnectTID);
            this.reconnectTID = 0;
        }
    }

    /**
     * [ADAPTIVE WATCHDOG] Fold one metrics sample into the smoothed `congestion` score. The
     * instantaneous congestion is the STRONGER of two independent, self-normalizing stressors
     * (either alone is enough to be "congested"): queueing delay rttExcess = rtt - session-min-rtt
     * (bufferbloat) scaled by ADAPT_RTT_EXCESS_MS, and loss% scaled by ADAPT_LOSS_PCT. An EWMA damps
     * the whole thing (no discrete flapping). All inputs in ms / percent; -1 = no sample.
     *
     * v2.7.0 FIXES THE FUTILITY INVERSION: `_rtcFutility` no longer feeds `inst` here. Folding it in
     * RAISED congestion after a doomed promote, which under _effectiveDisconnectTimeout EXTENDED the
     * watchdog — i.e. it babied the very RTC probe that just failed (backwards). Futility now drives
     * SUPPRESSION only: it shortens the abort hold in _evaluateAbort. Its decay lives here (per emit)
     * so a good stretch bleeds the penalty off.
     */
    _updateCongestion(rttMs, baseMs, lossPct) {
        let inst = 0;
        if (rttMs >= 0 && baseMs >= 0 && this.ADAPT_RTT_EXCESS_MS > 0) {
            const excess = Math.max(0, rttMs - baseMs);
            inst = Math.max(inst, Math.min(1, excess / this.ADAPT_RTT_EXCESS_MS));
        }
        if (lossPct >= 0 && this.ADAPT_LOSS_PCT > 0) {
            inst = Math.max(inst, Math.min(1, lossPct / this.ADAPT_LOSS_PCT));
        }
        this._rtcFutility *= 0.9;                       // decay ~1 sample; consumed by _evaluateAbort
        const a = this.ADAPT_EWMA_ALPHA;
        this._congestion = a * inst + (1 - a) * this._congestion;
    }

    /**
     * [STRATO-1 STEP 3] Abort a non-committing RTC probe stuck on a pathological (bufferbloat)
     * path. Called once per metrics emit (3s) with the freshest instantaneous RTT and windowed
     * jitter-buffer delay — both UNSATURATED absolute signals, unlike `cong`. A reading is
     * "pathological" when jbuf OR RTT is at/over its hard ceiling; only while an un-committed RTC
     * probe is live (negotiating/promoted) and once it has HELD that long do we give up. `_rtcFutility`
     * shortens the hold toward HOLD*(1-K), so a path that keeps failing gives up progressively faster.
     * A definitively healthy sample clears the pending abort; a sample with no usable signal neither
     * arms nor disarms (avoids the jbuf=? gaps resetting the timer). ms in; -1 = no sample.
     */
    _evaluateAbort(rttMs, jbufMs) {
        if (!this.RTC_ABORT_ENABLED) return;
        const probing = this._rtcPhase === 'negotiating' || this._rtcPhase === 'promoted';
        if (!probing) { this._abortSince = 0; return; }
        const rttBad = this.RTC_ABORT_RTT_MS > 0 && rttMs >= 0 && rttMs >= this.RTC_ABORT_RTT_MS;
        const jbufBad = this.RTC_ABORT_JBUF_MS > 0 && jbufMs >= 0 && jbufMs >= this.RTC_ABORT_JBUF_MS;
        if (rttBad || jbufBad) {
            const now = Date.now();
            if (!this._abortSince) { this._abortSince = now; return; }
            const k = Math.max(0, Math.min(1, this.RTC_ABORT_FUTILITY_K));
            const hold = this.RTC_ABORT_HOLD_MS * (1 - k * Math.max(0, Math.min(1, this._rtcFutility)));
            if (now - this._abortSince >= hold) {
                const held = now - this._abortSince;
                this._abortSince = 0;
                this._abortRtcProbe(rttMs, jbufMs, Math.round(hold), held);
            }
            return;
        }
        // Not bad this sample. Clear the pending abort only on a DEFINITIVELY healthy reading;
        // a window with no usable signal leaves the timer running.
        const rttGood = rttMs >= 0 && (this.RTC_ABORT_RTT_MS <= 0 || rttMs < this.RTC_ABORT_RTT_MS);
        const jbufGood = jbufMs >= 0 && (this.RTC_ABORT_JBUF_MS <= 0 || jbufMs < this.RTC_ABORT_JBUF_MS);
        if (rttGood || jbufGood) this._abortSince = 0;
    }

    /**
     * [STRATO-1 STEP 3] Give up on the current pathological RTC probe: snap back to the warm MSE
     * (one-frame recovery, MSE never stopped). _revertToWarmMSE bumps `_rtcFutility` (shorter next
     * hold) and emits `rtc_failed`, which arms the card's backed-off re-probe loop (the suppression).
     */
    _abortRtcProbe(rttMs, jbufMs, hold, held) {
        console.warn(`[VideoRTC:${this.clientId}] RTC probe ABORTED — pathological path ` +
            `(rtt=${rttMs}ms jbuf=${jbufMs}ms held ${held}ms >= ${hold}ms, phase=${this._rtcPhase}, ` +
            `futility=${this._rtcFutility.toFixed(2)}).`);
        this._revertToWarmMSE(`RTC aborted: pathological path (rtt=${rttMs}ms, jbuf=${jbufMs}ms sustained)`);
    }

    /**
     * [ADAPTIVE WATCHDOG] The live no-data timeout: the base (this.DISCONNECT_TIMEOUT, i.e. the
     * per-card `mse_timeout` or the 5s default) EXTENDED by up to ADAPT_MAX_EXTEND× in proportion
     * to smoothed congestion — but ONLY while an un-committed RTC probe is live (negotiating /
     * promoted), the one window where the MSE is starved by additive RTC load. In 'warm' (MSE-only:
     * the pc-less regime with no rtt samples — a stall there means the stream is genuinely dead) and
     * 'committed' (MSE already released) it returns the base unchanged, so a dead stream is still
     * reaped on time. Never returns less than base; 0 (disabled) is honored by the caller's guard.
     */
    _effectiveDisconnectTimeout() {
        const base = this.DISCONNECT_TIMEOUT;
        if (!base || !this.ADAPTIVE_WATCHDOG) return base;
        const rtcProbing = this._rtcPhase === 'negotiating' || this._rtcPhase === 'promoted';
        if (!rtcProbing) return base;
        const mult = 1 + (this.ADAPT_MAX_EXTEND - 1) * Math.max(0, Math.min(1, this._congestion));
        return Math.round(base * mult);
    }

    /**
     * [BW INSTRUMENTATION v2.4.1] Passive metric sampler. Called every 500ms from the getStats
     * poll; accumulates deltas over METRICS_EMIT_MS and emits a compact `metrics` line to the
     * card. Side-effect-free w.r.t. the stream — it only observes and logs, so it is safe on
     * every path (fat LAN included: same numbers, just now visible). Goal: see on real links
     * whether RTT bufferbloat / rising loss PRECEDES the reverts that collapse mobile sessions.
     */
    _sampleMetrics(bytes, recv, lost, jit, rtt, jbDelay = -1, jbEmit = -1, nack = -1, path = '') {
        const now = Date.now();
        if (rtt >= 0 && rtt < this._mRttMin) this._mRttMin = rtt;
        if (now < this._mNextEmit) return;
        // Prime the deltas on the first tick so the first emitted goodput isn't a bogus spike.
        if (this._mLastBytes < 0) {
            this._mLastBytes = bytes; this._mLastRecv = recv; this._mLastLost = lost;
            this._mLastJbDelay = jbDelay; this._mLastJbEmit = jbEmit; this._mLastNack = nack;
            this._mNextEmit = now + this.METRICS_EMIT_MS;
            return;
        }
        // Nothing decoding yet (no pc stats this window) → skip the emit but keep the clock moving.
        if (rtt < 0 && bytes < 0) { this._mNextEmit = now + this.METRICS_EMIT_MS; return; }

        const dtSec = this.METRICS_EMIT_MS / 1000;
        const dBytes = bytes >= 0 && this._mLastBytes >= 0 ? Math.max(0, bytes - this._mLastBytes) : -1;
        const gp = dBytes >= 0 ? dBytes / 1024 / dtSec : -1;                    // KB/s over the window
        const dLost = lost >= 0 && this._mLastLost >= 0 ? Math.max(0, lost - this._mLastLost) : -1;
        const dRecv = recv >= 0 && this._mLastRecv >= 0 ? Math.max(0, recv - this._mLastRecv) : -1;
        const lossPct = dLost >= 0 && dRecv >= 0 && (dLost + dRecv) > 0
            ? (100 * dLost / (dLost + dRecv)) : -1;
        // [TRANSPORT DIAGNOSTICS v2.6.0] windowed deltas for the bufferbloat-vs-fragmentation call.
        const dJbDelay = jbDelay >= 0 && this._mLastJbDelay >= 0 ? Math.max(0, jbDelay - this._mLastJbDelay) : -1;
        const dJbEmit = jbEmit >= 0 && this._mLastJbEmit >= 0 ? Math.max(0, jbEmit - this._mLastJbEmit) : -1;
        const jbufMs = dJbDelay >= 0 && dJbEmit > 0 ? Math.round(1000 * dJbDelay / dJbEmit) : -1;
        const dNack = nack >= 0 && this._mLastNack >= 0 ? Math.max(0, nack - this._mLastNack) : -1;
        const pktB = dBytes >= 0 && dRecv > 0 ? Math.round(dBytes / dRecv) : -1; // avg received packet size
        if (bytes >= 0) this._mLastBytes = bytes;
        if (recv >= 0) this._mLastRecv = recv;
        if (lost >= 0) this._mLastLost = lost;
        if (jbDelay >= 0) this._mLastJbDelay = jbDelay;
        if (jbEmit >= 0) this._mLastJbEmit = jbEmit;
        if (nack >= 0) this._mLastNack = nack;
        this._mNextEmit = now + this.METRICS_EMIT_MS;

        const rttMs = rtt >= 0 ? Math.round(rtt * 1000) : -1;
        const baseMs = this._mRttMin < Infinity ? Math.round(this._mRttMin * 1000) : -1;
        // [ADAPTIVE WATCHDOG] Drive the congestion controller from this sample (rttExcess + loss).
        this._updateCongestion(rttMs, baseMs, lossPct);
        // [STRATO-1 STEP 3] Give up a doomed RTC probe on absolute (unsaturated) jbuf/RTT ceilings.
        this._evaluateAbort(rttMs, jbufMs);
        const summary =
            `phase=${this._rtcPhase} rtt=${rttMs}ms(min ${baseMs}) ` +
            `loss=${lossPct >= 0 ? lossPct.toFixed(1) : '?'}% gp=${gp >= 0 ? gp.toFixed(0) : '?'}kb/s ` +
            `jit=${jit >= 0 ? Math.round(jit * 1000) : '?'}ms cong=${this._congestion.toFixed(2)} ` +
            `jbuf=${jbufMs >= 0 ? jbufMs : '?'}ms nack=${dNack >= 0 ? dNack : '?'} ` +
            `pkt=${pktB >= 0 ? pktB : '?'}B path=${path || '?'}`;
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({ type: 'metrics', value: summary });
        }
    }

    /**
     * The Destructor. Clean up ALL resources.
     */
    ondisconnect() {
        this._clearWatchdog();
        if (this._firstFrameTID) {
            clearTimeout(this._firstFrameTID);
            this._firstFrameTID = 0;
        }
        if (this._firstFramePoll) {
            clearInterval(this._firstFramePoll);
            this._firstFramePoll = 0;
        }
        if (this._commitTID) {
            clearTimeout(this._commitTID);
            this._commitTID = 0;
        }
        // [REVERSIBLE HANDOFF] Tear down the RTC overlay element if one is live.
        if (this._rtcVideo) {
            try { this._rtcVideo.srcObject = null; this._rtcVideo.remove(); } catch (e) { /* ignore */ }
            this._rtcVideo = null;
        }
        this.ondata = null;
        this.onmessage = {};
        
        // 1. Close WebSocket
        if (this.ws) {
            this.ws.onclose = null; 
            this.ws.onerror = null;
            this.ws.close();
            this.ws = null;
        }
        
        // 2. Close WebRTC
        if (this.pc) {
            // OPTIMIZATION: Manually nullify event handlers.
            // Helps Safari/iOS Garbage Collector break circular references
            // and release the hardware video decoder immediately.
            this.pc.onicecandidate = null;
            this.pc.ontrack = null;
            this.pc.onconnectionstatechange = null;

            this.pc.getSenders().forEach(sender => {
                if (sender.track) sender.track.stop();
            });
            this.pc.close();
            this.pc = null;
        }
        
        // 3. Clear Video
        if (this.video) {
            // [MEMORY] Revoke the MSE blob URL on the legacy MediaSource path
            // (Chrome/Firefox: video.src = URL.createObjectURL(ms), onmse()).
            // Normally the {once} 'sourceopen' handler already revoked it, but if
            // this driver is torn down BEFORE sourceopen fires (a shadow reaped
            // within ms, or teardown mid-negotiation) that handler never ran, so
            // the blob->MediaSource mapping would leak. Revoke here too: a double
            // revoke is a harmless no-op. The ManagedMediaSource path uses
            // srcObject (src stays ''), so the blob: guard skips it.
            if (this.video.src && this.video.src.startsWith('blob:')) {
                URL.revokeObjectURL(this.video.src);
            }
            this.video.src = '';
            this.video.srcObject = null;
        }
    }

    /**
     * Called when WebSocket opens. Sets up message routing.
     */
    onopen() {
        // GUARD: this.mode normally arrives from the card (effectiveConfig.mode). A stream
        // entry without `mode`, or a teardown<->open race during rapid reconnect churn, can
        // leave it null -> the `this.mode.includes(...)` calls below throw, the ws dies at
        // open (0-byte channel) and the card immediately reconnects -> reconnect storm.
        // Restore the default so onopen can't throw. Matches the defensive style of
        // onconnect() and `this.onmessage = this.onmessage || {}` below.
        if (!this.mode) {
            console.warn(`[VideoRTC:${this.clientId}] onopen: this.mode was ${this.mode}; restoring default`);
            this.mode = 'webrtc,mse,hls,mjpeg';
        }

        this.ws.addEventListener('message', ev => {
            if (typeof ev.data === 'string') {
                const msg = JSON.parse(ev.data);
                // Broadcast message to all active handlers (MSE, WebRTC, etc.)
                if (this.onmessage) {
                    for (const mode in this.onmessage) {
                        if (typeof this.onmessage[mode] === 'function') {
                            this.onmessage[mode](msg);
                        }
                    }
                }
            } else {
                // Binary data (usually MSE video chunks). Media is flowing,
                // so pet the no-data watchdog.
                this._feedWatchdog();
                if (this.ondata) {
                    this.ondata(ev.data);
                }
            }
        });

        this.ondata = null;
        // FIX: Do not wipe external message handlers (e.g. ui_sync from parent)
        this.onmessage = this.onmessage || {};

        // Initialize Modes based on browser support
        const modes = [];

        if (this.mode.includes('mse') && ('MediaSource' in window || 'ManagedMediaSource' in window)) {
            modes.push('mse');
            this.onmse();
        } else if (this.mode.includes('hls') && this.video.canPlayType('application/vnd.apple.mpegurl')) {
            modes.push('hls');
            this.onhls();
        } else if (this.mode.includes('mp4')) {
            modes.push('mp4');
            this.onmp4();
        }

        if (this.mode.includes('webrtc') && 'RTCPeerConnection' in window) {
            modes.push('webrtc');
            this.onwebrtc();
        }

        if (this.mode.includes('mjpeg')) {
            if (modes.length) {
                // If we have other modes, only use MJPEG if they fail
                this.onmessage['mjpeg'] = msg => {
                    if (msg.type !== 'error' || msg.value.indexOf(modes[0]) !== 0) return;
                    this.onmjpeg();
                };
            } else {
                modes.push('mjpeg');
                this.onmjpeg();
            }
        }

        return modes;
    }

    /**
     * Called when WebSocket closes.
     * Returns TRUE if the parent should be notified (failure).
     * Returns FALSE if this was an intentional handover (success).
     */
    onclose() {
        // Any close cancels the no-data watchdog so it can't fire afterwards.
        this._clearWatchdog();

        // HANDOFF CHECK: The "Loop Fix".
        // If we closed the socket intentionally to switch to WebRTC,
        // do NOT emit the closed event.
        if (this.handoff) {
            // onpcvideo already closed the socket, but close defensively.
            if (this.ws) { this.ws.close(); this.ws = null; }
            return false;
        }

        // Re-entrancy guard: closing the socket ourselves (below) makes the
        // browser fire another 'close' event asynchronously. If the PeerConnection
        // is still alive at that point the (!this.ws && !this.pc) test would not
        // short-circuit, and we'd dispatch 'connection-closed' twice -> double retry.
        if (this._notifiedClosed) return false;

        if (!this.ws && !this.pc) return false;

        // Proactive closes (no-data watchdog, strict-mode WS error, PC failure)
        // reach here with the socket still OPEN. Only nulling the reference would
        // leave an orphaned WebSocket: go2rtc keeps pushing media and the message
        // listener keeps feeding a driver the card is tearing down, wasting
        // bandwidth - the very thing the watchdog exists to prevent. close() is a
        // harmless no-op when the server already closed the socket.
        if (this.ws) { this.ws.close(); this.ws = null; }

        this._notifiedClosed = true;
        // Notify parent that connection died (triggers restart). `reason` lets the card log
        // WHY without a browser console: 'no-data-watchdog' / 'ws-error' set by the proactive
        // closers above, else a plain server/browser 'ws-close'.
        const reason = this._closeReason || 'ws-close';
        this._closeReason = null;
        this.dispatchEvent(new CustomEvent('connection-closed', {
            detail: { url: this.wsURL, reason }
        }));
        return true;
    }

    /**
     * Logic for Media Source Extensions (Low Latency Video over WS)
     */
    onmse() {
        console.debug(`[VideoRTC:${this.clientId}] Mode: MSE`);
        let ms;
        // Use ManagedMediaSource (new standard) or fallback to MediaSource
        if ('ManagedMediaSource' in window) {
            const MediaSource = window.ManagedMediaSource;
            ms = new MediaSource();
            ms.addEventListener('sourceopen', () => {
                this.send({type: 'mse', value: this.codecs(MediaSource.isTypeSupported)});
            }, {once: true});
            this.video.disableRemotePlayback = true;
            this.video.srcObject = ms;
        } else {
            ms = new MediaSource();
            ms.addEventListener('sourceopen', () => {
                URL.revokeObjectURL(this.video.src);
                this.send({type: 'mse', value: this.codecs(MediaSource.isTypeSupported)});
            }, {once: true});
            this.video.src = URL.createObjectURL(ms);
            this.video.srcObject = null;
        }

        this.play();
        this.mseCodecs = '';

        // Handle incoming MSE configuration
        this.onmessage['mse'] = msg => {
            if (msg.type !== 'mse') return;
            this.mseCodecs = msg.value;

            const sb = ms.addSourceBuffer(msg.value);
            sb.mode = 'segments';
            
            // Handle Buffer Updates
            sb.addEventListener('updateend', () => {
                // If we have pending data in buffer, append it
                if (!sb.updating && bufLen > 0) {
                    try {
                        const data = buf.slice(0, bufLen);
                        sb.appendBuffer(data);
                        bufLen = 0;
                    } catch (e) { /* ignore */ }
                }
                // Memory Management: Remove old segments to prevent memory leak
                try {
                    if (!sb.updating && sb.buffered && sb.buffered.length) {
                        const end = sb.buffered.end(sb.buffered.length - 1);
                        const start = end - 5; // Keep last 5 seconds
                        const start0 = sb.buffered.start(0);
                        if (start > start0) {
                            sb.remove(start0, start);
                            ms.setLiveSeekableRange(start, end);
                        }
                        // STRAND RECOVERY (v2.4.6): currentTime fell BELOW the buffered window —
                        // either the initial autoplay never started before the 5s window slid past
                        // currentTime=0 (slow-4G / backgrounded first-frame), or an MSE stall left
                        // currentTime behind an evicted region. The element then waits forever for
                        // data that was just removed → permanent freeze, cleared only by a manual
                        // pause→play (resume() seeks to the live edge). Seek to the live edge ONCE on
                        // exactly that condition. This is NOT the continuous upstream currentTime=start
                        // catch-up removed below (that pinned iOS playbackRate to 0.1 → crawl); it
                        // fires only on the pathology (on a healthy stream currentTime sits at the
                        // live edge, well above the buffered start), so no crawl. Never overrides a
                        // user's manual hold.
                        if (!this._manualHold && this.video && !this.video.seeking
                            && this.video.buffered.length) {
                            const lo = this.video.buffered.start(0);
                            if (this.video.currentTime < lo) {
                                this.video.currentTime = this.video.buffered.end(this.video.buffered.length - 1);
                                if (this.video.paused) this.play();
                            }
                        }
                        // NOTE (#910/#884): NO continuous currentTime re-seek / playbackRate catch-up.
                        // Upstream v3.6.1 added `currentTime = start` + `playbackRate = gap` as an
                        // MSE live-latency optimization. On iOS 26.1 WebKit it pins playbackRate to
                        // the 0.1 floor near the live edge (gap→0) → video crawls at ~0.1x → the
                        // reported "~1 frame / 3s". The fork treats MSE as the *reliable* (not
                        // lowest-latency) path — WebRTC is the low-latency path — so we drop the
                        // catch-up and let MSE play at 1x, matching the working pre-3.6.1 behavior.
                    }
                } catch (e) { /* ignore */ }
            });

            // 2MB Buffer for incoming binary data
            const buf = new Uint8Array(2 * 1024 * 1024);
            let bufLen = 0;

            this.ondata = data => {
                if (sb.updating || bufLen > 0) {
                    // If busy, store in temp buffer
                    const b = new Uint8Array(data);
                    // Bounds guard: if the SourceBuffer stays busy while media keeps
                    // arriving, bufLen can exceed the fixed 2MB staging buffer and
                    // buf.set() would throw an uncaught RangeError inside the socket
                    // message handler. The no-data watchdog can't catch this (bytes ARE
                    // arriving). Drop the backlog and this chunk: a brief glitch is
                    // recoverable, an exception kills the whole pipeline.
                    if (bufLen + b.byteLength > buf.length) {
                        console.warn(`[VideoRTC:${this.clientId}] MSE staging buffer overflow (${bufLen}+${b.byteLength} > ${buf.length}). Dropping backlog.`);
                        bufLen = 0;
                        return;
                    }
                    buf.set(b, bufLen);
                    bufLen += b.byteLength;
                } else {
                    // If free, append directly
                    try {
                        sb.appendBuffer(data);
                    } catch (e) { /* ignore */ }
                }
            };
        };
    }

    /**
     * Logic for WebRTC (UDP/TCP P2P Video)
     */
    onwebrtc() {
        const pc = new RTCPeerConnection(this.pcConfig);

        // [DIAGNOSTIC] When did this pc start negotiating? Lets the state log below
        // report how long ICE spent in 'checking' before it connected or failed — the
        // datum that decides whether a shadow retry needs a longer/adaptive cap.
        const pcStart = Date.now();

        // Handle ICE Candidates
        pc.addEventListener('icecandidate', ev => {
            // Ignore UDP candidates if forced to TCP mode
            if (ev.candidate && this.mode.includes('webrtc/tcp') && ev.candidate.protocol === 'udp') return;
            const candidate = ev.candidate ? ev.candidate.toJSON().candidate : '';
            this.send({type: 'webrtc/candidate', value: candidate});
        });

        // Tear down a WebRTC pc that could not deliver a usable stream. Two very
        // different situations, plus the shared first-frame-watchdog cleanup.
        const failWebRTC = (why) => {
            // [REVERSIBLE HANDOFF] While the RTC overlay is live and MSE has not yet been
            // released, ANY failure (pc failed/disconnected, offer rejected) must snap back
            // to the warm MSE — dropping the overlay and restoring MSE audio — not just
            // close the pc and leave a frozen overlay on top of a muted MSE.
            if (this._rtcVideo && this._rtcPhase !== 'committed') {
                this._revertToWarmMSE(`WebRTC ${why}`);
                return;
            }
            if (this._firstFrameTID) {
                clearTimeout(this._firstFrameTID);
                this._firstFrameTID = 0;
            }
            if (this._firstFramePoll) {
                clearInterval(this._firstFramePoll);
                this._firstFramePoll = 0;
            }
            if (this.ws && this.mseCodecs !== '') {
                // (a) MSE is still a live fallback: the signaling socket is open and
                // MSE has negotiated. In parallel webrtc+mse mode a WebRTC failure must
                // NOT tear the whole thing down - that would kill a working MSE stream
                // and, on networks where WebRTC can never establish (UDP blocked, no
                // TURN, or media-less "connected" paths), reconnect-loop endlessly.
                // Drop ONLY WebRTC and let MSE keep playing; a real MSE stall is caught
                // by the no-data watchdog. Signal the card so it can retry the upgrade
                // later with a freshly gathered ICE path.
                const reason = `WebRTC ${why}`;
                console.debug(`[VideoRTC:${this.clientId}] ${reason}; keeping active MSE stream.`);
                pc.close();
                this.pc = null;
                if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                    // v14.6.12: carry the reason (see _revertToWarmMSE) so the card mirrors it to HA.
                    this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_failed', detail: reason });
                }
            } else {
                // (b) No MSE fallback (e.g. pure RTC after a successful handover).
                // Notify the card to retry. onclose() is called BEFORE nulling pc so
                // its (!this.ws && !this.pc) guard does not short-circuit; onclose()
                // never touches pc, so closing it right after is safe.
                this.handoff = false;
                this.onclose();
                pc.close();
                this.pc = null;
            }
        };

        // Monitor Connection State
        pc.addEventListener('connectionstatechange', () => {
            // [DIAGNOSTIC] Log every transition with elapsed time + ICE state.
            console.debug(`[VideoRTC:${this.clientId}] pc ${pc.connectionState} (ice=${pc.iceConnectionState}) @${Date.now() - pcStart}ms`);

            if (pc.connectionState === 'connected') {
                // Arm the first-frame detection + watchdog exactly once per pc. (In
                // practice 'connected' fires once before any reap, but guard anyway so a
                // transient connected->connecting->connected can't leak a 2nd poll/timer.)
                if (this._firstFrameTID || this._firstFramePoll) return;

                // Keep MSE warm, decode RTC on a hidden overlay, promote fast, and commit
                // only once RTC proves durably stable — the whole handoff lives in
                // _startReversibleRTC and the this._rtcPhase machine.
                this._startReversibleRTC(pc, pcStart, failWebRTC);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                failWebRTC('failed');
            }
        });

        this.onmessage['webrtc'] = msg => {
            switch (msg.type) {
                case 'webrtc/candidate':
                    if (this.mode.includes('webrtc/tcp') && msg.value.includes(' udp ')) return;
                    pc.addIceCandidate({candidate: msg.value, sdpMid: '0'}).catch(er => console.warn(`[VideoRTC:${this.clientId}] ICE Error:`, er));
                    break;
                case 'webrtc/answer':
                    pc.setRemoteDescription({type: 'answer', sdp: msg.value}).catch(er => console.warn(`[VideoRTC:${this.clientId}] SDP Error:`, er));
                    break;
                case 'error':
                    if (!msg.value.includes('webrtc/offer')) return;
                    // go2rtc rejected our offer: WebRTC is dead on this connection.
                    // Route through failWebRTC so it emits rtc_failed (keeping MSE) and
                    // the card can arm a retry — a bare pc.close() moves the pc to
                    // 'closed', which the state handler ignores, so no signal would fire.
                    failWebRTC('offer rejected');
            }
        };

        this.createOffer(pc).then(offer => {
            this.send({type: 'webrtc/offer', value: offer.sdp});
        });

        this.pc = pc;
    }

    /**
     * [REVERSIBLE HANDOFF] WebRTC upgrade path for the main parallel driver.
     *
     * The visible MSE stream on this.video is NEVER detached until we are certain: it
     * keeps flowing over the open ws the whole time. WebRTC decodes on a second <video>
     * (this._rtcVideo) overlaid at opacity 0 — rendered, so the decoder runs at FULL RATE
     * (an offscreen/non-rendered element is throttled by the browser, which made good
     * cameras take 90s+ to "prove"). Lifecycle:
     *   PROMOTE  (>= RTC_PROMOTE_MS of flowing decode): raise the overlay's opacity so the
     *            user sees RTC. MSE stays attached and warm underneath. Reversible.
     *   REVERT   (stall before commit): drop the overlay -> the warm MSE is already on
     *            screen. One frame, no reconnect, no black. Emit rtc_failed -> re-probe.
     *   COMMIT   (>= RTC_COMMIT_MS of continuous liveness): the path is proven stable, so
     *            collapse the overlay onto this.video (detaching/closing the now-unneeded
     *            MSE) and close the ws to stop the dual-bandwidth. Only AFTER this is a
     *            stall unrecoverable without a reconnect — and by then it is rare.
     */
    _startReversibleRTC(pc, pcStart, failWebRTC) {
        const tracks = pc.getTransceivers()
            .filter(tr => tr.currentDirection === 'recvonly')
            .map(tr => tr.receiver.track);

        // Overlay: absolutely positioned over this.video, rendered but invisible so it
        // decodes at full rate while we measure readiness.
        if (this.style.position === '' || this.style.position === 'static') {
            this.style.position = 'relative';
        }
        const rtcVideo = document.createElement('video');
        rtcVideo.muted = true;
        rtcVideo.playsInline = true;
        rtcVideo.style.position = 'absolute';
        rtcVideo.style.top = '0';
        rtcVideo.style.left = '0';
        rtcVideo.style.width = '100%';
        rtcVideo.style.height = '100%';
        rtcVideo.style.opacity = '0';
        rtcVideo.style.pointerEvents = 'none';
        rtcVideo.srcObject = new MediaStream(tracks);
        rtcVideo.play().catch(() => {});
        this.appendChild(rtcVideo);
        this._rtcVideo = rtcVideo;
        // Capture the desired MSE audio state NOW so revert/commit restore it correctly
        // even if we give up before ever muting it at promote.
        this._mseWanted = this.video.muted;

        this._setPhase('negotiating');
        this._sustainedSignaled = false;
        let lastDecoded = -1;
        let flowingMs = 0;

        // Reveal RTC (reversible). Only if it is at least as good as MSE.
        const promote = () => {
            let rtcPriority = 0, msePriority = 0;
            const stream = rtcVideo.srcObject;
            if (stream.getVideoTracks().length > 0) {
                const isH265 = this.pc.remoteDescription.sdp.includes('H265/90000');
                rtcPriority += isH265 ? 0x240 : 0x220;
            }
            if (stream.getAudioTracks().length > 0) rtcPriority += 0x102;
            if (this.mseCodecs.includes('hvc1.')) msePriority += 0x230;
            if (this.mseCodecs.includes('avc1.')) msePriority += 0x210;
            if (this.mseCodecs.includes('mp4a.')) msePriority += 0x101;

            if (rtcPriority < msePriority) {
                // MSE is the better stream: drop RTC, keep MSE, stop chasing this path.
                console.debug(`[VideoRTC:${this.clientId}] RTC Rejected (Priority < MSE) — staying on MSE`);
                this._clearRtcTimers();
                this._dropRtcOverlay();
                this.video.muted = this._mseWanted;
                if (this.pc) { this.pc.close(); this.pc = null; }
                this._setPhase('warm');   // overlay dropped + pc closed -> back on MSE only
                if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                    this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_rejected' });
                }
                return;
            }

            console.debug(`[VideoRTC:${this.clientId}] RTC promoted (${flowingMs}ms flowing) @${Date.now() - pcStart}ms — MSE kept warm`);
            this._setPhase('promoted');
            this._lastLiveness = Date.now();
            this._stableSince = Date.now();   // commit only after RTC_COMMIT_MS of GAPLESS decode
            // The give-up watchdog is done; from here the liveness watchdog governs.
            if (this._firstFrameTID) { clearTimeout(this._firstFrameTID); this._firstFrameTID = 0; }
            // Reveal RTC; mute the (now hidden) MSE so its delayed audio can't echo.
            rtcVideo.muted = this._mseWanted;
            this.video.muted = true;
            rtcVideo.style.opacity = '1';
            rtcVideo.style.zIndex = '2';
            // Notify the card (status -> RTC, stop reprobe). Our onpcvideo is a no-op in
            // the reversible flow (it must NOT close the ws); the card's wrapper still runs.
            this.onpcvideo(rtcVideo);
            // Commit is now driven by the liveness poll (continuous-stability gate), not a
            // fixed timer: see the post-promote branch below.
        };

        // Release MSE: RTC has been stable long enough to trust.
        const commit = () => {
            this._commitTID = 0;
            if (!this.pc || this._rtcPhase !== 'promoted' || !this._rtcVideo) return;
            console.debug(`[VideoRTC:${this.clientId}] RTC stable ${this.RTC_COMMIT_MS}ms @${Date.now() - pcStart}ms — committing (releasing MSE)`);
            this._setPhase('committed');
            // Collapse onto the primary element (keeps the card's tools/PTZ bound to
            // this.video). Both show the same MediaStream during the swap -> no flash.
            const stream = this._rtcVideo.srcObject;
            // Clear any legacy MediaSource object-URL so srcObject takes over cleanly.
            this.video.removeAttribute('src');
            this.video.srcObject = stream;         // detaches + closes the MSE MediaSource
            this.video.muted = this._mseWanted;
            this.play();
            const old = this._rtcVideo;
            this._rtcVideo = null;
            setTimeout(() => { try { old.srcObject = null; old.remove(); } catch (e) { /* ignore */ } }, 0);
            // Free the signalling socket. handoff=true keeps onclose() quiet.
            if (this.ws) { this.handoff = true; this.ws.close(); this.ws = null; }
        };

        this._firstFramePoll = setInterval(() => {
            if (!this.pc) { clearInterval(this._firstFramePoll); this._firstFramePoll = 0; return; }
            // [MANUAL PAUSE] While the viewer holds the stream soft-paused, freeze the phase
            // machine: no promote/commit/revert, no liveness-stall reconnect. Otherwise commit()
            // (or a revert) would call play() and auto-resume behind the user's back. The PC keeps
            // flowing (soft pause), so decode resumes instantly on resume().
            if (this._manualHold) return;
            this.pc.getStats().then(stats => {
                let fd = -1;
                // [BW INSTRUMENTATION v2.4.1] Harvest passive metrics from the SAME poll: inbound-rtp
                // (goodput/loss/jitter) + selected candidate-pair RTT. Pure observation — the values
                // below never feed the promote/commit/revert logic (that stays framesDecoded-only).
                let mBytes = -1, mRecv = -1, mLost = -1, mJit = -1, mRtt = -1;
                // [TRANSPORT DIAGNOSTICS v2.6.0] harvested from the SAME poll (diagnostic only).
                let mJbDelay = -1, mJbEmit = -1, mNack = -1;
                let mLocalCandId = '', mRemoteCandId = '';
                const candMap = {}; // id -> {t: candidateType, p: protocol}
                for (const r of stats.values()) {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') {
                        fd = r.framesDecoded || 0;
                        if (r.bytesReceived != null) mBytes = r.bytesReceived;
                        if (r.packetsReceived != null) mRecv = r.packetsReceived;
                        if (r.packetsLost != null) mLost = r.packetsLost;
                        if (r.jitter != null) mJit = r.jitter;
                        if (r.jitterBufferDelay != null) mJbDelay = r.jitterBufferDelay;
                        if (r.jitterBufferEmittedCount != null) mJbEmit = r.jitterBufferEmittedCount;
                        if (r.nackCount != null) mNack = r.nackCount;
                    } else if (r.type === 'candidate-pair' && (r.nominated || r.selected)) {
                        if (r.currentRoundTripTime != null) mRtt = r.currentRoundTripTime;
                        if (r.localCandidateId) mLocalCandId = r.localCandidateId;
                        if (r.remoteCandidateId) mRemoteCandId = r.remoteCandidateId;
                    } else if (r.type === 'local-candidate' || r.type === 'remote-candidate') {
                        candMap[r.id] = { t: r.candidateType, p: r.protocol };
                    }
                }
                // Resolve the selected pair's candidate types + protocol (order-independent).
                let mPath = '';
                const lc = candMap[mLocalCandId], rc = candMap[mRemoteCandId];
                if (lc || rc) {
                    const proto = (lc && lc.p) || (rc && rc.p) || '?';
                    mPath = `${lc ? lc.t : '?'}/${rc ? rc.t : '?'}/${proto}`;
                }
                this._sampleMetrics(mBytes, mRecv, mLost, mJit, mRtt, mJbDelay, mJbEmit, mNack, mPath);
                if (fd < 0) return;
                const advanced = lastDecoded >= 0 && fd > lastDecoded;
                lastDecoded = fd;

                if (this._rtcPhase === 'negotiating') {
                    if (advanced) {
                        flowingMs += 500;
                        if (flowingMs >= this.RTC_PROMOTE_MS) promote();
                    }
                } else if (advanced) {
                    this._lastLiveness = Date.now();
                    const gapless = Date.now() - this._stableSince;
                    // [SHADOW-SWAP GATE] Once RTC has held gaplessly for RTC_SWAP_PROVE_MS, emit
                    // a one-shot rtc_sustained. For a background shadow the card swaps it in here
                    // (never at the 2s promote) so the working MSE main is only replaced by a
                    // genuinely durable RTC path; for the live main this is a harmless no-op.
                    if (!this._sustainedSignaled && gapless >= this.RTC_SWAP_PROVE_MS) {
                        this._sustainedSignaled = true;
                        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                            this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_sustained' });
                        }
                    }
                    // Commit (release MSE) only after a fully GAPLESS run of RTC_COMMIT_MS.
                    // Any stall > RTC_STALL_RESET below pushes _stableSince forward, so a bursty
                    // camera never gets here and just keeps MSE warm. Reserving commit for
                    // rock-solid paths is what stops the post-commit stall -> reconnect crash loop.
                    if (this._rtcPhase === 'promoted' && gapless >= this.RTC_COMMIT_MS) {
                        commit();
                    }
                } else {
                    const gap = Date.now() - this._lastLiveness;
                    if (gap > this.RTC_LIVENESS_TIMEOUT) {
                        if (this._rtcPhase === 'promoted') {
                            // Pre-commit: MSE is warm — snap back instantly, no reconnect.
                            this._revertToWarmMSE(`RTC stalled ${this.RTC_LIVENESS_TIMEOUT}ms before commit`);
                        } else {
                            // Post-commit: MSE already released — the no-MSE branch reconnects.
                            // Rare: only genuinely gapless paths ever commit.
                            failWebRTC(`RTC media stalled ${this.RTC_LIVENESS_TIMEOUT}ms after commit`);
                        }
                    } else if (gap > this.RTC_STALL_RESET) {
                        // A real (but not yet fatal) stall: this path is not rock-solid, so
                        // restart the commit stability clock. It keeps MSE warm and never commits.
                        this._stableSince = Date.now();
                    }
                }
            }).catch(() => {});
        }, 500);

        // Give-up deadline: if RTC never sustains decode at all, reap and signal rtc_failed
        // (MSE keeps serving untouched throughout).
        const giveUp = () => {
            this._firstFrameTID = 0;
            // [MANUAL PAUSE] Don't tear the probe down under the user's hold; re-arm and re-check
            // once they resume (the poll is frozen while held, so nothing else advances it).
            if (this._manualHold) {
                this._firstFrameTID = setTimeout(giveUp, this.FIRSTFRAME_TIMEOUT);
                return;
            }
            this._revertToWarmMSE(`connected but decoded no sustained video within ${this.FIRSTFRAME_TIMEOUT}ms`);
        };
        this._firstFrameTID = setTimeout(giveUp, this.FIRSTFRAME_TIMEOUT);
    }

    /**
     * [REVERSIBLE RTC] Single transition point for the RTC phase machine. Logs every edge
     * (warm/negotiating/promoted/committed) so the whole handoff is traceable from one line.
     */
    _setPhase(next) {
        if (this._rtcPhase === next) return;
        console.debug(`[VideoRTC:${this.clientId}] RTC phase ${this._rtcPhase} -> ${next}`);
        this._rtcPhase = next;
    }

    /** [REVERSIBLE HANDOFF] Clear the promotion/liveness/commit timers. */
    _clearRtcTimers() {
        if (this._firstFramePoll) { clearInterval(this._firstFramePoll); this._firstFramePoll = 0; }
        if (this._firstFrameTID) { clearTimeout(this._firstFrameTID); this._firstFrameTID = 0; }
        if (this._commitTID) { clearTimeout(this._commitTID); this._commitTID = 0; }
    }

    /** [REVERSIBLE HANDOFF] Remove the overlaid RTC <video> element. */
    _dropRtcOverlay() {
        if (this._rtcVideo) {
            try { this._rtcVideo.srcObject = null; this._rtcVideo.remove(); } catch (e) { /* ignore */ }
            this._rtcVideo = null;
        }
    }

    /**
     * [REVERSIBLE HANDOFF] Snap back to the still-warm MSE. Used for a pre-commit stall,
     * the give-up deadline, and any pc failure while the overlay is live. MSE never stopped
     * (ws open, still fed), so this is a one-frame recovery: drop the RTC overlay, unmute/show
     * MSE, reap the pc, and arm a fresh WebRTC re-probe via rtc_failed. Safe to call once;
     * a second call is a no-op (no overlay, no pc).
     */
    _revertToWarmMSE(why) {
        if (!this._rtcVideo && !this.pc) return;
        console.warn(`[VideoRTC:${this.clientId}] ${why}; reverting to warm MSE.`);
        // [ADAPTIVE WATCHDOG / STRATO-1 STEP 3] A revert = a doomed/abandoned RTC promote. Raise the
        // decaying futility floor. v2.7.0: futility now SHORTENS the next probe's abort hold
        // (_evaluateAbort) so a repeatedly-doomed path gives up faster — it no longer lengthens the
        // watchdog extension (that inversion is fixed in _updateCongestion).
        this._rtcFutility = Math.min(1, this._rtcFutility + 0.5);
        this._clearRtcTimers();
        this._dropRtcOverlay();
        this.video.muted = this._mseWanted;
        if (this.pc) { this.pc.close(); this.pc = null; }
        this._setPhase('warm');
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            // v14.6.12: carry the reason so the card can mirror it to the HA log. Without this a
            // step-3 abort, a stall revert and an ICE-drop all showed as a bare `mode: rtc -> mse`
            // — indistinguishable in a field log. `detail` self-identifies the abort ("RTC aborted:
            // pathological path (rtt=…, jbuf=… sustained)") and every other revert cause.
            this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_failed', detail: why });
        }
    }

    /**
     * Sets the desired mute state and routes it to whichever element is currently ON SCREEN.
     * While RTC is promoted, sound must come from the overlay (this._rtcVideo) and the warm
     * MSE element MUST stay muted, else its audio plays under the RTC video and desyncs. Once
     * committed (or never promoted) the single visible element is this.video. Called by the
     * card after a shadow→main swap to restore the configured audio (the shadow ran muted).
     */
    applyAudio(muted) {
        this._mseWanted = muted;
        if (this._rtcVideo && this._rtcPhase === 'promoted') {
            this._rtcVideo.muted = muted;
            this.video.muted = true;
        } else {
            this.video.muted = muted;
        }
    }

    async createOffer(pc) {
        try {
            if (this.media.includes('microphone')) {
                const media = await navigator.mediaDevices.getUserMedia({audio: true});
                media.getTracks().forEach(track => {
                    pc.addTransceiver(track, {direction: 'sendonly'});
                });
            }
        } catch (e) {
            console.warn(`[VideoRTC:${this.clientId}] Mic Error:`, e);
        }

        for (const kind of ['video', 'audio']) {
            if (this.media.includes(kind)) {
                pc.addTransceiver(kind, {direction: 'recvonly'});
            }
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        return offer;
    }

    /**
     * RTC-video hook. The reveal + priority decision + socket handoff all live in
     * _startReversibleRTC / commit() now, so this base method is intentionally a no-op:
     * the reversible flow calls it (via promote()) ONLY so the card's onpcvideo wrapper
     * runs its UI update. It must never touch the socket or srcObject.
     */
    onpcvideo(_video) { /* reversible flow owns the handoff; card wraps this for UI */ }

    /**
     * Logic for MJPEG (Motion JPEG) - Fallback mode
     */
    onmjpeg() {
        console.debug(`[VideoRTC:${this.clientId}] Mode: MJPEG`);
        this.ondata = data => {
            this.video.controls = false;
            this.video.poster = 'data:image/jpeg;base64,' + VideoRTC.btoa(data);
        };
        this.send({type: 'mjpeg'});
    }

    /**
     * Logic for HLS (HTTP Live Streaming)
     */
    onhls() {
        console.debug(`[VideoRTC:${this.clientId}] Mode: HLS`);
        this.onmessage['hls'] = msg => {
            if (msg.type !== 'hls') return;
            const url = 'http' + this.wsURL.substring(2, this.wsURL.indexOf('/ws')) + '/hls/';
            const playlist = msg.value.replace('hls/', url);
            this.video.src = 'data:application/vnd.apple.mpegurl;base64,' + btoa(playlist);
            this.play();
        };
        this.send({type: 'hls', value: this.codecs(type => this.video.canPlayType(type))});
    }

    /**
     * Logic for MP4 over WebSocket
     */
    onmp4() {
        console.debug(`[VideoRTC:${this.clientId}] Mode: MP4`);
        const canvas = document.createElement('canvas');
        let context;
        const video2 = document.createElement('video');
        video2.autoplay = true;
        video2.playsInline = true;
        video2.muted = true;

        video2.addEventListener('loadeddata', () => {
            if (!context) {
                canvas.width = video2.videoWidth;
                canvas.height = video2.videoHeight;
                context = canvas.getContext('2d');
            }
            context.drawImage(video2, 0, 0, canvas.width, canvas.height);
            this.video.controls = false;
            this.video.poster = canvas.toDataURL('image/jpeg');
        });

        this.ondata = data => {
            video2.src = 'data:video/mp4;base64,' + VideoRTC.btoa(data);
        };
        this.send({type: 'mp4', value: this.codecs(this.video.canPlayType)});
    }

    static btoa(buffer) {
        const bytes = new Uint8Array(buffer);
        const len = bytes.byteLength;
        let binary = '';
        for (let i = 0; i < len; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return window.btoa(binary);
    }
}