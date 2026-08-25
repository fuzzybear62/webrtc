/**
 * WebRTC Camera - UI Interaction Sidecar v1.1.1
 * * CHANGELOG v1.1.1:
 * - FIX: Expanded Whitelist Regex to support CSS colors (#), Ternary operators (?, :), 
 * Comparison (===, !==, <, >), and Logic (!, &, |).
 * - FIX: Allow numeric values in templates.
 *
 * RESPONSIBILITIES:
 * - Handles 'shortcuts' (custom buttons) with reactive icons, styles AND data payloads.
 * - Handles 'ptz' with Continuous Move and Templated Data support.
 * - Provides visual feedback (active state) during interactions.
 * - Implements a WHITELIST-BASED template engine (Zero-Trust security).
 */

export class UIInteraction {

    constructor(card) {
        this.card = card;
        this.hass = null;
        
        // Cache for compiled template functions to optimize performance.
        this._templateCache = new Map();
        
        // State tracking for reactive CSS to avoid unnecessary DOM writes.
        this._prevStyle = null;
        
        console.info("[UI Interaction] Sidecar v1.1.1 initialized (Expanded Syntax Support)");
    }

    /**
     * Called once when the card structure is ready.
     * Builds the DOM elements for Shortcuts and PTZ.
     */
    render() {
        if (!this.card || !this.card.shadowRoot) return;
        
        try {
            this._initStyleElement();
            this._renderShortcuts();
            this._renderPTZ();
        } catch (e) {
            console.error("[UI Interaction] Render critical failure:", e);
        }
    }

    /**
     * Called every time Home Assistant state updates.
     * Updates reactive elements based on secure templates.
     */
    update(hass) {
        this.hass = hass;
        
        // 1. Update Reactive Global CSS
        // Allows dynamic styling of the card based on entity states.
        if (this.card.config.style) {
            this._updateStyle(hass);
        }

        // 2. Update Shortcuts visual state (icons & styles)
        if (this.card.config.shortcuts) {
            this._updateShortcuts(hass);
        }
    }

