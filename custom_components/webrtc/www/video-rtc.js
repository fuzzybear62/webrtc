/*!
 * Copyright (c) 2023 Alexey Khit (https://github.com/AlexxIT/WebRTC)
 * Copyright (c) 2026 fuzzybear62 (https://github.com/fuzzybear62/webrtc)
 * Derived from AlexxIT/WebRTC. Licensed under the MIT License — see LICENSE.
 */
/**
 * VideoRTC — the streaming driver (`<video-rtc>`), one instance per visible stream.
 *
 * Owns exactly ONE WebSocket to go2rtc and, once it promotes, ONE RTCPeerConnection. Plays a
 * stream over the best transport the link allows — MSE (fMP4 over the ws), WebRTC (P2P, low
 * latency), HLS, or MJPEG — and performs a REVERSIBLE MSE→WebRTC handoff: MSE keeps flowing while
 * an RTC probe ramps in the background, and a failed probe silently falls back to the still-warm
 * MSE instead of blacking out.
 *
 * The driver is deliberately dumb and disposable: the card (`<webrtc-camera>`) owns lifecycle and
 * recreates the driver on every retry. Do NOT add cross-reconnect state here — it belongs on the
 * card, or (for grid-wide state) on the module-level `_rtcProbeGate` singleton below.
 *
 * Congestion control (the hard part — a multi-camera 4G grid shares one uplink; N cameras ramping
 * WebRTC at once overshoot it together into a bufferbloat storm):
 *   - Alg.1  band classifier    — folds per-poll RTT-excess + loss into a perf/degr/path verdict (~2s).
 *   - Alg.2  probe serializer    — `_rtcProbeGate`, shared by every driver on the page, ramps ONE RTC
 *                                  probe at a time on a constrained link and all at once on a fat one
 *                                  (the first probe is a canary that opens or re-serializes the gate).
 *   - Alg.3  band-driven abort   — a leaky accumulator reverts a doomed probe to warm MSE.
 *   - A0     grid blackout       — one band=path abort suppresses RTC page-wide for 300s.
 *   - Adaptive no-data watchdog  — the warm-MSE reap timeout self-extends while the shared uplink is
 *                                  known-congested (grid blackout, self-measured bursty feed, or an
 *                                  MSE-reap quorum), so a frozen-but-fed stream rides the choke out
 *                                  instead of reaping at the base timeout and stampeding into a storm.
 *
 * There are NO user knobs for the congestion stack — the driver self-calibrates from measured link
 * state. Derived from AlexxIT/WebRTC; the congestion-control stack above (Alg.1–4, A0, the
 * adaptive/byte-aware watchdog) is fork-specific.
 */

/**
 * [RTC PROBE SERIALIZER — Alg.2] One module-level, cross-instance single-flight gate for the
 * WebRTC bandwidth-hungry RAMP. EVERY VideoRTC on the page — each card's main driver AND its
 * background shadow — shares this one coordinator. Why: N cameras promoting RTC ~simultaneously
 * each fire an uncoordinated GCC bitrate ramp; on one constrained 4G uplink the N ramps overshoot
 * together → a grid-wide RTT balloon (a bufferbloat storm that can drop the HA websocket).
 *
 * BUT serializing only earns its keep on a CONSTRAINED link — on a fat pipe (LAN / wideband) there
 * is no storm to prevent, and holding cameras in a queue just delays their upgrade for nothing. So
 * the gate is band-adaptive and uses the FIRST probe as a canary:
 *   - SERIAL (default, safe): one probe ramps at a time; the rest queue on warm MSE at ZERO load.
 *   - The canary's Alg.1 verdict (reportBand, ~2s into its ramp) decides the shared uplink:
 *       band=perf  → OPEN the gate: the link is fat, no storm possible → drain the queue at once
 *                    and let every current+future probe ramp in PARALLEL (no serialization cost).
 *       band=path  → stay/return to SERIAL: the link is constrained, keep one ramp at a time.
 *       band=degr/'' (ambiguous) → leave the mode unchanged (stay cautious).
 * The band is a property of the shared uplink, not the individual camera, so one verdict
 * generalizes; if the link later degrades, the next path report re-arms SERIAL.
 *
 * In SERIAL mode a holder keeps the token from the offer (onwebrtc) until the EARLIEST of:
 *   - promote settles  — RTC_GATE_SETTLE_MS gapless in 'promoted': GCC has plateaued, so the
 *                        next camera may ramp WITHOUT waiting the full RTC_COMMIT_MS to commit,
 *   - revert / reject  — _setPhase('warm')      (probe gone),
 *   - commit           — _setPhase('committed') (MSE released; path plateaued long ago),
 *   - a dying probe    — any failWebRTC path (fast ICE fail / offer rejected),
 *   - lease timeout    — LEASE_MS backstop, so a connected-but-frozen probe can't wedge the grid.
 * MSE (onmse) starts unblocked in onconnect and keeps flowing the whole time a camera waits, so a
 * queued camera adds ZERO extra load — it just keeps showing warm MSE until its turn to ramp.
 */
