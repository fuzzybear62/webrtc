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

import {VideoRTC} from './video-rtc.js?v=2.3.7';
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

        console.info('[WebRTC Camera] v14.2.10');
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
        this._logHA('info', 'auto-pause', 'off-screen/hidden');
        this._paused = true;

        // Kill every pending timer so nothing revives the stream while paused.
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
        if (this._upgradeTimer) { clearTimeout(this._upgradeTimer); this._upgradeTimer = null; }
        if (this._shadowTimeout) { clearTimeout(this._shadowTimeout); this._shadowTimeout = null; }
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
        this._logHA('info', 'auto-resume', 'back on-screen');
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

    // [DEBUG LOGGING] Is server-side logging enabled for this card?
    // `debug: true` → always; `debug: <entity_id>` (e.g. input_boolean.debug) → gated LIVE on
    // that entity being 'on' (lets one global switch toggle logging for the whole fleet without
    // editing every card); anything else / unset → off (default). Never logs to HA otherwise.
    _debugEnabled() {
        const d = this.config && this.config.debug;
        if (d === true) return true;
        if (typeof d === 'string' && d.indexOf('.') > 0) {
            if (this._hass && !this._hass.states[d]) {
                // Typo / not-yet-created helper: warn ONCE so a silent misconfig
                // doesn't look like a broken logging feature. Debug stays off.
                if (this._debugEntityWarned !== d) {
                    console.warn(`[WebRTC Camera] debug entity "${d}" does not exist ` +
                        `on HA — logging stays off. Check the entity_id.`);
                    this._debugEntityWarned = d;
                }
                return false;
            }
            return !!(this._hass && this._hass.states[d] &&
                this._hass.states[d].state === 'on');
        }
        return false;
    }

    // [DEBUG LOGGING] Mirror one stream-lifecycle event to home-assistant.log via
    // system_log.write. Dedup-throttled: the first occurrence of an event emits immediately;
    // repeats within the window are counted and flushed once as a summary, so a continuously
    // failing stream cannot flood the log. `level` ∈ debug|info|warning|error|critical.
    _logHA(level, event, detail) {
        if (!this._debugEnabled() || !this._hass) return;
        if (!this._logThrottle) this._logThrottle = new Map();

        const WINDOW = 10000;
        const now = Date.now();
        const rec = this._logThrottle.get(event);

        if (rec && (now - rec.last) < WINDOW) {
            rec.count++;
            rec.last = now;
            rec.level = level;
            rec.detail = detail;
            if (rec.timer) clearTimeout(rec.timer);
            rec.timer = setTimeout(() => this._flushLog(event), WINDOW);
            return;
        }

        this._emitLog(level, event, detail);
        this._logThrottle.set(event, { last: now, count: 0, level, detail, timer: null });
    }

    _flushLog(event) {
        const rec = this._logThrottle && this._logThrottle.get(event);
        if (!rec) return;
        if (rec.count > 0) {
            this._emitLog(rec.level, event,
                `${rec.detail != null ? rec.detail + ' ' : ''}(repeated ${rec.count}× in 10s)`);
        }
        this._logThrottle.delete(event);
    }

    _emitLog(level, event, detail) {
        const cam = (this.config && (this.config.url || this.config.entity)) || '?';
        const message = `[${cam}] ${event}${detail != null ? ': ' + detail : ''}`;
        try {
            this._hass.callService('system_log', 'write', {
                level,
                // Dedicated sub-logger so the card's opt-in debug events can be raised to `info`
                // ALONE (logger: logs: custom_components.webrtc.card: info) without un-muting the
                // chatty backend proxy logging (handshake/benchmark) on `custom_components.webrtc`.
                logger: 'custom_components.webrtc.card',
                message,
            });
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

    // [DEBUG LOGGING] A lightweight, always-attached visibilitychange listener that only EMITS
    // when debug is on (the emit self-gates). With `background: true` (default) the card does
    // NOT tear down when the tab/app hides, so these lines are the only server-side signal that
    // a stream loss coincided with the mobile app backgrounding or a 5G→Wi-Fi handoff.
    _setupDebugVisibilityLog() {
        if (this._logVisAbort) return; // already wired
        this._logVisAbort = new AbortController();
        document.addEventListener('visibilitychange', () => {
            this._logHA('info', document.visibilityState === 'hidden' ? 'page-hidden' : 'page-visible');
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
        this._handleConnectionClosed = (e) => {
            const reason = (e && e.detail && e.detail.reason) || 'closed';
            console.warn(`[WebRTC Camera] Main Driver Connection Closed (${reason})`);
            this._logHA('warning', 'connection-closed', reason);
            this._scheduleRetry();
        };
        newDriver.addEventListener('connection-closed', this._handleConnectionClosed);

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
                this._retryCount = 0;
                this._streamHealthy = true;
                // A real media mode is on screen: release any retry height-lock (the new stream
                // now sizes the card) and log the recovery.
                this._unlockHeight();
                this._logHA('info', 'stream-up', msg.type);
                break;
        }
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
        
        driverRef.removeEventListener('connection-closed', this._handleConnectionClosed);
        
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
        if (this._retryTimer) clearTimeout(this._retryTimer);
        if (this._isReconnecting) return;

        // [LAYOUT] Freeze the current card height BEFORE the driver is torn down, so the video
        // area does not collapse during the retry gap and trigger a section-wide re-pack. The
        // <video> is still sized here (frozen last frame); released once a new mode comes up.
        this._lockHeight();

        this._isReconnecting = true;
        this._streamHealthy = false;
        // [RTC RE-PROBE] The driver is being torn down and cold-restarted; a fresh
        // negotiation re-arms the loop from scratch, so drop the stale backoff now.
        this._stopReprobe();
        this._setActiveMode(null);

        const delay = Math.min(
            1000 * Math.pow(2, this._retryCount),
            30000
        );

        console.debug(`[WebRTC Camera] Scheduling retry in ${delay}ms`);
        this._logHA('info', 'retry', `attempt #${this._retryCount + 1} in ${delay}ms`);

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

        // Resolve the effective stream configuration.
        // Stream-specific overrides are merged here only.
        const currentStream = this.config.streams[this.streamID] || {};
        const effectiveConfig = {...this.config, ...currentStream};

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
        newDriver.mode = effectiveConfig.mode;
        newDriver.media = effectiveConfig.media;

        // [TUNABLES] Optional per-card overrides for the reversible-RTC timing knobs; defaults
        // live in the driver constructor. Accept only sane positive numbers, else keep default.
        const proveMs = Number(effectiveConfig.rtc_swap_prove_ms);
        if (Number.isFinite(proveMs) && proveMs > 0) newDriver.RTC_SWAP_PROVE_MS = proveMs;
        const firstFrameMs = Number(effectiveConfig.firstframe_timeout);
        if (Number.isFinite(firstFrameMs) && firstFrameMs > 0) newDriver.FIRSTFRAME_TIMEOUT = firstFrameMs;

        // Network strict mode propagates directly to the driver.
        newDriver.strictMode =
            effectiveConfig.network_strict !== undefined
                ? effectiveConfig.network_strict
                : this.config.network_strict;

        // Any unexpected connection close triggers a controlled retry.
        // [SEAMLESS HANDOVER] Only main driver triggers global retry. Shadow driver just dies silently.
        if (!isShadowMode) {
            this._handleConnectionClosed = (e) => {
                const reason = (e && e.detail && e.detail.reason) || 'closed';
                console.warn(`[WebRTC Camera] Main Driver Connection Closed (${reason})`);
                this._logHA('warning', 'connection-closed', reason);
                this._scheduleRetry();
            };
            newDriver.addEventListener('connection-closed', this._handleConnectionClosed);
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
            ui_sync: (msg) =>
                this.shadowDriver === newDriver
                    ? this._onPreSwapShadowMessage(newDriver, msg)
                    : this._onMainMessage(newDriver, msg),
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
                this._retryCount = 0;
                this._streamHealthy = true;
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
            
            // [SEAMLESS HANDOVER] Apply poster to new driver immediately (including shadow)
            if (this.config.poster) {
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
        const effectiveConfig = {...this.config, ...stream};

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
                <ha-circular-progress class="spinner"></ha-circular-progress>
                <div class="ptz-transform"></div>
            </div>
            <div class="header">
                <div class="status"></div>
                <div class="right-controls">
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

        // Apply initial icon state
        volBtn.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';

        // [FIX 1/2] Bind video events to the persistent spinner
        video.addEventListener('waiting', () => { if(spinner) spinner.style.display = 'block'; }, {signal});
        video.addEventListener('playing', () => { if(spinner) spinner.style.display = 'none'; }, {signal});

        video.addEventListener('play', () => playBtn.style.display = 'none', {signal});
        video.addEventListener('pause', () => playBtn.style.display = 'block', {signal});
        video.addEventListener('loadeddata', () => volBtn.style.display = this.hasAudio ? 'block' : 'none', {signal});
        video.addEventListener('volumechange', () => {
             volBtn.icon = video.muted ? 'mdi:volume-mute' : 'mdi:volume-high';
        }, {signal});

        video.addEventListener('enterpictureinpicture', () => pipIcon.icon = 'mdi:rectangle', {signal});
        video.addEventListener('leavepictureinpicture', () => pipIcon.icon = 'mdi:picture-in-picture-bottom-right', {signal});

        ui.addEventListener('click', ev => {
            const {icon} = ev.target;
            if (icon === 'mdi:play') this.driver.play();
            else if (icon === 'mdi:volume-mute') video.muted = false;
            else if (icon === 'mdi:volume-high') video.muted = true;
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
    }

    requestFullscreen(video) {
        if (video.webkitEnterFullscreen) {
            video.webkitEnterFullscreen();
        } else {
            const card = this.shadowRoot.querySelector('.card');
            if (card.requestFullscreen) card.requestFullscreen();
            else if (video.requestFullscreen) video.requestFullscreen();
        }
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
        const v = this.driver ? this.driver.video : null;
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

customElements.define('webrtc-camera', WebRTCCamera);

window.customCards = window.customCards || [];
window.customCards.push({
    type: 'webrtc-camera',
    name: 'WebRTC Camera',
    description: 'Ephemeral WebRTC Camera',
    preview: false
});