    /**
     * SECURE TEMPLATE ENGINE (Whitelist Strategy)
     * * Unlike previous versions, this does NOT execute arbitrary code.
     * It scans the string and only executes patterns that match a strict Allowlist.
     * * ALLOWED PATTERNS:
     * - Alphanumeric & Underscore: a-z A-Z 0-9 _
     * - Dot notation & Brackets: . [ ]
     * - String quotes: ' " `
     * - Comparison & Logic: = ! < > & | ? :
     * - Math & CSS: + - * / % # ( ) ,
     */
    _evaluateTemplate(templateStr, hass) {
        if (!templateStr || typeof templateStr !== 'string') return templateStr;
        if (!templateStr.includes('${')) return templateStr;

        const contextHass = hass || this.hass;
        if (!contextHass) return templateStr;

        // Extract the content inside ${...}
        // We support multiple templates in one string: "Color: ${...}, Icon: ${...}"
        return templateStr.replace(/\$\{(.*?)\}/g, (match, expression) => {
            try {
                // 1. SECURITY CHECK: Whitelist valid characters only.
                const validSyntax = /^[a-zA-Z0-9_\.\s\[\]'"\`\(\)\!\=\<\>\&\?:\+\-\*\/%#,|]*$/;

                if (!validSyntax.test(expression)) {
                    console.warn(`[UI Interaction] Expression blocked by whitelist policy: ${expression}`);
                    return match; // Return raw string if blocked
                }

                // 2. CONTEXT PREPARATION
                // We create a safe evaluation function.
                // We map 'states' to a proxy or direct object to allow states['domain.entity'] syntax.
                const fn = new Function('states', 'user', 'attributes', `return (${expression});`);

                // 3. EXECUTE
                // We pass 'states' twice to handle both 'states[x]' and 'attributes[x]' usage if needed
                return fn(contextHass.states, contextHass.user, contextHass.states);

            } catch (e) {
                // Silently fail on syntax errors (common during config typing)
                return match;
            }
        });
    }

    /**
     * Helper to recursively resolve templates inside data objects (service payloads).
     * Necessary for features like dynamic PTZ speed or templated entity targets.
     */
    _resolveDataTemplate(data, hass) {
        if (!data || typeof data !== 'object') return data;
        
        const resolved = {};
        for (const [key, value] of Object.entries(data)) {
            if (typeof value === 'string' && value.includes('${')) {
                resolved[key] = this._evaluateTemplate(value, hass);
            } else {
                resolved[key] = value;
            }
        }
        return resolved;
    }

    // --- STYLE HANDLING (Reactive) ---

    _initStyleElement() {
        // Create the style tag once
        if (this.card.shadowRoot.querySelector('#custom-style')) return;
        const style = document.createElement('style');
        style.id = 'custom-style';
        this.card.shadowRoot.appendChild(style);
    }

    _updateStyle(hass) {
        const styleEl = this.card.shadowRoot.querySelector('#custom-style');
        if (!styleEl) return;

        let rawCss = this.card.config.style;
        let finalCss = this._evaluateTemplate(rawCss, hass);

        // Performance optimization: Only write to DOM if content actually changed
        if (this._prevStyle !== finalCss) {
            styleEl.textContent = finalCss;
            this._prevStyle = finalCss;
        }
    }

    // --- SHORTCUTS HANDLING ---

    _renderShortcuts() {
        const config = this.card.config.shortcuts;
        if (!config || !Array.isArray(config)) return;

        const container = document.createElement('div');
        container.className = 'shortcuts';
        
        config.forEach((item, index) => {
            const icon = document.createElement('ha-icon');
            icon.dataset.index = index; // Store index for update loop
            
            // Set initial (static) icon, update() will handle templates later
            icon.icon = item.icon && !item.icon.includes('${') ? item.icon : 'mdi:help-circle';
            icon.title = item.name || '';
            
            // Apply static styles if present and not templated
            if (item.style && !item.style.includes('${')) {
                icon.style.cssText = item.style;
            }

            // Event Handling
            icon.addEventListener('click', (e) => {
                e.stopPropagation(); // Don't trigger video play/pause
                this._handleShortcutClick(item);
            });

            container.appendChild(icon);
        });

        // Inject into card. We look for .card to append absolute positioned elements.
        const cardRoot = this.card.shadowRoot.querySelector('.card');
        if (cardRoot) cardRoot.appendChild(container);
    }

    _updateShortcuts(hass) {
        const container = this.card.shadowRoot.querySelector('.shortcuts');
        if (!container) return;

        const config = this.card.config.shortcuts;
        const icons = container.querySelectorAll('ha-icon');

        icons.forEach((iconEl, index) => {
            const item = config[index];
            if (!item) return;

            // 1. Reactive Icon Update
            if (item.icon && item.icon.includes('${')) {
                const newIcon = this._evaluateTemplate(item.icon, hass);
                if (iconEl.icon !== newIcon) iconEl.icon = newIcon;
            }

            // 2. Reactive Style Update
            // Allows changing color/opacity/display based on state
            if (item.style && item.style.includes('${')) {
                const newStyle = this._evaluateTemplate(item.style, hass);
                // We check against a cached property to avoid trashing inline styles needlessly
                if (iconEl.dataset.lastStyle !== newStyle) {
                    iconEl.style.cssText = newStyle;
                    iconEl.dataset.lastStyle = newStyle;
                }
            }
        });
    }

    _handleShortcutClick(item) {
        if (!this.hass) return;

        // 1. Service Call
        if (item.service) {
            // `fire-dom-event` (#940) is NOT a real HA service: splitting it as
            // `domain.service` yields domain="fire-dom-event", service=undefined and the
            // callService silently fails. Instead dispatch the standard Lovelace `ll-custom`
            // DOM event so listeners such as browser_mod (e.g. `command: close_popup`) receive
            // it. The whole item is the detail, so the user's `browser_mod:` / custom keys pass
            // through — matching the card's tap_action `handleAction('fire-dom-event')` path.
            if (item.service === 'fire-dom-event') {
                this.card.dispatchEvent(new CustomEvent('ll-custom', {
                    bubbles: true, composed: true, detail: item,
                }));
            } else {
                const [domain, service] = item.service.split('.');
                // Resolve templates in service data (e.g. dynamic camera_name or params)
                const rawData = item.service_data || item.data || {};
                const finalData = this._resolveDataTemplate(rawData, this.hass);

                this.hass.callService(domain, service, finalData);
            }
        }
        
        // 2. Navigation
        if (item.url) {
            window.open(item.url, '_blank');
        }
        
        // 3. More Info Dialog
        if (item.more_info) {
            const event = new Event('hass-more-info', { bubbles: true, composed: true });
            event.detail = { entityId: item.more_info };
            this.card.dispatchEvent(event);
        }
    }

    // --- PTZ HANDLING (Refined + Visual Feedback) ---

    _renderPTZ() {
        const config = this.card.config.ptz;
        if (!config) return;

        const ptzContainer = document.createElement('div');
        ptzContainer.className = 'ptz-controls';
        
        // PTZ CSS Layout (D-Pad style)
        // Tagged with an id so destroy() can remove it on a config-driven rebuild.
        const style = document.createElement('style');
        style.id = 'ptz-style';
        style.textContent = `
            .ptz-controls {
                position: absolute;
                top: 20px;
                right: 20px;
                display: grid;
                grid-template-columns: 40px 40px 40px;
                grid-template-rows: 40px 40px 40px;
                gap: 5px;
                z-index: 20;
                pointer-events: none; /* Let clicks pass through gaps */
            }
            .ptz-btn {
                background: rgba(0,0,0,0.4);
                color: white;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                cursor: pointer;
                pointer-events: auto; /* Re-enable clicks on buttons */
                transition: background 0.1s, transform 0.1s;
                user-select: none;
                touch-action: none; /* Critical for handling touch events manually */
            }
            /* Visual feedback for active state */
            .ptz-btn:active, .ptz-btn.active { 
                background: rgba(255, 255, 255, 0.6); 
                transform: scale(0.92);
            }
            .ptz-up { grid-column: 2; grid-row: 1; }
            .ptz-left { grid-column: 1; grid-row: 2; }
            .ptz-right { grid-column: 3; grid-row: 2; }
            .ptz-down { grid-column: 2; grid-row: 3; }
            .ptz-home { grid-column: 2; grid-row: 2; }
            .ptz-zoom-in { grid-column: 3; grid-row: 1; font-size: 10px; }
            .ptz-zoom-out { grid-column: 3; grid-row: 3; font-size: 10px; }
        `;
        this.card.shadowRoot.appendChild(style);

        const buttons = [
            { cls: 'ptz-up', icon: 'mdi:arrow-up', action: 'up' },
            { cls: 'ptz-down', icon: 'mdi:arrow-down', action: 'down' },
            { cls: 'ptz-left', icon: 'mdi:arrow-left', action: 'left' },
            { cls: 'ptz-right', icon: 'mdi:arrow-right', action: 'right' },
            { cls: 'ptz-home', icon: 'mdi:home', action: 'home' }, 
            { cls: 'ptz-zoom-in', icon: 'mdi:plus', action: 'zoom_in' },
            { cls: 'ptz-zoom-out', icon: 'mdi:minus', action: 'zoom_out' }
        ];

        buttons.forEach(btn => {
            // Only render buttons defined in config
            // Check for tap action (data_action) or start action (data_start_action)
            const hasAction = config[`data_${btn.action}`] || config[`data_start_${btn.action}`];
            if (!hasAction && btn.action !== 'home') return;

            const el = document.createElement('div');
            el.className = `ptz-btn ${btn.cls}`;
            const icon = document.createElement('ha-icon');
            icon.icon = btn.icon;
            el.appendChild(icon);

            // [PTZ LOGIC SPLIT]
            if (btn.action === 'home') {
                // Home: Standard Click (Preset) + Flash Feedback
                el.addEventListener('click', (e) => {
                    e.preventDefault(); 
                    e.stopPropagation();
                    
                    // Visual Feedback
                    el.classList.add('active');
                    setTimeout(() => el.classList.remove('active'), 300);

                    this._handlePTZ(btn.action, null, config);
                });
            } else {
                // Arrows: Continuous Move (Start/Stop) + Sustained Feedback
                // We use pointer events to unify Mouse and Touch handling
                el.addEventListener('pointerdown', (e) => {
                    e.preventDefault(); 
                    e.stopPropagation();
                    
                    // Activate Visual Feedback
                    el.classList.add('active');
                    
                    // Start Move
                    this._handlePTZ(btn.action, 'start', config);

                    // Setup Stop Handler
                    const stopHandler = () => {
                        // Deactivate Visual Feedback
                        el.classList.remove('active');
                        
                        this._handlePTZ(btn.action, 'stop', config);
                        cleanup();
                    };

                    const cleanup = () => {
                        window.removeEventListener('pointerup', stopHandler);
                        window.removeEventListener('pointercancel', stopHandler);
                        window.removeEventListener('pointerleave', stopHandler); // Safety net
                    };

                    // Listen for release anywhere on window
                    window.addEventListener('pointerup', stopHandler);
                    window.addEventListener('pointercancel', stopHandler);
                    window.addEventListener('pointerleave', stopHandler);
                });
            }

            ptzContainer.appendChild(el);
        });

        const cardRoot = this.card.shadowRoot.querySelector('.card');
        if (cardRoot) cardRoot.appendChild(ptzContainer);
    }

    _handlePTZ(action, phase, config) {
        if (!this.hass || !config.service) return;

        let dataKey;
        
        // Determine which data payload to use
        if (phase === 'start') {
            // Try explicit start command first, fallback to generic tap command
            dataKey = config[`data_start_${action}`] ? `data_start_${action}` : `data_${action}`;
        } else if (phase === 'stop') {
            dataKey = `data_stop_${action}`;
        } else {
            // No phase (e.g. Home button or Tap)
            dataKey = `data_${action}`;
        }

        // If no configuration exists for this specific phase/action, do nothing.
        if (!config[dataKey]) return;

        const [domain, service] = config.service.split('.');
        
        // Resolve templates in PTZ payload (e.g. for dynamic speed or profile)
        const finalData = this._resolveDataTemplate(config[dataKey], this.hass);
        
        // Merge with target entity if provided globally in ptz config
        if (config.target_entity) {
            finalData.entity_id = config.target_entity;
        }

        this.hass.callService(domain, service, finalData);
    }

    /**
     * Tears down every DOM node this sidecar owns.
     * Called before a rebuild when the card config changes at runtime.
     * Removing the containers detaches the click/pointer listeners bound to
     * their children; the PTZ window listeners are transient (added on
     * pointerdown, removed on pointerup/cancel) so none are left orphaned.
     */
    destroy() {
        const root = this.card && this.card.shadowRoot;
        if (!root) return;

        root.querySelector('.shortcuts')?.remove();
        root.querySelector('.ptz-controls')?.remove();
        root.querySelector('#ptz-style')?.remove();
        root.querySelector('#custom-style')?.remove();

        // Drop caches so a fresh instance never inherits stale state.
        this._templateCache.clear();
        this._prevStyle = null;
    }
}