const _rtcProbeGate = {
    holder: null,       // the VideoRTC instance currently allowed to ramp (SERIAL mode), or null
    queue: [],          // FIFO of { driver, resolve } waiting their turn (SERIAL mode)
    leaseTID: 0,        // force-release backstop for the current holder
    open: false,        // true once the canary reports SUSTAINED band=perf: fat pipe, ramp everyone in parallel
    perfStreak: 0,      // consecutive band=perf reports from the canary; opens only past PERF_OPEN_STREAK
    PERF_OPEN_STREAK: 3,// consecutive perf samples (~1.5s) required to open the gate.
                        // PITFALL: do NOT open on a single perf sample. At the promote instant a saturated
                        // 4G link reads exc=0 for one poll (head-fake) before bufferbloat shows; opening on
                        // it lets the whole grid ramp in parallel right before the canary reveals band=path.
    LEASE_MS: 20000,    // hard cap on any single hold (comfortably above RTC_GATE_SETTLE_MS,
                        // far below the 120s FIRSTFRAME give-up so a frozen probe can't wedge us)
    suppressed: false,  // [A0-grid] true = a band=path abort has blacked out RTC probing GRID-WIDE
    suppressedAt: 0,    // when the blackout began (diagnostics)
    SUPPRESS_MS: 300000,// grid RTC blackout after a band=path abort — matches the card's RTC_RETEST_MS
    reprobeTID: 0,      // re-arm backstop that lifts the blackout
    liveDrivers: new Set(), // every connected VideoRTC on the page (main + shadow). On a FRESH latch
                        // (blackout or MSE-reap) we push the warm-extend to each, so a watchdog already
                        // armed at base(5s) can't reap a rideable stream in the moment the latch engages.

    // MSE-reap grid latch — the cold-start bridge that covers the window BEFORE band=path suppression
    // can latch. On a saturated uplink the first wave of MSE sockets bursts then chokes: each reaps at
    // base(5s) before any RTC probe survives its ~6s band-abort to trip `suppressed`, and before the
    // byte-aware watchdog can see a >=2.5s inter-chunk gap to prime (a fresh socket that bursts then
    // goes silent leaves no gap to measure). So count no-data-watchdog reaps across DISTINCT cameras
    // (by streamKey): >= MSE_REAP_QUORUM within MSE_REAP_WINDOW_MS means the shared uplink is choking,
    // not one dead camera. Latch mseReapCongested for MSE_REAP_HOLD_MS (sliding) → every warm socket
    // (fresh ones included, from their first arm) extends via _effectiveDisconnectTimeout, so the
    // cold-start storm rides out instead of churning. Bounded and self-clearing; band=path suppress()
    // supersedes it once that latches (300s > 60s).
    // PITFALL: key on streamKey, not clientId/wsURL — one dead camera reconnecting must NOT reach quorum
    // by itself; quorum means DISTINCT cameras. A healthy grid never reaps, so it never latches (no
    // regression on good links).
    mseReapCongested: false,
    mseReapLog: new Map(),  // streamKey -> last reap ts; distinct-camera counting within the window
    mseReapTID: 0,          // self-release timer (sliding)
    MSE_REAP_QUORUM: 2,      // distinct cameras reaping within the window to call it grid congestion
    MSE_REAP_WINDOW_MS: 10000, // how close two DISTINCT reaps must fall to count together
    MSE_REAP_HOLD_MS: 60000, // latch duration, refreshed on each qualifying reap (band=path 300s supersedes)

    /**
     * Await our turn to ramp. Resolves TRUE to proceed (gate OPEN/fat-pipe, or our serial turn) and
     * FALSE to abstain (a band=path grid blackout is in effect — the caller stays on MSE).
     */
    acquire(driver) {
        return new Promise(resolve => {
            if (this.suppressed) resolve(false);               // [A0-grid] blackout: abstain, stay MSE
            else if (this.open) resolve(true);                 // fat pipe: no serialization
            else if (!this.holder) this._grant(driver, resolve);
            else if (this.holder === driver) resolve(true);    // re-entrant: already ours
            else this.queue.push({ driver, resolve });
        });
    },

    /**
     * [A0-grid] A band=path RTC abort on ANY camera means the SHARED uplink cannot carry RTC — not
     * just for the camera that aborted. The per-card flap score (webrtc-camera.js) can't see this: each
     * card reverts once (score 1.0), and N independent cards each burning one ~7s RTC-over-TURN probe
     * together saturate the uplink and can drop the HA websocket. So black out RTC probing GRID-WIDE for
     * SUPPRESS_MS: deny every acquire, drop any serial holder and queue, and let MSE (already flowing,
     * zero extra load) carry every camera. Self-releasing. Returns TRUE on the FRESH transition so the
     * caller emits one rtc_suppressed to its card; a repeat hit just refreshes the window.
     */
    suppress(driver) {
        const fresh = !this.suppressed;
        this.suppressed = true;
        this.suppressedAt = Date.now();
        this.open = false;
        this.perfStreak = 0;
        if (this.leaseTID) { clearTimeout(this.leaseTID); this.leaseTID = 0; }
        this.holder = null;
        const waiters = this.queue.splice(0);
        for (const w of waiters) w.resolve(false);             // deny everyone already queued to ramp
        if (this.reprobeTID) clearTimeout(this.reprobeTID);
        this.reprobeTID = setTimeout(() => {
            this.reprobeTID = 0;
            this.suppressed = false;
            console.debug(`[VideoRTC] RTC probe gate re-armed — ${Math.round(this.SUPPRESS_MS / 1000)}s band=path blackout elapsed.`);
        }, this.SUPPRESS_MS);
        if (fresh) {
            console.warn(`[VideoRTC:${driver.clientId}] RTC probe gate SUPPRESSED grid-wide (band=path) — no RTC probes for ${Math.round(this.SUPPRESS_MS / 1000)}s.`);
            // Retroactive re-arm. `suppressed` is set above, so every warm stream's effective no-data
            // timeout is now the extend (30s). But a stream that fell silent JUST BEFORE this latch
            // still holds a base(5s) timer from its last byte and would reap mid-blackout before a new
            // byte could extend it. Push the extend to every live warm stream NOW so it rides out.
            for (const d of this.liveDrivers) {
                try { d._rearmWatchdogForBlackout(); } catch (e) { /* one driver must not block the grid */ }
            }
        }
        return fresh;
    },

    /**
     * [MSE-reap grid latch] Record one no-data-watchdog reap; once DISTINCT cameras cross the
     * quorum within the window, latch grid MSE-congestion so warm/fresh sockets extend instead of
     * churning through the cold-start storm. Keyed by streamKey (stable across a camera's reconnects),
     * so one dead camera's repeated reaps can't reach quorum alone. On a FRESH latch, push the extend
     * to every live warm stream (same retroactive re-arm as suppress(), so a base(5s) timer already
     * ticking on a sibling rides out). Returns the distinct-camera count on the fresh latch (else 0),
     * for the reaping driver's ws_reap telemetry. No-op effect while band=path suppression is latched
     * (that already extends everything), but we still record so the log shows the reap.
     */
    noteMseReap(driver) {
        const now = Date.now();
        const key = driver.streamKey || driver.wsURL || driver.clientId;
        this.mseReapLog.set(key, now);
        let distinct = 0;
        for (const [k, ts] of this.mseReapLog) {
            if (now - ts > this.MSE_REAP_WINDOW_MS) this.mseReapLog.delete(k);
            else distinct++;
        }
        if (distinct < this.MSE_REAP_QUORUM) return 0;
        const fresh = !this.mseReapCongested;
        this.mseReapCongested = true;
        if (this.mseReapTID) clearTimeout(this.mseReapTID);
        this.mseReapTID = setTimeout(() => {
            this.mseReapTID = 0;
            this.mseReapCongested = false;
            this.mseReapLog.clear();
            console.debug(`[VideoRTC] MSE-reap grid latch cleared — ${Math.round(this.MSE_REAP_HOLD_MS / 1000)}s since the last qualifying reap.`);
        }, this.MSE_REAP_HOLD_MS);
        if (fresh) {
            console.warn(`[VideoRTC:${driver.clientId}] MSE-reap grid latch ENGAGED (${distinct} cams reaped within ${Math.round(this.MSE_REAP_WINDOW_MS / 1000)}s) — warm sockets extend for ${Math.round(this.MSE_REAP_HOLD_MS / 1000)}s.`);
            for (const d of this.liveDrivers) {
                try { d._rearmWatchdogForBlackout(); } catch (e) { /* one driver must not block the grid */ }
            }
        }
        return fresh ? distinct : 0;
    },

    /** Give up the token, or leave the queue if not yet holder. Idempotent. No-op while OPEN. */
    release(driver) {
        const qi = this.queue.findIndex(w => w.driver === driver);
        if (qi !== -1) this.queue.splice(qi, 1);               // torn down before its turn
        if (this.holder !== driver) return;
        if (this.leaseTID) { clearTimeout(this.leaseTID); this.leaseTID = 0; }
        this.holder = null;
        const next = this.queue.shift();
        if (next) this._grant(next.driver, next.resolve);
    },

    /**
     * [Alg.2 band-adaptive] Fold the canary's live band verdict into the gate mode. Called from
     * the RTC poll right after _classifyBand. SUSTAINED band=perf opens the gate (fat pipe → parallel
     * ramps); band=path re-arms serialization; degr/'' are ambiguous and only reset the perf streak.
     */
    reportBand(driver, band) {
        if (this.suppressed) return;                           // [A0-grid] blackout wins over a stale perf sample
        if (band === 'perf') {
            if (this.open) return;                             // already fat-pipe
            if (++this.perfStreak < this.PERF_OPEN_STREAK) return; // need SUSTAINED perf, not a promote-instant head-fake
            console.debug(`[VideoRTC:${driver.clientId}] RTC probe gate OPEN — canary sustained band=perf ×${this.perfStreak}, fat pipe, parallel ramps allowed.`);
            this.open = true;
            if (this.leaseTID) { clearTimeout(this.leaseTID); this.leaseTID = 0; }
            this.holder = null;
            const waiters = this.queue.splice(0);              // drain the whole queue at once
            for (const w of waiters) w.resolve(true);
        } else {
            this.perfStreak = 0;                               // any non-perf sample breaks the streak
            if (band === 'path' && this.open) {
                console.debug(`[VideoRTC:${driver.clientId}] RTC probe gate SERIAL — band=path, constrained link, re-serializing ramps.`);
                this.open = false;
            }
        }
    },

    _grant(driver, resolve) {
        this.holder = driver;
        this.leaseTID = setTimeout(() => {
            console.warn(`[VideoRTC:${driver.clientId}] RTC probe gate lease expired (${this.LEASE_MS}ms) — releasing to unblock the grid.`);
            this.leaseTID = 0;
            this.release(driver);
        }, this.LEASE_MS);
        resolve(true);
    },
};

