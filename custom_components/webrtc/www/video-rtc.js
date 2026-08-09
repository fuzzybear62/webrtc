/**
 * VideoRTC v2.3.0 - Resilience & cleanup
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
        this.FIRSTFRAME_TIMEOUT = 600000;
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
        // still-warm MSE instantly; AFTER commit it reconnects. Short enough to self-heal
        // fast, long enough to ride a brief congestion pause. Tunable.
        this.RTC_LIVENESS_TIMEOUT = 8000;
        // [LEGACY / SHADOW ONLY] How much ACTUALLY-flowing decode WebRTC must show before
        // the one-shot irreversible handoff (switch visible element + close MSE). Used by
        // the non-reversible branch (shadow probes), where the card swaps whole drivers.
        this.RTC_PROVE_MS = 15000;

        // [REVERSIBLE HANDOFF, v2.3.0] The main (parallel) driver keeps its MSE stream
        // ATTACHED and warm on this.video and shows WebRTC on a second, overlaid <video>.
        // Promotion (revealing the overlay) is therefore reversible: a post-promote stall
        // snaps back to MSE in one frame with no reconnect and no black. Only after RTC has
        // proven itself stable for RTC_COMMIT_MS do we "commit" — collapse the overlay onto
        // this.video (which detaches/closes the now-unneeded MSE) and close the signalling
        // ws to free bandwidth. The card enables this per-driver via `reversible` so the
        // delicate shadow-swap path stays on the legacy branch, byte-for-byte unchanged.
        this.reversible = false;   // set true by the card for the main parallel driver
        this._rtcVideo = null;     // overlaid <video> carrying the RTC MediaStream
        this._committed = false;   // true once MSE was released (fully on RTC)
        this._commitTID = 0;       // stability timer: promote -> commit
        this._mseWanted = false;   // desired mute state of the MSE element, restored on revert/commit
        // Flowing decode required before we REVEAL RTC (make it visible). Small because
        // the overlay is rendered (full-rate decode) and promotion is reversible, so we can
        // be aggressive and restore near-instant RTC on good paths. Tunable.
        this.RTC_PROMOTE_MS = 2000;
        // Continued liveness required AFTER promotion before we commit (release MSE). Long
        // enough to filter the burst-then-stall paths (measured to die within ~15s of a
        // premature promote) while bounding the dual-bandwidth (MSE+RTC) window. Tunable.
        this.RTC_COMMIT_MS = 30000;

        this._promoted = false;    // true once the RTC overlay is revealed (reversible flow)
        this._lastLiveness = 0;    // Date.now() of the last framesDecoded advance

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

        // Standard WebRTC Configuration (Google STUN)
        this.pcConfig = {
            bundlePolicy: 'max-bundle',
            iceServers: [{urls: 'stun:stun.l.google.com:19302'}],
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
            
            // If play failed (likely due to Audio Policy), mute and try again.
            if (!this.video.muted) {
                this.video.muted = true;
                this.video.play().catch(e => console.warn(`[VideoRTC:${this.clientId}] Autoplay warn:`, e));
            }
        });
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

        this.ws = new WebSocket(this.wsURL);
        this.ws.binaryType = 'arraybuffer';
        
        this.ws.addEventListener('open', () => this.onopen());
        this.ws.addEventListener('close', () => this.onclose());
        
        // Error Handling Logic
        this.ws.addEventListener('error', (e) => {
            if (this.strictMode) {
                // STRICT: Fail fast on any error
                console.warn(`[VideoRTC:${this.clientId}] WebSocket Error (Strict): Force Closing`, e);
                this.onclose(); 
            } else {
                // RELAXED: Log but keep trying (allows recovery from minor glitches)
                console.warn(`[VideoRTC:${this.clientId}] WebSocket Error (Relaxed): Ignored`, e);
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
        this.reconnectTID = setTimeout(() => {
            this.reconnectTID = 0;
            console.warn(`[VideoRTC:${this.clientId}] No-data watchdog fired (${this.DISCONNECT_TIMEOUT}ms silent). Forcing close.`);
            this.handoff = false; // a stall is a failure, not an intentional handover
            this.onclose();
        }, this.DISCONNECT_TIMEOUT);
    }

    _clearWatchdog() {
        if (this.reconnectTID) {
            clearTimeout(this.reconnectTID);
            this.reconnectTID = 0;
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
            this.video.src = '';
            this.video.srcObject = null;
        }
    }

    /**
     * Called when WebSocket opens. Sets up message routing.
     */
    onopen() {
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
        // Notify parent that connection died (triggers restart)
        this.dispatchEvent(new CustomEvent('connection-closed', {
            detail: { url: this.wsURL }
        }));
        return true;
    }

    /**
     * Logic for Media Source Extensions (Low Latency Video over WS)
     */
    onmse() {
        console.info(`[VideoRTC:${this.clientId}] Mode: MSE`);
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
                        // Sync video time if it fell behind
                        if (this.video.currentTime < start) {
                            this.video.currentTime = start;
                        }
                        // Catch up logic (increase playback speed)
                        const gap = end - this.video.currentTime;
                        this.video.playbackRate = gap > 0.1 ? gap : 0.1;
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
            if (this.reversible && this._rtcVideo && !this._committed) {
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
                console.warn(`[VideoRTC:${this.clientId}] WebRTC ${why}; keeping active MSE stream.`);
                pc.close();
                this.pc = null;
                if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                    this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_failed' });
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
            console.info(`[VideoRTC:${this.clientId}] pc ${pc.connectionState} (ice=${pc.iceConnectionState}) @${Date.now() - pcStart}ms`);

            if (pc.connectionState === 'connected') {
                // Arm the first-frame detection + watchdog exactly once per pc. (In
                // practice 'connected' fires once before any reap, but guard anyway so a
                // transient connected->connecting->connected can't leak a 2nd poll/timer.)
                if (this._firstFrameTID || this._firstFramePoll) return;

                // [REVERSIBLE HANDOFF] Main parallel driver: keep MSE warm, show RTC on an
                // overlay, promote fast, commit only once RTC proves durably stable.
                if (this.reversible) {
                    this._startReversibleRTC(pc, pcStart, failWebRTC);
                    return;
                }

                // ---- LEGACY / SHADOW: one-shot irreversible prove-before-commit ----
                const tracks = pc.getTransceivers()
                    .filter(tr => tr.currentDirection === 'recvonly')
                    .map(tr => tr.receiver.track);
                const video2 = document.createElement('video');
                video2.muted = true;        // allow the offscreen probe to decode/play
                video2.playsInline = true;
                video2.srcObject = new MediaStream(tracks);
                video2.play().catch(() => {});

                this._promoted = false;
                let lastDecoded = -1;   // framesDecoded on the previous poll (-1 = none yet)
                let flowingMs = 0;      // accumulated wall-time of ACTUALLY-advancing decode

                // [PROVE BEFORE COMMIT] Keep the visible element on MSE until WebRTC has
                // proven it can deliver video CONTINUOUSLY. The handoff closes the MSE ws
                // and is irreversible without a full reconnect, so on congested repeater
                // paths a stream that decodes a short burst then stalls must NOT trigger it:
                // doing so froze the picture black, or thrashed a reconnect loop that tore
                // down the working MSE every ~15s (and, going through connection-closed
                // rather than rtc_failed, never armed the reprobe/shadow). We accumulate
                // only polls where framesDecoded actually advanced; a burst-then-stall path
                // never reaches RTC_PROVE_MS, so MSE is never interrupted and the 600s
                // watchdog eventually gives up with rtc_failed (-> reprobe/shadow). The
                // offscreen probe (video2) keeps the decoder pulling frames meanwhile.
                const commitHandoff = () => {
                    if (this._firstFrameTID) { clearTimeout(this._firstFrameTID); this._firstFrameTID = 0; }
                    console.info(`[VideoRTC:${this.clientId}] RTC proven (${flowingMs}ms flowing) @${Date.now() - pcStart}ms — handing off`);
                    this._promoted = true;
                    this._lastLiveness = Date.now();
                    this.onpcvideo(video2);
                    // NB: _firstFramePoll is intentionally NOT cleared — it converts into
                    // the post-handoff liveness watchdog below.
                };
                this._firstFramePoll = setInterval(() => {
                    if (!this.pc) { clearInterval(this._firstFramePoll); this._firstFramePoll = 0; return; }
                    this.pc.getStats().then(stats => {
                        let fd = -1;
                        for (const r of stats.values()) {
                            if (r.type === 'inbound-rtp' && r.kind === 'video') { fd = r.framesDecoded || 0; break; }
                        }
                        if (fd < 0) return;   // no inbound video report yet
                        const advanced = lastDecoded >= 0 && fd > lastDecoded;
                        lastDecoded = fd;

                        if (!this._promoted) {
                            // PROVING (visible element still on MSE): only real progress
                            // counts, so a burst-then-stall never crosses the threshold.
                            if (advanced) {
                                flowingMs += 500;
                                if (flowingMs >= this.RTC_PROVE_MS) commitHandoff();
                            }
                        } else if (advanced) {
                            // POST-HANDOFF: frames still advancing -> stream is alive.
                            this._lastLiveness = Date.now();
                        } else if (Date.now() - this._lastLiveness > this.RTC_LIVENESS_TIMEOUT) {
                            // POST-HANDOFF STALL: a proven stream later died. The pc is still
                            // 'connected' (ICE/DTLS fine) so no state change fires and nothing
                            // else catches it — the picture would stay black forever with MSE
                            // already gone. Recover via failWebRTC's no-MSE branch:
                            // handoff=false -> onclose() -> 'connection-closed' -> the card
                            // reconnects (MSE back) and re-probes WebRTC afresh.
                            failWebRTC(`RTC media stalled ${this.RTC_LIVENESS_TIMEOUT}ms after handoff`);
                        }
                    }).catch(() => {});
                }, 500);

                // [FIRST-FRAME WATCHDOG] Arm the media-arrival deadline. If no sustained
                // video ever decodes (ICE connected but RTP media never flows), reap the pc
                // and signal rtc_failed so the card retries with a fresh ICE gather. MSE
                // keeps serving the picture untouched during this whole window.
                this._firstFrameTID = setTimeout(() => {
                    this._firstFrameTID = 0;
                    failWebRTC(`connected but decoded no sustained video within ${this.FIRSTFRAME_TIMEOUT}ms`);
                }, this.FIRSTFRAME_TIMEOUT);
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

        this._promoted = false;
        this._committed = false;
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
                console.info(`[VideoRTC:${this.clientId}] RTC Rejected (Priority < MSE) — staying on MSE`);
                this._clearRtcTimers();
                this._dropRtcOverlay();
                this.video.muted = this._mseWanted;
                if (this.pc) { this.pc.close(); this.pc = null; }
                if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                    this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_rejected' });
                }
                return;
            }

            console.info(`[VideoRTC:${this.clientId}] RTC promoted (${flowingMs}ms flowing) @${Date.now() - pcStart}ms — MSE kept warm`);
            this._promoted = true;
            this._lastLiveness = Date.now();
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
            // Arm the commit deadline.
            this._commitTID = setTimeout(commit, this.RTC_COMMIT_MS);
        };

        // Release MSE: RTC has been stable long enough to trust.
        const commit = () => {
            this._commitTID = 0;
            if (!this.pc || !this._promoted || !this._rtcVideo) return;
            console.info(`[VideoRTC:${this.clientId}] RTC stable ${this.RTC_COMMIT_MS}ms @${Date.now() - pcStart}ms — committing (releasing MSE)`);
            this._committed = true;
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
            this.pc.getStats().then(stats => {
                let fd = -1;
                for (const r of stats.values()) {
                    if (r.type === 'inbound-rtp' && r.kind === 'video') { fd = r.framesDecoded || 0; break; }
                }
                if (fd < 0) return;
                const advanced = lastDecoded >= 0 && fd > lastDecoded;
                lastDecoded = fd;

                if (!this._promoted) {
                    if (advanced) {
                        flowingMs += 500;
                        if (flowingMs >= this.RTC_PROMOTE_MS) promote();
                    }
                } else if (advanced) {
                    this._lastLiveness = Date.now();
                } else if (Date.now() - this._lastLiveness > this.RTC_LIVENESS_TIMEOUT) {
                    if (!this._committed) {
                        // Pre-commit: MSE is warm — snap back instantly, no reconnect.
                        this._revertToWarmMSE(`RTC stalled ${this.RTC_LIVENESS_TIMEOUT}ms before commit`);
                    } else {
                        // Post-commit: MSE already released — the no-MSE branch reconnects.
                        failWebRTC(`RTC media stalled ${this.RTC_LIVENESS_TIMEOUT}ms after commit`);
                    }
                }
            }).catch(() => {});
        }, 500);

        // Give-up deadline: if RTC never sustains decode at all, reap and signal rtc_failed
        // (MSE keeps serving untouched throughout).
        this._firstFrameTID = setTimeout(() => {
            this._firstFrameTID = 0;
            this._revertToWarmMSE(`connected but decoded no sustained video within ${this.FIRSTFRAME_TIMEOUT}ms`);
        }, this.FIRSTFRAME_TIMEOUT);
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
        this._clearRtcTimers();
        this._dropRtcOverlay();
        this.video.muted = this._mseWanted;
        if (this.pc) { this.pc.close(); this.pc = null; }
        this._promoted = false;
        this._committed = false;
        if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
            this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_failed' });
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
     * Decides whether to switch from MSE to WebRTC.
     * Prioritizes Codec quality (H265 > H264) and audio presence.
     */
    onpcvideo(video2) {
        // [REVERSIBLE HANDOFF] In the reversible flow the reveal + priority decision are
        // handled by _startReversibleRTC, and the ws must stay open until commit(). This
        // method is still invoked (so the card's onpcvideo wrapper runs its UI update) but
        // must NOT touch the socket or srcObject here.
        if (this.reversible) return;

        if (this.pc) {
            let rtcPriority = 0, msePriority = 0;

            const stream = video2.srcObject;
            // Calculate priorities based on Tracks and Codecs
            if (stream.getVideoTracks().length > 0) {
                const isH265Supported = this.pc.remoteDescription.sdp.includes('H265/90000');
                rtcPriority += isH265Supported ? 0x240 : 0x220;
            }
            if (stream.getAudioTracks().length > 0) rtcPriority += 0x102;

            if (this.mseCodecs.includes('hvc1.')) msePriority += 0x230;
            if (this.mseCodecs.includes('avc1.')) msePriority += 0x210;
            if (this.mseCodecs.includes('mp4a.')) msePriority += 0x101;

            if (rtcPriority >= msePriority) {
                // SWITCH TO WEBRTC
                console.info(`[VideoRTC:${this.clientId}] Mode: RTC (Socket Closing)`);
                this.video.srcObject = stream;
                this.play();

                if (this.ws) {
                    // SET HANDOFF FLAG: Close WS without triggering restart
                    this.handoff = true; 
                    this.ws.close();
                    this.ws = null;
                }
            } else {
                // REJECT WEBRTC
                console.info(`[VideoRTC:${this.clientId}] Mode: RTC Rejected (Priority < MSE)`);
                
                // [OBSERVABILITY] Signal the rejection to the parent component.
                // This informs the parent that WebRTC was negotiated but discarded due to lower quality,
                // allowing it to cancel any pending upgrade timers or spinners.
                if (this.onmessage && typeof this.onmessage['ui_sync'] === 'function') {
                    this.onmessage['ui_sync']({ type: 'signal', value: 'rtc_rejected' });
                }

                if (this.pc) {
                    this.pc.close();
                    this.pc = null;
                }
            }
        }
        video2.srcObject = null;
    }

    /**
     * Logic for MJPEG (Motion JPEG) - Fallback mode
     */
    onmjpeg() {
        console.info(`[VideoRTC:${this.clientId}] Mode: MJPEG`);
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
        console.info(`[VideoRTC:${this.clientId}] Mode: HLS`);
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
        console.info(`[VideoRTC:${this.clientId}] Mode: MP4`);
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