/**
 * WebRTC Camera Card v13.10.17
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
 *   involving <video>, MediaSource, RTCPeerConnection and WebSocket objects.
 * - Previous legacy implementations reused drivers and connections to optimize latency,
 *   but this caused steady and irreversible browser memory growth.
 *
 * This implementation deliberately trades reconnect cost for long-term memory stability.
 * Any attempt to "optimize" by reusing the driver will almost certainly reintroduce leaks.
 */

import {VideoRTC} from './video-rtc.js?v=2.2.7';
import {DigitalPTZ} from './digital-ptz.js?v=3.3.0';

// Ensure the dumb driver is registered exactly once.
// The driver itself contains no UI logic and must remain isolated.
if (!customElements.get('video-rtc')) {
    customElements.define('video-rtc', VideoRTC);
}

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

        // Reconnection state machine.
        // These flags exist to avoid reconnect storms and overlapping drivers.
        this._isReconnecting = false;
        this._retryCount = 0;
        this._retryTimer = null;

        console.info('[WebRTC Camera] v13.10.17');
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
    }

    set hass(hass) {
        this._hass = hass;

        // Start the stream only when:
        // - HA is available
        // - the DOM exists
        // - no driver is currently alive
        // - we are not already reconnecting
        if (this.shadowRoot && !this.driver && !this._isReconnecting) {
            this.startStream();
        }
    }

    get hass() {
        return this._hass;
    }

    disconnectedCallback() {
        // Component removal must fully stop retries and free all resources.
        if (this._retryTimer) clearTimeout(this._retryTimer);
        this._cleanupDriver();
    }

    _cleanupDriver() {
        /**
         * HARD DRIVER TEARDOWN (CRITICAL)
         *
         * WHY THIS IS AGGRESSIVE:
         * - Browsers may keep internal references to video decoders, tracks,
         *   peer connections and event listeners even after DOM removal.
         * - Failing to explicitly break these references causes memory to grow
         *   across reconnects and page changes.
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
        if (this.driver) {
            this.driver.removeEventListener('connection-closed', this._handleConnectionClosed);

            // Forcefully break callback references.
            this.driver.onmessage = () => {};
            this.driver.onpcvideo = () => {};
            this.driver.ondata = () => {};

            // Allow the driver to release its internal resources.
            if (typeof this.driver.ondisconnect === 'function') {
                this.driver.ondisconnect();
            }

            this.driver.remove();
            this.driver = null;
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

        this._isReconnecting = true;

        const delay = Math.min(
            1000 * Math.pow(2, this._retryCount),
            30000
        );

        this._retryTimer = setTimeout(() => {
            this._retryCount++;
            this._isReconnecting = false;
            this.startStream();
        }, delay);
    }

    async startStream() {
        if (!this._hass || !this.config) return;

        // Resolve the effective stream configuration.
        // Stream-specific overrides are merged here only.
        const currentStream = this.config.streams[this.streamID] || {};
        const effectiveConfig = {...this.config, ...currentStream};

        this.setStatus('Loading..');

        // Always destroy any previous driver before creating a new one.
        this._cleanupDriver();

        // Create a fresh driver instance.
        // The driver owns all media/network state.
        this.driver = document.createElement('video-rtc');
        this.driver.mode = effectiveConfig.mode;
        this.driver.media = effectiveConfig.media;
        this.driver.background = effectiveConfig.background;
        this.driver.visibilityThreshold = effectiveConfig.intersection || 0;

        // Network strict mode propagates directly to the driver.
        this.driver.strictMode =
            effectiveConfig.network_strict !== undefined
                ? effectiveConfig.network_strict
                : this.config.network_strict;

        // Any unexpected connection close triggers a controlled retry.
        this._handleConnectionClosed = () => {
            this._scheduleRetry();
        };
        this.driver.addEventListener('connection-closed', this._handleConnectionClosed);

        // Driver-to-UI messaging is intentionally minimal.
        // The driver never touches UI directly.
        this.driver.onmessage = {
            ui_sync: (msg) => {
                switch (msg.type) {
                    case 'error':
                        this.setStatus('Error', msg.value);
                        break;
                    case 'mse':
                    case 'hls':
                    case 'mp4':
                    case 'mjpeg':
                    case 'webrtc':
                        this.setStatus(msg.type.toUpperCase(), this.config.title || '');
                        this._retryCount = 0;
                        break;
                }
            }
        };

        // WebRTC success resets retry logic and updates UI.
        const originalOnPcVideo = this.driver.onpcvideo;
        this.driver.onpcvideo = (video) => {
            if (typeof originalOnPcVideo === 'function') {
                originalOnPcVideo.call(this.driver, video);
            }
            this.setStatus('RTC', this.config.title || '');
            this._retryCount = 0;
            this._applyPoster();
        };

        // Inject driver into DOM.
        // The driver immediately creates its <video> element.
        const container = this.shadowRoot.querySelector('.ptz-transform');
        if (container) container.appendChild(this.driver);

        // Apply global mute synchronously.
        // This avoids autoplay failures caused by async timing.
        if (this.driver.video) {
            this.driver.video.controls = false;

            if (this.config.muted) {
                this.driver.video.muted = true;
                this.driver.video.defaultMuted = true;
                this.driver.video.setAttribute('muted', '');
            }
        }

        // Authenticate and start the connection.
        try {
            const url = await this._fetchWebsocketURL();
            if (this.driver) {
                this.driver.src = url;
                this.setStatus('Loading...');
                this.setupTools();
                this._applyPoster();
            }
        } catch (e) {
            this.setStatus('Auth Fail', 'Retry...');
            this._scheduleRetry();
        }
    }

    _applyPoster() {
        // Poster application is intentionally deferred and optional.
        // It must never block stream startup.
        if (this.config.poster &&
            !this.config.poster_remote &&
            this.driver &&
            this.driver.video) {
            // Placeholder for future extension.
        }
    }

    async _fetchWebsocketURL() {
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

        if (this.config.poster &&
            !this.config.poster_remote &&
            this.driver &&
            this.driver.video) {
            this.driver.video.poster =
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

        return wsUrl;
    }

    nextStream() {
        // Stream switching is implemented as a full restart
        // to guarantee a clean media state.
        this.streamID = (this.streamID + 1) % this.config.streams.length;
        this._retryCount = 0;
        if (this._retryTimer) clearTimeout(this._retryTimer);
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
            .mode { cursor: pointer; opacity: 0.6; pointer-events: auto; }
            video-rtc { width: 100%; height: 100%; display: block; }
            ha-icon { color: white; cursor: pointer; }
        </style>
        <ha-card class="card">
            <div class="player">
                <div class="ptz-transform"></div>
            </div>
            <div class="header">
                <div class="status"></div>
                <div class="mode"></div>
            </div>
        </ha-card>
        `;

        // Stream switching is user-initiated and explicit.
        this.shadowRoot
            .querySelector('.mode')
            .addEventListener('click', () => this.nextStream());
    }

    setStatus(mode, status) {
        const divMode = this.shadowRoot.querySelector('.mode');
        const divStatus = this.shadowRoot.querySelector('.status');
        if (divMode) divMode.innerText = mode;
        if (divStatus) divStatus.innerText = status || '';
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

                if (this.config.digital_ptz !== false) {
                    new DigitalPTZ(
                        this.shadowRoot.querySelector('.player'),
                        this.shadowRoot.querySelector('.ptz-transform'),
                        this.driver.video,
                        Object.assign({}, this.config.digital_ptz, {
                            persist_key: this.config.url
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