export class VideoRTC extends HTMLElement {
    constructor() {
        super();

        // Short random per-session id, for correlating this driver with go2rtc's server-side logs.
        // Named clientId (not `id`) to avoid shadowing HTMLElement.id.
        this.clientId = Math.random().toString(36).substring(2, 7).toUpperCase();

        // --- No-data watchdog (warm MSE) ---
        // If the ws stays open but no media bytes arrive for this long, the stream is stalled: reap
        // the socket and reconnect. This is the BASE timeout; _effectiveDisconnectTimeout() extends it
        // while the shared uplink is known-congested (see the adaptive-watchdog block below).
        this.DISCONNECT_TIMEOUT = 5000;
        // Shorter deadline used ONLY while an un-committed RTC probe is live (_rtcPhase
        // negotiating/promoted). There the RTC overlay is additive load on the link, so an MSE-media
        // silence is almost certainly that probe choking the uplink — bail fast and fall back to the
        // still-warm MSE (~1 frame, not a black screen). warm/committed keep the full base. 0 disables.
        this.NEGOTIATING_DISCONNECT_TIMEOUT = 2500;

        // --- First-frame watchdog (promoted RTC) ---
        // pc.connectionState === 'connected' is NOT proof of flowing media: on multi-hop paths the
        // ICE/DTLS connectivity checks (tiny packets) pass while sustained RTP never traverses, so the
        // pc sits 'connected' with no frame ever decoded. If no frame decodes within this long after
        // 'connected', treat it as a WebRTC failure and drop/retry with a freshly gathered ICE path.
        // Generous because the swap is gated on a real decoded frame (see onwebrtc): MSE serves the
        // user meanwhile, so a slow-but-real repeater first frame (can take minutes) must not be reaped
        // early — only genuinely media-less paths hit this. Overridable per-card via `firstframe_timeout`.
        this.FIRSTFRAME_TIMEOUT = 120000;
        this._firstFrameTID = 0;   // first-frame watchdog timer handle
        this._firstFramePoll = 0;  // getStats() poll interval handle (framesDecoded)

        // --- MSE playback-health sampler (always on) ---
        // The no-data watchdog only asks "did bytes arrive?"; on bursty 4G the bytes trickle in within
        // each window so the socket looks alive while the on-screen <video> is buffer-starved and
        // frozen. This samples the ON-SCREEN element's currentTime advance vs wall-clock — the truth
        // the viewer sees — and reports flow/stutter/frozen to the card, independent of RTC. It is the
        // only freeze signal for an MSE-only session (no RTC band verdict, socket never dies).
        this._pbTimer = 0;         // playback-health interval handle
        this._pbLastAt = 0;        // wall-clock ms at last sample (0 = needs re-priming)
        this._pbLastCT = -1;       // onscreen currentTime (s) at last sample (-1 = unset)
        this._pbLastEl = null;     // element sampled last tick — a change (MSE<->RTC overlay) re-primes
        this._pbRatio = 1;         // EWMA of media-advance / wall-advance (1 = realtime)
        this._pbClass = '';        // last emitted verdict: '' | 'flow' | 'stutter' | 'frozen'
        this.PB_SAMPLE_MS = 2000;  // sampler cadence
        this.PB_FLOW_RATIO = 0.7;  // EWMA >= this -> flowing (green)
        this.PB_FROZEN_RATIO = 0.15; // EWMA <= this -> frozen (red); in between -> stutter (yellow)
        // Ride-out: on a SUSTAINED freeze of the MSE element, nudge the picture to the live edge (a
        // non-destructive reseek) instead of letting the no-data watchdog tear the socket into a retry
        // storm. Complements updateend strand-recovery (which fires only when currentTime fell BELOW
        // buffered.start); this covers the bursty-4G freeze where data is still buffered ahead.
        this._pbFrozenRun = 0;       // consecutive 'frozen' samples on the MSE element
        this._rideoutAt = 0;         // wall-clock ms of the last ride-out reseek (cooldown gate)
        this.PB_FROZEN_SAMPLES = 3;  // sustained frozen (~6s) before a nudge — below the 5s watchdog reap
        this.RIDEOUT_COOLDOWN_MS = 10000; // minimum spacing between ride-out reseeks

        // --- Promoted-RTC liveness ---
        // After promotion RTC media flows P2P off the ws, so the MSE no-data watchdog can't see it
        // stall. This is the promoted-RTC liveness deadline: if framesDecoded stops advancing this long
        // the picture is frozen/black and we recover. In the reversible flow (see onwebrtc) a stall
        // BEFORE commit reverts to warm MSE instantly (one frame, no reconnect); AFTER commit it
        // reconnects. 15s rides brief congestion pauses that are normal on repeater paths without being
        // twitchy (shorter reverted on ordinary bursts). Tunable.
        this.RTC_LIVENESS_TIMEOUT = 15000;

        // --- Reversible RTC handoff — explicit phase machine ---
        // MSE stays ATTACHED and warm on this.video; WebRTC decodes on a second, overlaid <video>
        // (this._rtcVideo). The handoff is a 4-state machine on this._rtcPhase:
        //   'warm'        no RTC overlay — MSE only (initial state, and after a revert).
        //   'negotiating' overlay decoding, still hidden (opacity 0); MSE warm. REVERSIBLE.
        //   'promoted'    overlay revealed to the user; MSE still warm underneath. REVERSIBLE.
        //   'committed'   overlay collapsed onto this.video, MSE released, ws closed. IRREVERSIBLE.
        // Legal edges: warm -> negotiating -> promoted -> committed, plus negotiating/promoted -> warm.
        // PITFALL: every transition MUST go through _setPhase() — it is the single logging point and
        // clears the phase timers; setting _rtcPhase directly desyncs the timers and the card mirror.
        this._rtcVideo = null;     // overlaid <video> carrying the RTC MediaStream
        this._rtcPhase = 'warm';   // 'warm' | 'negotiating' | 'promoted' | 'committed'
        this._manualHold = false;  // viewer soft-paused: freeze the on-screen element AND hold the
                                   // commit/revert poll so it cannot auto-resume behind the pause.
        this._commitTID = 0;       // unused in the poll-driven commit model; kept for _clearRtcTimers
        this._mseWanted = false;   // desired mute state of the MSE element, restored on revert/commit
        // Flowing decode required before REVEALING RTC (making the overlay visible). Small: the overlay
        // is already rendered and promotion is reversible, so we can restore RTC near-instantly on good
        // paths and revert harmlessly if it stalls. Tunable.
        this.RTC_PROMOTE_MS = 2000;
        // CONTINUOUS gapless liveness required AFTER promotion before COMMIT (releasing MSE). Commit is
        // the only irreversible step, so it is reserved for genuinely rock-solid paths. Deliberately
        // long: any decode gap > RTC_STALL_RESET restarts this clock, so a bursty repeater never
        // reaches it — it stays in warm-MSE and reverts on each stall. PITFALL: do not shorten this to
        // "upgrade faster" — a short commit window commits flaky cameras that then crash-loop on the
        // next stall (MSE is already gone). Tunable.
        this.RTC_COMMIT_MS = 180000;
        // A decode gap longer than this (but shorter than RTC_LIVENESS_TIMEOUT) counts as instability
        // and restarts the commit stability clock without reverting. Tunable.
        this.RTC_STALL_RESET = 2000;
        // GAPLESS liveness after promotion before emitting the one-shot `rtc_sustained` signal. This is
        // the SHADOW-SWAP gate: the card keeps the proven main visible and swaps a background shadow in
        // only after the shadow has held gaplessly this long, so a shadow that promotes at 2s but then
        // stalls NEVER triggers a swap and the working main is never destroyed for an unproven
        // replacement. Set well beyond RTC_LIVENESS_TIMEOUT (surviving it is real evidence the path
        // beats the reverted main) yet far below the 180s commit (a good upgrade still lands quickly).
        // Overridable per-card via `rtc_swap_prove_ms`.
        this.RTC_SWAP_PROVE_MS = 30000;
        // [Alg.2] GAPLESS time in 'promoted' after which the probe's GCC ramp has plateaued, so the
        // cross-instance _rtcProbeGate token is handed to the NEXT camera. We do NOT hold it for the
        // full 180s commit — that would serialize a good wideband grid at 180s/camera. ~8s covers a
        // typical GCC ramp-to-plateau; a bad path aborts (Alg.3) in ~6s and releases even sooner. Tunable.
        this.RTC_GATE_SETTLE_MS = 8000;

        this._lastLiveness = 0;    // Date.now() of the last framesDecoded advance
        this._stableSince = 0;     // start of the current gapless run (drives the commit clock)
        this._sustainedSignaled = false; // guards the one-shot rtc_sustained (shadow-swap) signal

        // --- Metrics sampler (diagnostic only; harvested from the framesDecoded getStats poll) ---
        // Emits a compact `metrics` line to the card every METRICS_EMIT_MS. Also computes the raw
        // signals the band classifier / adaptive watchdog consume. PITFALL: the emit is diagnostic —
        // stream decisions read _bandExcess/_bandLoss/_congestion, never the emitted text.
        this._mLastBytes = -1;    // previous inbound-rtp bytesReceived (delta -> goodput)
        this._mLastRecv = -1;     // previous packetsReceived           (delta -> loss %)
        this._mLastLost = -1;     // previous packetsLost               (delta -> loss %)
        this._mRttMin = Infinity; // session-min candidate-pair RTT — the queue-empty baseline (Alg.1/4)
        this._mNextEmit = 0;      // Date.now() gate for the next emit
        this.METRICS_EMIT_MS = 3000; // sampling cadence; bypasses the card's 10s log throttle
        // Transport-diagnostic getStats fields (relay/srflx/host + udp/tcp path, jitter-buffer delay,
        // nack count, mean packet size). Diagnostic ONLY — they separate bufferbloat from
        // fragmentation in the logs; no stream decision reads them.
        this._mLastJbDelay = -1;  // previous inbound-rtp jitterBufferDelay (cumulative s)
        this._mLastJbEmit = -1;   // previous inbound-rtp jitterBufferEmittedCount
        this._mLastNack = -1;     // previous inbound-rtp nackCount

        // --- Adaptive no-data watchdog ---
        // The warm-MSE watchdog is not a fixed constant. A tiny in-loop controller folds the metrics
        // above into a smoothed `congestion` score in [0,1] and EXTENDS the effective timeout up to
        // ADAPT_MAX_EXTEND x base while a link is congested; it NEVER shortens below the base. Rationale:
        // an RTC upgrade is additive load that can transiently starve the warm MSE (RTT balloons, loss
        // spikes) on a link that then recovers — a fixed 5s reap tears that recoverable stream down into
        // a reconnect storm. Extending only while congested, then decaying back to the tight base, lets
        // a real stall ride out while a genuinely dead MSE-only stream is still reaped on time. High- and
        // low-band cameras diverge from IDENTICAL code: a substream rarely congests (keeps the base), a
        // main that saturates the link earns the extension automatically. Leading signal: rttExcess =
        // rtt - session-min-rtt (standing queue), reinforced by loss and by _rtcFutility. All thresholds
        // overridable per-card even though the loop self-adapts.
        this.ADAPTIVE_WATCHDOG = true;   // master switch (per-card `mse_adaptive`)
        this.ADAPT_RTT_EXCESS_MS = 400;  // rttExcess (ms) that alone drives congestion -> 1
        this.ADAPT_LOSS_PCT = 20;        // loss (%) that alone drives congestion -> 1
        this.ADAPT_MAX_EXTEND = 6;       // hard cap on the timeout multiplier (5s base -> 30s)
        this.ADAPT_EWMA_ALPHA = 0.3;     // congestion EWMA smoothing (higher = twitchier)
        this._congestion = 0;            // smoothed congestion score [0,1]

        // --- Byte-aware watchdog (self-measured bursty feed) ---
        // The warm ride-out also arms when THIS socket is directly measured to be frozen-but-fed,
        // independent of any RTC probe: MSE fMP4 chunks arriving in bursts with inter-chunk gaps
        // >= WS_BURSTY_GAP_MS mark the stream bursty for WS_BURSTY_MEMORY_MS, and while bursty the reap
        // extends. This closes the pure-MSE narrow-link storm — a link so narrow that even the RTC probe
        // is reaped before it can trip the grid blackout, so no RTC-derived extension ever latches. A
        // smooth stream (sub-second chunks) never trips the gap and stays at the tight base (no
        // regression). Bounded by ADAPT_MAX_EXTEND; self-clears when the feed smooths.
        this.WS_BURSTY_GAP_MS = Math.round(this.DISCONNECT_TIMEOUT / 2);          // 2500ms: gap that marks bursty (0 disables)
        this.WS_BURSTY_MEMORY_MS = this.DISCONNECT_TIMEOUT * this.ADAPT_MAX_EXTEND; // 30000ms: how long one big gap keeps us bursty
        this._wsLastByteAt = 0;          // Date.now() of the last binary ws chunk (0 = fresh socket, primes)
        this._wsBurstyUntil = 0;         // Date.now() until which the stream counts as bursty-fed
        this._rtcFutility = 0;           // decaying penalty for recent doomed RTC promotes [0,1]

        // --- RTC abort (Alg.3/4): give up a doomed un-committed probe, snap back to warm MSE ---
        // The decision reads the same two live stressors the band classifier folds — standing-queue
        // EXCESS (rttEwma - session-min RTT, absolute ms) and short-window loss — so it is loss-aware
        // for free (a path can be RTT-healthy yet unusable at 10-30% loss). A LEAKY ASYMMETRIC
        // ACCUMULATOR integrates a CONTINUOUS severity over time (worsen fast, recover slow): each poll
        // adds pollMs*severity, where severity ramps 0->SEV_MAX as excess/loss exceed their floors.
        // PITFALL: severity must be CONTINUOUS, not bucketed by band label. A discrete 'degr' bucket that
        // accrued nothing was a dead-zone where a clearly-dying canary sat for ~10s and stormed the
        // uplink (dropping HA) before the abort fired. On revert we bump _rtcFutility, which shortens the
        // next probe's hold; rtc_failed then arms the card's backed-off re-probe. Master switch only
        // (per-card `mse_abort`).
        this.RTC_ABORT_ENABLED = true;   // master switch (per-card `mse_abort`)
        this.RTC_ABORT_HOLD_MS = 6000;   // integrated severity*time (ms, at futility 0) that -> abort
        this.RTC_ABORT_FUTILITY_K = 0.5; // futility [0,1] shortens the hold toward HOLD*(1-K)
        this.RTC_ABORT_RECOVER_K = 0.5;  // a healthy poll bleeds _bandBadMs at pollMs*K (<1 -> recover slow)
        // Continuous severity shaping. PITFALL: severity is driven by ABSOLUTE excess (ms of standing
        // queue), NOT the rttEwma/rttMin ratio. The ratio is scale-free and explodes at a tiny LAN
        // baseline (min 2-3ms), where a few ms of harmless jitter reads as 3-4x inflation and
        // false-aborts a 0%-loss LAN grid in a loop. Excess in ms is scale-correct: 5ms of queue is 5ms.
        this.RTC_ABORT_EXCESS_LOW_MS = 200; // standing-queue excess (rttEwma-rttMin, ms) below which no severity accrues
        this.RTC_ABORT_EXCESS_REF_MS = 300; // excess span (ms) per 1.0 severity unit (LOW+REF => sev 1)
        this.RTC_ABORT_LOSS_LOW = 8;     // loss (%) below which no loss-severity accrues
        this.RTC_ABORT_LOSS_REF = 12;    // loss span (%) per 1.0 severity unit (loss LOW+REF => sev 1)
        this.RTC_ABORT_SEV_MAX = 3;      // per-poll severity cap (an extreme link -> abort in ~2s)
        this._bandBadMs = 0;             // leaky integral of severity*time (ms); 0 = clear

        // --- Early band classifier (Alg.1): perf / degr / path within ~2s of a probe ---
        // The reactive levers above (adaptive EXTEND, RTC abort) treat symptoms AFTER a doomed promote
        // has already loaded the link. This classifier folds the per-poll signals ALREADY harvested for
        // the metrics line (candidate-pair RTT, session-min RTT, short-window loss%) into a live verdict
        // within ~2s, so the gate can serialize/parallelize probes proactively. Two consumers: the gate
        // reads the coarse label; the abort reads the continuous excess/loss severity. Runs ONLY while
        // an un-committed probe is live; '' otherwise. Self-calibrating — no user knobs.
        this.BAND_CLASSIFY_MS = 2000;    // min observation before the first verdict (~2s)
        // Self-calibrating band signal: standing-queue EXCESS = rttEwma - session-min-RTT (_mRttMin, the
        // queue-empty baseline), in ms. excess ~ 0 = empty queue -> healthy at ANY absolute RTT (LAN 2ms
        // OR in-form 4G 200ms); excess growing = a standing queue building under the RTC ramp.
        // Subtracting the link's own floor makes it judge the LIVE queue, not "it's 4G"; measuring in
        // ABSOLUTE ms keeps it scale-correct (see the ratio PITFALL above). Loss is an absolute backstop.
        // This label is display+gate only; the abort integrates the continuous severity.
        this.BAND_GOOD_EXCESS_MS = 80;   // excess <= this (with low loss) => 'perf' (queue ~empty)
        this.BAND_PATH_EXCESS_MS = 400;  // excess >= this (or high loss)  => 'path' (standing queue)
        this.BAND_GOOD_LOSS_PCT = 3;     // loss (%) below which, with low excess, the link is 'perf'
        this.BAND_PATH_LOSS_PCT = 15;    // loss (%) at/above which the link is 'path' (lossy path)
        this.BAND_EWMA_ALPHA = 0.4;      // rtt/loss EWMA smoothing (twitchy enough to converge by ~2s)
        this._bandClass = '';            // display/gate label: '' (not probing) | 'perf' | 'degr' | 'path'
        this._bandExcess = -1;           // last standing-queue excess rttEwma-rttMin (ms; -1 = unknown/no baseline)
        this._bandT0 = 0;                // Date.now() the current probe's classification window opened
        this._bandRtt = -1;              // EWMA of instantaneous RTT (ms); -1 = no sample yet
        this._bandLoss = -1;             // EWMA of short-window loss (%); -1 = no sample yet
        this._bandLastLost = -1;         // previous packetsLost  (per-poll delta -> short-window loss%)
        this._bandLastRecv = -1;         // previous packetsReceived (per-poll delta -> short-window loss%)

        // List of supported codecs to announce to the server
        this.CODECS = [
            'avc1.640029', 'avc1.64002A', 'avc1.640033', 'hvc1.1.6.L153.B0',
            'mp4a.40.2', 'mp4a.40.5', 'flac', 'opus',
        ];

        // strictMode gates only the ws 'error' path: false = tolerate a transient ws error and let the
        // watchdog/reconnect handle it (fewer needless teardowns); true = disconnect on any ws error.
        // Recovery (spec close + the 5s watchdog) is mode-independent, so relaxed is the safer default.
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
        
        // Handoff flag: true means WE are closing the ws on purpose (committed to WebRTC), so the
        // socket's own close event must NOT be treated as a failure. PITFALL: clear/set this around
        // every intentional close — a stale false here turns a deliberate handoff into a reconnect loop.
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
        
        // Append the per-session clientId so go2rtc's logs can be correlated with this driver.
        const separator = value.includes('?') ? '&' : '?';
        // streamKey = the URL WITHOUT the per-connection client_id: a stable per-camera identity that
        // survives reconnects. The MSE-reap grid latch keys on it to count DISTINCT cameras.
        this.streamKey = value;
        this.wsURL = value + separator + 'client_id=' + this.clientId;
        
        this.onconnect();
    }

