/**
 * VideoRTC v2.2.14 - Resilience & cleanup
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

        // Handle ICE Candidates
        pc.addEventListener('icecandidate', ev => {
            // Ignore UDP candidates if forced to TCP mode
            if (ev.candidate && this.mode.includes('webrtc/tcp') && ev.candidate.protocol === 'udp') return;
            const candidate = ev.candidate ? ev.candidate.toJSON().candidate : '';
            this.send({type: 'webrtc/candidate', value: candidate});
        });

        // Monitor Connection State
        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'connected') {
                // When connected, grab tracks and create a temp video to check stream validity
                const tracks = pc.getTransceivers()
                    .filter(tr => tr.currentDirection === 'recvonly')
                    .map(tr => tr.receiver.track);
                const video2 = document.createElement('video');
                // Wait for data to arrive before deciding to switch
                video2.addEventListener('loadeddata', () => this.onpcvideo(video2), {once: true});
                video2.srcObject = new MediaStream(tracks);
            } else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                // WebRTC died. Two very different situations:
                if (this.ws && this.mseCodecs !== '') {
                    // (a) MSE is still a live fallback: the signaling socket is open and
                    // MSE has negotiated. In parallel webrtc+mse mode a WebRTC ICE failure
                    // must NOT tear the whole thing down - that would kill a working MSE
                    // stream and, on networks where WebRTC can never establish (UDP
                    // blocked, no TURN), reconnect-loop on every ICE timeout. Drop ONLY
                    // WebRTC and let MSE keep playing; a real MSE stall is caught by the
                    // no-data watchdog. Signal the card so it stops chasing the upgrade.
                    console.warn(`[VideoRTC:${this.clientId}] WebRTC failed; keeping active MSE stream.`);
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
                    pc.close();
            }
        };

        this.createOffer(pc).then(offer => {
            this.send({type: 'webrtc/offer', value: offer.sdp});
        });

        this.pc = pc;
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