    /**
     * Start playback on the MSE element, tolerating the browser autoplay policy.
     * No-op if already playing (avoids play()/Promise churn). On an autoplay block, retry muted.
     */
    play() {
        if (!this.video || !this.video.paused) return;

        this.video.play().catch(er => {
            if (er.name === 'AbortError') return; // navigated away mid-play(); not a failure

            // PITFALL: mute-fallback ONLY on NotAllowedError (a real autoplay-policy block). Other
            // rejections (transient decode errors, reconnect races) must NOT force a permanent mute —
            // that would silence audio for a non-audio reason (#951).
            if (er.name === 'NotAllowedError' && !this.video.muted) {
                this.video.muted = true;
                this.video.play().catch(e => console.debug(`[VideoRTC:${this.clientId}] Autoplay warn:`, e));
            } else {
                console.debug(`[VideoRTC:${this.clientId}] play() rejected:`, er);
            }
        });
    }

    /**
     * The element the viewer actually sees. While RTC is REVEALED but not yet committed ('promoted')
     * that is the overlay (`_rtcVideo`), with the MSE element hidden underneath; warm/negotiating/
     * committed all present `this.video`.
     * PITFALL: the card must bind the play/pause button and the live-indicator dot to THIS getter, not
     * to `this.video`. Binding to the hidden MSE element while promoted froze the invisible MSE (pause
     * did nothing visible) and turned the dot red on a perfectly healthy RTC stream (#913).
     */
    get onscreenVideo() {
        return (this._rtcPhase === 'promoted' && this._rtcVideo) ? this._rtcVideo : this.video;
    }

    /**
     * Viewer soft-pause: freeze the on-screen element and set _manualHold so the RTC handoff poll
     * can't call play() and silently auto-resume behind the pause. Deliberately keeps the decoder and
     * socket warm (that is the off-screen auto-pause's job) so freeze and resume are both instant.
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
     * Set the audio state for the card's volume button: apply it to the AUDIBLE element (the overlay
     * while promoted, else this.video) AND record it as `_mseWanted`, the desired-audio state that
     * promote/commit/revert restore.
     * PITFALL: go through here, don't toggle `this.video.muted` directly — while promoted that mutes
     * the hidden MSE while the audible overlay keeps its sound, and the next handoff transition then
     * restores the user's choice from a stale `_mseWanted`.
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

        this._startPlaybackSampler();
        _rtcProbeGate.liveDrivers.add(this);   // join the grid registry so a latch can re-arm our warm watchdog
        return true;
    }

    // [MSE PLAYBACK HEALTH] Arm the always-on currentTime-advance sampler (idempotent). Cleared in
    // ondisconnect(). Cheap: one timer, a subtraction, no getStats().
    _startPlaybackSampler() {
        if (this._pbTimer) return;
        this._pbLastAt = 0; this._pbLastCT = -1; this._pbLastEl = null; this._pbRatio = 1; this._pbClass = '';
        this._pbFrozenRun = 0;
        this._pbTimer = setInterval(() => this._samplePlayback(), this.PB_SAMPLE_MS);
    }

    _stopPlaybackSampler() {
        if (this._pbTimer) { clearInterval(this._pbTimer); this._pbTimer = 0; }
    }

    // [MSE PLAYBACK HEALTH] One sample: how far did the ON-SCREEN picture advance vs wall clock? A
    // live stream advances currentTime at ~1x when healthy; a buffer-starved MSE freezes it while
    // the socket (and the no-data watchdog) stay happy. Judged only while we SHOULD be playing —
    // attached, not paused/held, not mid-seek, and playback actually started (ct>0) — so initial
    // buffering and pauses never read as 'frozen'. We sample onscreenVideo (the overlay while an RTC
    // probe is promoted, else this.video) so a hidden warm MSE can't paint a false freeze. Emits to
    // the card on class change only; a light EWMA rejects single-sample noise.
    _samplePlayback() {
        const v = this.onscreenVideo;
        const now = Date.now();
        if (!v || v.paused || this._manualHold || v.seeking || v.currentTime <= 0) {
            this._pbLastAt = 0; this._pbLastCT = -1; this._pbLastEl = v || null;   // not judgeable → re-prime
            return;
        }
        const ct = v.currentTime;
        // Element identity changed (MSE this.video <-> promoted RTC overlay _rtcVideo): the previous
        // baseline belongs to the OTHER element, so ct-_pbLastCT is a cross-element artifact (a large
        // spurious jump, either sign, right after a mode swap). Re-prime, don't judge.
        if (v !== this._pbLastEl) { this._pbLastEl = v; this._pbLastAt = now; this._pbLastCT = ct; return; }
        if (this._pbLastAt <= 0 || this._pbLastCT < 0) { this._pbLastAt = now; this._pbLastCT = ct; return; }
        const dtWall = (now - this._pbLastAt) / 1000;
        const dtMedia = ct - this._pbLastCT;
        this._pbLastAt = now; this._pbLastCT = ct;
        if (dtWall <= 0) return;
        // Clamp to [0,1]: a within-element live-edge reseek jumps currentTime forward — treat as caught-up
        // (flow, ratio 1), never a >1x spike that would drag the EWMA above unity.
        const ratio = Math.max(0, Math.min(1, dtMedia / dtWall));
        this._pbRatio = 0.5 * this._pbRatio + 0.5 * ratio;
        this._pbClass = this._pbRatio >= this.PB_FLOW_RATIO ? 'flow'
            : this._pbRatio <= this.PB_FROZEN_RATIO ? 'frozen' : 'stutter';
        // Emit EVERY judged sample (~2s), not just on change: a steadily-frozen picture must keep
        // refreshing the verdict or the card's staleness sweep would drop it and the dot would go
        // white again while the freeze persists. The card de-dupes for logging (transitions only).
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({
                type: 'playback', value: this._pbClass,
                detail: `advanced ${dtMedia.toFixed(2)}s / ${dtWall.toFixed(1)}s wall (ewma ${this._pbRatio.toFixed(2)})`,
            });
        }
        // [RIDE-OUT — B] Count sustained frozen samples on THIS element and, past the threshold, try a
        // non-destructive live-edge nudge. Counter is per-element: the swap re-prime above `return`s
        // before here, so a promote/revert can't inflate the run across two elements.
        if (this._pbClass === 'frozen') this._pbFrozenRun++; else this._pbFrozenRun = 0;
        this._maybeRideOut(v);
    }

    /**
     * MSE ride-out. On a sustained MSE freeze, nudge the on-screen picture to the live
     * edge instead of waiting for the no-data watchdog to force onclose() (which tears the socket down
     * into the escalating retry storm seen on lossy 4G). MSE element ONLY — the promoted RTC overlay
     * has empty seekable and its own liveness (first-frame poll + band). Only acts when there is unplayed
     * buffer AHEAD of currentTime: if the element is at the buffered end it's a true underrun (nothing
     * to jump to), the reseek would be a no-op, and the watchdog fallback is the correct response.
     * Cooldown-gated so we nudge at most once per RIDEOUT_COOLDOWN_MS and give it a fresh window to work.
     */
    _maybeRideOut(v) {
        if (this._pbFrozenRun < this.PB_FROZEN_SAMPLES) return;
        if (this._manualHold) return;
        if (v !== this.video || this._rtcPhase === 'promoted') return;  // MSE on screen only
        const now = Date.now();
        if (now - this._rideoutAt < this.RIDEOUT_COOLDOWN_MS) return;
        let bEnd = -1;
        const ct = v.currentTime;
        try {
            const b = v.buffered;
            if (b && b.length) bEnd = b.end(b.length - 1);
        } catch (e) { return; }
        if (bEnd <= ct + 0.3) return;   // no buffer ahead → true underrun, let the watchdog handle it
        this._rideoutAt = now;
        this._pbFrozenRun = 0;          // give the nudge a fresh window to prove it un-froze the picture
        const ahead = bEnd - ct;
        try {
            v.currentTime = bEnd;
            if (v.paused) v.play().catch(() => {});
        } catch (e) { return; }
        console.warn(`[VideoRTC:${this.clientId}] MSE ride-out reseek: +${ahead.toFixed(1)}s to live edge (was frozen).`);
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({
                type: 'rideout', value: 'reseek',
                detail: `live-edge nudge +${ahead.toFixed(1)}s (sustained frozen)`,
            });
        }
    }

    /**
     * No-media watchdog. Re-armed on every media byte. If media stops while the socket stays open
     * (frozen MSE, or a black-holed path that never sends FIN/RST) no 'close' event ever fires, so the
     * card would never learn the stream is dead. When the timer elapses we force onclose(), which
     * dispatches 'connection-closed' and lets the card reconnect.
     */
    _feedWatchdog() {
        if (!this.DISCONNECT_TIMEOUT) return;
        if (this.reconnectTID) clearTimeout(this.reconnectTID);
        // Fed by binary ws bytes = MSE fMP4 chunks, so this measures MSE liveness ONLY (RTC media flows
        // P2P and never touches the ws). The effective timeout is the base, EXTENDED while the shared
        // uplink is known-congested (RTC-probe phase, grid blackout, bursty feed, or MSE-reap latch);
        // see _effectiveDisconnectTimeout.
        // PITFALL: do NOT shorten this while an RTC probe is live to "reap the probe faster". The probe
        // is P2P and invisible here — a short window only reaps the warm MSE, which on a bursty link
        // arrives with >2.5s inter-chunk gaps at healthy goodput, so it false-fires and tears the whole
        // connection down (MSE included) into a reconnect storm. Killing a doomed probe is the job of
        // the RTC abort / first-frame watchdog, not this one.
        const timeout = this._effectiveDisconnectTimeout();
        // Snapshot the regime NOW, at ARM time: it is what selected `timeout`. The callback fires up to
        // `timeout` ms later, when a bursty/latched hold may have lapsed — recomputing the label there
        // would mislabel the reap (e.g. a bursty-hold reap printed as `base`). The watchdog only fires
        // when NO byte arrived (so _feedWatchdog wasn't re-called), so this snapshot stays accurate.
        // PITFALL: never move this capture into the fire callback.
        const base = this.DISCONNECT_TIMEOUT;
        const regime = this._timeoutRegime();
        this.reconnectTID = setTimeout(() => {
            this.reconnectTID = 0;
            console.warn(`[VideoRTC:${this.clientId}] No-data watchdog fired (${timeout}ms silent, phase=${this._rtcPhase}, cong=${this._congestion.toFixed(2)}). Forcing close.`);
            // Feed the reap into the MSE-reap grid latch (before onclose tears us down); a fresh latch
            // returns the distinct-camera count, so this line shows the exact reap that engaged it.
            // PITFALL: this only APPENDS to the diagnostic; _closeReason must stay 'no-data-watchdog'
            // (the card's flap classifier keys on that exact string).
            const latched = _rtcProbeGate.noteMseReap(this);
            this._emitByteAwareDiag('ws_reap', `${timeout}ms (${regime}, base ${base}ms)`
                + (latched ? ` → grid-latch ${latched} cams` : ''));
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
     * Byte-aware watchdog: fold one binary ws chunk into the burstiness tracker. Called from onopen's
     * binary branch BEFORE _feedWatchdog, so the re-armed timeout reflects the gap that just closed. An
     * inter-chunk gap >= WS_BURSTY_GAP_MS is the congested-uplink signature (bursts, not smooth flow)
     * and marks the stream bursty-fed for WS_BURSTY_MEMORY_MS. Cheap: two field writes.
     */
    _noteWsByte() {
        const now = Date.now();
        if (this._wsLastByteAt > 0 && (now - this._wsLastByteAt) >= this.WS_BURSTY_GAP_MS) {
            const gap = now - this._wsLastByteAt;
            const wasBursty = now < this._wsBurstyUntil;   // already inside a hold window?
            this._wsBurstyUntil = now + this.WS_BURSTY_MEMORY_MS;
            // One debug line per bursty ARM edge (not per byte, to avoid flooding): a >= WS_BURSTY_GAP_MS
            // inter-chunk gap just primed/extended the frozen-but-fed hold. If no ~base 'ws-reap' line
            // follows, the extend rode the burst out (the success case, which otherwise leaves no trace).
            if (!wasBursty) {
                this._emitByteAwareDiag('ws_bursty_armed',
                    `gap ${gap}ms → hold ${Math.round(this.WS_BURSTY_MEMORY_MS / 1000)}s`);
            }
        }
        this._wsLastByteAt = now;
    }

    /**
     * Mirror one byte-aware-watchdog milestone to the card's HA log via the ui_sync signal channel
     * (same path as rtc_suppressed/rtc_failed). Diagnostic ONLY — no stream side effects. The card
     * routes it to a throttled _logHA('debug', 'ws-bursty' | 'ws-reap').
     */
    _emitByteAwareDiag(value, detail) {
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({ type: 'signal', value, detail });
        }
    }

    /**
     * True while the stream is provably frozen-but-fed: a recent inter-chunk gap crossed
     * WS_BURSTY_GAP_MS and its memory window has not lapsed. WS_BURSTY_GAP_MS = 0 disables.
     */
    _wsBurstyFed() {
        return this.WS_BURSTY_GAP_MS > 0 && Date.now() < this._wsBurstyUntil;
    }

    /**
     * Retroactive re-arm, called by _rtcProbeGate on a FRESH grid latch (blackout or MSE-reap). A warm
     * stream that fell silent JUST BEFORE the latch still holds a base(5s) timer from its last byte and
     * would reap mid-latch before a new byte could extend it. Re-arm from NOW so it picks up the (now
     * extended) effective timeout and rides the latch out.
     * PITFALL: guarded on a live socket AND an already-armed watchdog — we must NOT CREATE a watchdog
     * here (a torn-down or RTC-only driver stays untouched). Since _feedWatchdog reads
     * _effectiveDisconnectTimeout, a black (video.error) or still-probing element correctly re-arms at
     * base, not the extend.
     */
    _rearmWatchdogForBlackout() {
        if (this.ws && this.reconnectTID) this._feedWatchdog();
    }

    /**
     * [ADAPTIVE WATCHDOG] Fold one metrics sample into the smoothed `congestion` score. The
     * instantaneous congestion is the STRONGER of two independent, self-normalizing stressors
     * (either alone is enough to be "congested"): queueing delay rttExcess = rtt - session-min-rtt
     * (bufferbloat) scaled by ADAPT_RTT_EXCESS_MS, and loss% scaled by ADAPT_LOSS_PCT. An EWMA damps
     * the whole thing (no discrete flapping). All inputs in ms / percent; -1 = no sample.
     *
     * PITFALL: `_rtcFutility` must NOT feed `inst` here. Folding it in raises congestion after a doomed
     * promote, which EXTENDS the watchdog — i.e. babies the very probe that just failed (backwards).
     * Futility drives SUPPRESSION only (it shortens the abort hold in _evaluateBandAbort); only its
     * decay lives here, per emit, so a good stretch bleeds the penalty off.
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
        this._rtcFutility *= 0.9;                       // decay ~1 sample; consumed by _evaluateBandAbort
        const a = this.ADAPT_EWMA_ALPHA;
        this._congestion = a * inst + (1 - a) * this._congestion;
    }

    /**
     * [RTC ABORT — Alg.4] Integrate the CONTINUOUS band severity into the abort decision, once per
     * poll (`pollMs` cadence) while an un-committed RTC probe is live (negotiating/promoted). Leaky
     * ASYMMETRIC accumulator driven by severity = max(excess-severity, loss-severity), each 0..SEV_MAX:
     * accrue `pollMs*severity` (worsen ∝ how bad AND how long), bleed `pollMs*RECOVER_K` only when clearly
     * healthy (K<1 → recover slow), hold in the narrow middle. Aborting only when the integral crosses
     * the futility-shortened hold keeps a flap-absorbing stability window; outside the probe the
     * accumulator is held at 0 by `_resetBandClassifier`.
     * PITFALL: severity is CONTINUOUS, not a discrete band-label bucket. A categorical 'degr' bucket
     * that accrued nothing was a dead-zone where a clearly-dying canary sat ~10s accruing zero and
     * stormed the uplink before the abort fired.
     */
    _evaluateBandAbort(pollMs) {
        if (!this.RTC_ABORT_ENABLED) return;
        if (this._rtcPhase !== 'negotiating' && this._rtcPhase !== 'promoted') return;
        // Continuous severity from the two live stressors: standing-queue EXCESS (rttEwma minus the
        // link's own queue-empty floor, in ms) and absolute loss. Each ramps 0 -> SEV_MAX past its
        // floor; accrue pollMs*max(sev), bleed only when clearly healthy, HOLD in the narrow middle.
        // PITFALL: EXCESS is in ms, NOT the rttEwma/rttMin ratio — the ratio explodes at a tiny LAN
        // baseline (a few ms of jitter reads as 3-4x) and false-aborts a 0%-loss LAN grid.
        const excess = this._bandExcess, loss = this._bandLoss, cap = this.RTC_ABORT_SEV_MAX;
        const clamp = (x) => Math.max(0, Math.min(cap, x));
        const sevExcess = excess >= 0 ? clamp((excess - this.RTC_ABORT_EXCESS_LOW_MS) / this.RTC_ABORT_EXCESS_REF_MS) : 0;
        const sevLoss = loss >= 0 ? clamp((loss - this.RTC_ABORT_LOSS_LOW) / this.RTC_ABORT_LOSS_REF) : 0;
        const sev = Math.max(sevExcess, sevLoss);
        if (sev > 0) {
            this._bandBadMs += pollMs * sev;                       // worsen ∝ severity × time
        } else if ((excess < 0 || excess <= this.BAND_GOOD_EXCESS_MS) &&
                   (loss < 0 || loss < this.BAND_GOOD_LOSS_PCT)) {
            this._bandBadMs = Math.max(0, this._bandBadMs - pollMs * this.RTC_ABORT_RECOVER_K); // heal
        } // mild middle (GOOD_EXCESS < excess < EXCESS_LOW): neither accrue nor bleed — just hold
        const k = Math.max(0, Math.min(1, this.RTC_ABORT_FUTILITY_K));
        const hold = this.RTC_ABORT_HOLD_MS * (1 - k * Math.max(0, Math.min(1, this._rtcFutility)));
        if (this._bandBadMs >= hold) {
            const held = Math.round(this._bandBadMs);
            this._bandBadMs = 0;
            this._abortRtcProbe(Math.round(hold), held);
        }
    }

    /**
     * [RTC ABORT — Alg.3] Give up on the current pathological RTC probe: snap back to the warm MSE
     * (one-frame recovery, MSE never stopped). _revertToWarmMSE bumps `_rtcFutility` (shorter next
     * hold) and emits `rtc_failed`, which arms the card's backed-off re-probe loop (the suppression).
     */
    _abortRtcProbe(hold, held) {
        console.warn(`[VideoRTC:${this.clientId}] RTC probe ABORTED — sustained bad band ` +
            `(band=${this._bandClass || '?'} exc=${this._bandExcess >= 0 ? Math.round(this._bandExcess) + 'ms' : '?'} ` +
            `integral ${held}ms >= ${hold}ms, phase=${this._rtcPhase}, ` +
            `futility=${this._rtcFutility.toFixed(2)}).`);
        // [A0-grid] band=path = the SHARED uplink is constrained, so black out RTC for the WHOLE grid,
        // not just this camera. The per-card flap score can't see the 4-camera aggregate that crashes
        // HA (each card only reverts once → score 1.0, never latches). One fresh transition → one
        // rtc_suppressed to this card so it goes MSE-only + RED; other cameras learn at their next
        // (denied) acquire. degr/'' stay ambiguous and only re-serialize (reportBand), as before.
        if (this._bandClass === 'path' && _rtcProbeGate.suppress(this)
            && this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_suppressed',
                detail: `grid blackout (band=path) — RTC paused ${Math.round(_rtcProbeGate.SUPPRESS_MS / 1000)}s` });
        }
        this._revertToWarmMSE(`RTC aborted: sustained bad band (band=${this._bandClass || '?'}, ${held}ms)`);
    }

    /**
     * [EARLY BAND CLASSIFIER — Alg.1] Fold one 500ms poll sample into the live band verdict. Runs
     * only while an un-committed probe is live (negotiating/promoted); the caller resets state via
     * `_resetBandClassifier()` at probe start and on leaving the probe. RTT is the instantaneous
     * candidate-pair value (no delta); loss is a per-poll delta over packetsLost/packetsReceived.
     * Both feed a fast EWMA so a verdict lands by ~BAND_CLASSIFY_MS and then tracks the link live as
     * a promote loads it. Verdict precedence: 'path' (either signal past its pathological ceiling)
     * dominates, else 'perf' (both signals healthy), else 'degr'. Before the window elapses the class
     * stays '' (not yet decided). rttMs/lostCount/recvCount: -1 = no sample. Pure classification —
     * OBSERVE-ONLY for now (surfaced on the metrics line); no stream decision keys on it yet.
     */
    _classifyBand(rttMs, lostCount, recvCount) {
        const a = this.BAND_EWMA_ALPHA;
        if (rttMs >= 0) this._bandRtt = this._bandRtt < 0 ? rttMs : a * rttMs + (1 - a) * this._bandRtt;
        if (lostCount >= 0 && recvCount >= 0 && this._bandLastLost >= 0 && this._bandLastRecv >= 0) {
            const dLost = Math.max(0, lostCount - this._bandLastLost);
            const dRecv = Math.max(0, recvCount - this._bandLastRecv);
            if (dLost + dRecv > 0) {
                const lp = 100 * dLost / (dLost + dRecv);
                this._bandLoss = this._bandLoss < 0 ? lp : a * lp + (1 - a) * this._bandLoss;
            }
        }
        if (lostCount >= 0) this._bandLastLost = lostCount;
        if (recvCount >= 0) this._bandLastRecv = recvCount;
        // [Alg.4.1] Standing-queue EXCESS vs the session-min RTT (_mRttMin, the queue-empty baseline),
        // in ms. Needs both a baseline and a smoothed RTT; until then excess is unknown (-1) and no
        // relative verdict is possible (loss can still condemn via the absolute backstop below).
        const minMs = this._mRttMin < Infinity ? this._mRttMin * 1000 : -1;
        this._bandExcess = (minMs >= 0 && this._bandRtt >= 0) ? Math.max(0, this._bandRtt - minMs) : -1;
        // Hold the verdict until we have both a starting timestamp and BAND_CLASSIFY_MS of samples.
        if (!this._bandT0 || Date.now() - this._bandT0 < this.BAND_CLASSIFY_MS) return;
        const excess = this._bandExcess, loss = this._bandLoss;
        const pathBad = (excess >= 0 && excess >= this.BAND_PATH_EXCESS_MS) ||
                        (loss >= 0 && loss >= this.BAND_PATH_LOSS_PCT);
        const good = excess >= 0 && excess <= this.BAND_GOOD_EXCESS_MS &&
                     (loss < 0 || loss < this.BAND_GOOD_LOSS_PCT);
        this._bandClass = pathBad ? 'path' : good ? 'perf' : 'degr';
    }

    /** [EARLY BAND CLASSIFIER — Alg.1] Arm/clear the classifier. Called with `true` when a probe's
     *  classification window opens (phase -> negotiating) and `false` on leaving the probe. */
    _resetBandClassifier(arm) {
        this._bandClass = '';
        this._bandExcess = -1;
        this._bandT0 = arm ? Date.now() : 0;
        this._bandRtt = -1;
        this._bandLoss = -1;
        this._bandLastLost = -1;
        this._bandLastRecv = -1;
        this._bandBadMs = 0;             // [Alg.3] clear the abort integral with the classifier
    }

    /**
     * The live no-data timeout. Two regimes:
     *
     * (1) RTC probe live (negotiating/promoted) — the one window where an additive RTC ramp starves the
     *     warm MSE: extend the base by up to ADAPT_MAX_EXTEND x in proportion to smoothed congestion.
     *
     * (2) warm/committed (pc-less MSE) — the base, because a plain MSE stall is genuine death, reap on
     *     time. Three exceptions extend to base x ADAPT_MAX_EXTEND, each meaning the shared uplink is
     *     KNOWN-congested so a frozen-but-fed stream should ride out rather than stampede into a storm:
     *       - _rtcProbeGate.suppressed        grid-wide band=path blackout is latched,
     *       - _rtcProbeGate.mseReapCongested  the cold-start MSE-reap quorum latched (bridges the gap
     *                                         before suppression can),
     *       - _wsBurstyFed()                  this socket is self-measured bursty (no grid latch needed).
     *     The extend is BOUNDED (a truly dead stream is still reaped within the extended window, never
     *     the ∞ of a global disable) and self-clearing. Smooth links never trip any exception, so their
     *     warm reap stays at the tight base (no regression on healthy links).
     * PITFALL: the video.error guard comes FIRST among the exceptions — a decode-errored (black) element
     * never self-recovers, so it must reap at base, not be held black for the whole latch.
     * Never returns less than base; 0 (disabled) is honored by the caller's guard.
     */
    _effectiveDisconnectTimeout() {
        const base = this.DISCONNECT_TIMEOUT;
        if (!base || !this.ADAPTIVE_WATCHDOG) return base;
        const rtcProbing = this._rtcPhase === 'negotiating' || this._rtcPhase === 'promoted';
        if (!rtcProbing) {
            // Black-screen guard (must precede the extends). The ride-out only pays off while the
            // element is HOLDING its last frame (a benign MSE underrun, video.error == null, which
            // self-recovers when the next burst lands). A terminal MediaError (e.g. code 3 DECODE from a
            // keyframe-gapped fMP4 fragment) BLACKS the element and is unrecoverable without a fresh
            // source; the byte trickle keeps feeding the watchdog, so without this we would hold the
            // full extend of BLACK. Reap at base → the card reconnects to a clean keyframe.
            // PITFALL: video.error is set only on real terminal errors (never on an underrun), so this
            // never reaps a merely-underrunning held frame.
            if (this.video && this.video.error) return base;
            if (_rtcProbeGate.suppressed) return base * this.ADAPT_MAX_EXTEND;      // grid blackout latched
            if (_rtcProbeGate.mseReapCongested) return base * this.ADAPT_MAX_EXTEND; // cold-start reap quorum
            if (this._wsBurstyFed()) return base * this.ADAPT_MAX_EXTEND;           // self-measured bursty feed
            return base;
        }
        const mult = 1 + (this.ADAPT_MAX_EXTEND - 1) * Math.max(0, Math.min(1, this._congestion));
        return Math.round(base * mult);
    }

    /**
     * Label naming the regime that CURRENTLY sets the reap timeout — the same branch ladder as
     * _effectiveDisconnectTimeout(), as a string. Captured at watchdog ARM time (see _feedWatchdog) so
     * the `ws-reap` line reports what actually held the socket.
     *   base            = base timeout, no extend engaged
     *   probe-congest   = RTC probe phase, congestion-scaled extend
     *   black           = video.error terminal decode error, fast base reap
     *   suppressed-hold = band=path grid blackout extend
     *   mse-congest-hold= cold-start MSE-reap grid-latch extend
     *   bursty-hold     = self-measured frozen-but-fed (byte-aware) extend
     * PITFALL: keep this ladder IN THE SAME ORDER as _effectiveDisconnectTimeout — the label must match
     * the branch that actually selected the timeout.
     */
    _timeoutRegime() {
        const base = this.DISCONNECT_TIMEOUT;
        if (!base || !this.ADAPTIVE_WATCHDOG) return 'base';
        if (this._rtcPhase === 'negotiating' || this._rtcPhase === 'promoted') return 'probe-congest';
        if (this.video && this.video.error) return 'black';
        if (_rtcProbeGate.suppressed) return 'suppressed-hold';
        if (_rtcProbeGate.mseReapCongested) return 'mse-congest-hold';
        if (this._wsBurstyFed()) return 'bursty-hold';
        return 'base';
    }

    /**
     * Passive metric sampler. Called every 500ms from the getStats poll; accumulates deltas over
     * METRICS_EMIT_MS and emits a compact `metrics` line to the card. Side-effect-free w.r.t. the
     * stream — it only observes and logs, safe on every path. It also maintains _mRttMin (the
     * queue-empty RTT floor) that Alg.1/Alg.4 subtract to get standing-queue excess.
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
        // Transport-diagnostic windowed deltas (jitter-buffer delay, nack, packet size): they separate
        // bufferbloat from fragmentation in the logs. Diagnostic only.
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
        const summary =
            `phase=${this._rtcPhase} rtt=${rttMs}ms(min ${baseMs}) ` +
            `loss=${lossPct >= 0 ? lossPct.toFixed(1) : '?'}% gp=${gp >= 0 ? gp.toFixed(0) : '?'}kb/s ` +
            `jit=${jit >= 0 ? Math.round(jit * 1000) : '?'}ms cong=${this._congestion.toFixed(2)} ` +
            `jbuf=${jbufMs >= 0 ? jbufMs : '?'}ms nack=${dNack >= 0 ? dNack : '?'} ` +
            `pkt=${pktB >= 0 ? pktB : '?'}B path=${path || '?'} band=${this._bandClass || '?'} ` +
            `exc=${this._bandExcess >= 0 ? Math.round(this._bandExcess) + 'ms' : '?'}`;
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({ type: 'metrics', value: summary });
        }
    }

    /**
     * The Destructor. Clean up ALL resources.
     */
    ondisconnect() {
        // [RTC SERIALIZER — Alg.2] Leave the probe gate on teardown: drop from the queue if we
        // were still waiting our turn, or release the token if we were the active ramp.
        _rtcProbeGate.release(this);
        _rtcProbeGate.liveDrivers.delete(this);  // leave the grid registry
        this._clearWatchdog();
        this._stopPlaybackSampler();
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

        this._wsLastByteAt = 0;   // [#1] fresh socket: first byte primes, no bogus startup gap
        this._wsBurstyUntil = 0;

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
                this._noteWsByte();   // [#1] fold the inter-chunk gap in BEFORE feeding, so the re-arm sees it
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
                        // Strand recovery: currentTime fell BELOW buffered.start(0) — either autoplay
                        // never started before the buffer window slid past currentTime=0 (slow-4G /
                        // backgrounded first frame), or an MSE stall left currentTime behind an evicted
                        // region. The element then waits forever for data that was just removed →
                        // permanent freeze. Seek to the live edge ONCE on exactly that condition.
                        // PITFALL: this is NOT a continuous currentTime=start catch-up (see the note
                        // below on #910/#884 — that pinned iOS playbackRate and crawled). It fires only
                        // on the pathology; on a healthy stream currentTime sits at the live edge, well
                        // above buffered.start, so it never triggers. Never overrides a manual hold.
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
        // [RTC PROBE SERIALIZER — Alg.2] Wait our turn before opening the pc or sending the offer,
        // so at most one RTC ramp runs across the whole page. MSE already started unblocked in
        // onconnect and keeps flowing while we wait, so a queued camera adds ZERO extra load. Only
        // serialize when MSE is the parallel fallback: a webrtc-only stream has no double-load to
        // prevent and must not wait behind other cameras' ramps for its ONLY video. If this driver
        // is torn down while still queued, ondisconnect()/_revertToWarmMSE drop it from the queue.
        if (!this.mode.includes('mse')) { this._openWebRTC(); return; }
        _rtcProbeGate.acquire(this).then((go) => {
            if (!go) {   // [A0-grid] a band=path grid blackout is in effect — abstain, stay on MSE, tell the card
                if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                    this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_suppressed',
                        detail: 'grid blackout (band=path) — RTC probe denied' });
                }
                return;
            }
            if (!this.ws) { _rtcProbeGate.release(this); return; }  // torn down while queued
            this._openWebRTC();
        });
    }

    /** Open the WebRTC PeerConnection and send the offer. Gated by onwebrtc() via _rtcProbeGate. */
    _openWebRTC() {
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
            // [RTC SERIALIZER — Alg.2] The probe is dying on EVERY failWebRTC path (pc failed,
            // disconnected, offer rejected) — including a fast ICE failure that never reached the
            // 'negotiating' phase, so no _setPhase('warm') would release it. Hand the token on now
            // so it can't wedge the grid until the lease timeout. Idempotent with the release inside
            // _revertToWarmMSE's _setPhase('warm') below.
            _rtcProbeGate.release(this);
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
                    // Carry the reason (see _revertToWarmMSE) so the card mirrors it to the HA log.
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
                // Harvest passive metrics from the SAME poll: inbound-rtp (goodput/loss/jitter) +
                // selected candidate-pair RTT. PITFALL: promote/commit/revert stay framesDecoded-only;
                // these values feed only the band classifier / adaptive watchdog / diagnostics.
                let mBytes = -1, mRecv = -1, mLost = -1, mJit = -1, mRtt = -1;
                // Transport-diagnostic fields harvested from the SAME poll (diagnostic only).
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
                // [EARLY BAND CLASSIFIER — Alg.1] Runs on the full 500ms poll cadence (not the 3s
                // metrics emit) so the verdict converges by ~BAND_CLASSIFY_MS; _setPhase gates its
                // lifetime, so a no-op outside negotiating/promoted is a stale-but-harmless '' class.
                this._classifyBand(mRtt >= 0 ? Math.round(mRtt * 1000) : -1, mLost, mRecv);
                // [RTC ABORT — Alg.3] Integrate the fresh verdict into the abort accumulator on the
                // same 500ms cadence (a no-op outside negotiating/promoted).
                this._evaluateBandAbort(500);
                // [RTC SERIALIZER — Alg.2 band-adaptive] Report the canary's verdict to the gate:
                // band=perf opens it (fat pipe → parallel ramps, no serialization cost), band=path
                // re-arms serialization. Only the ramping probe(s) poll, so this stays cheap.
                _rtcProbeGate.reportBand(this, this._bandClass);
                // [A0-grid] If the shared gate went into a band=path blackout while THIS probe was
                // already ramping (the gate had opened on sustained perf, then a camera revealed
                // band=path), suppress() only denies NEW/queued acquires — it can't recall a probe
                // already past the gate. Drain it here: an un-committed probe self-aborts within one
                // poll of the blackout engaging. Emit rtc_suppressed first so the card latches MSE-only
                // immediately (the rtc_failed from _revertToWarmMSE then no-ops its bailed re-probe).
                if (_rtcProbeGate.suppressed &&
                    (this._rtcPhase === 'negotiating' || this._rtcPhase === 'promoted')) {
                    if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                        this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_suppressed',
                            detail: 'grid blackout (band=path) — in-flight probe drained' });
                    }
                    this._revertToWarmMSE('grid blackout (band=path) — draining in-flight RTC probe');
                    return;
                }
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
                    // [RTC SERIALIZER — Alg.2] Once promoted RTC has held gaplessly past the settle
                    // window its GCC ramp has plateaued: hand the probe gate to the NEXT camera now,
                    // rather than holding it the full RTC_COMMIT_MS. Guarded on holder===this so it's
                    // a single cheap release, not a per-poll queue scan.
                    if (_rtcProbeGate.holder === this && this._rtcPhase === 'promoted' && gapless >= this.RTC_GATE_SETTLE_MS) {
                        _rtcProbeGate.release(this);
                    }
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
        // [EARLY BAND CLASSIFIER — Alg.1] The classification window spans the un-committed probe:
        // arm it as negotiating opens, keep it running through promoted, clear it once the probe
        // leaves (warm = reverted/rejected, committed = MSE released). Central here so every edge
        // routes through one place.
        if (next === 'negotiating') this._resetBandClassifier(true);
        else if (next === 'warm' || next === 'committed') {
            this._resetBandClassifier(false);
            // [RTC SERIALIZER — Alg.2] The probe has left the ramp (warm = reverted/rejected,
            // committed = MSE released): release the gate so the next queued camera can ramp.
            _rtcProbeGate.release(this);
        }
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
        // [ADAPTIVE WATCHDOG / RTC ABORT] A revert = a doomed/abandoned RTC promote. Raise the
        // decaying futility floor. Futility SHORTENS the next probe's abort hold (_evaluateBandAbort)
        // so a repeatedly-doomed path gives up faster — it no longer lengthens the watchdog extension
        // (that inversion is fixed in _updateCongestion).
        this._rtcFutility = Math.min(1, this._rtcFutility + 0.5);
        this._clearRtcTimers();
        this._dropRtcOverlay();
        this.video.muted = this._mseWanted;
        if (this.pc) { this.pc.close(); this.pc = null; }
        this._setPhase('warm');
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            // Carry the reason so the card can mirror it to the HA log. Without it a band abort, a
            // stall revert and an ICE-drop all show as a bare `mode: rtc -> mse` — indistinguishable.
            // `detail` self-identifies the cause ("RTC aborted: sustained bad band (band=…, …ms)" etc.).
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