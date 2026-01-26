// Digital PTZ v2.1.0 - Patched for Passive Event Listeners
/**
 * ARCHITECTURE NOTE:
 * This library provides "Digital Pan-Tilt-Zoom" by manipulating CSS Transforms.
 * It does NOT use native camera PTZ commands (ONVIF).
 *
 * It is designed to work with "object-fit: contain" simulation, calculating
 * black bars manually to ensure mouse/touch coordinates map precisely to video pixels.
 */

const ONE_FINGER_ZOOM_SPEED = 1 / 200; // Sensitivity: 1x scale change per 200px drag
const DBL_CLICK_MS = 400;              // Max delay between clicks to count as double-click
const MAX_ZOOM = 10;                   // Hard limit to prevent pixelation/memory issues

const DEFAULT_OPTIONS = {
  touch_drag_pan: true,
  touch_tap_drag_zoom: true,
  mouse_drag_pan: true,
  mouse_wheel_zoom: true,
  mouse_double_click_zoom: true,
  touch_pinch_zoom: true,
  persist_key: "",     // Key for localStorage to save zoom state
  persist: true,       // If true, restores zoom level on page reload
};

export class DigitalPTZ {
  constructor(containerEl, transformEl, videoEl, options) {
    // Track active event listeners to clean them up later
    this.offHandles = [];
    
    // Called whenever the video or container resizes.
    // It recalculates the "Safe Area" (actual video content excluding black bars).
    this.recomputeRects = () => {
      this.transform.updateRects(this.videoEl, this.containerEl);
      this.transform.zoomAtCoords(1, 0, 0); // Clamp transform to new bounds
      this.render();
    };

    // Applies the calculated X/Y/Scale to the CSS transform property.
    this.render = (transition = false) => {
      if (transition) {
        // Used for smooth animations (e.g., double-click zoom)
        this.transformEl.style.transition = "transform 200ms";
        setTimeout(() => {
          this.transformEl.style.transition = "";
        }, 200);
      }
      this.transformEl.style.transform = this.transform.render();
    };

    this.containerEl = containerEl;
    this.transformEl = transformEl;
    this.videoEl = videoEl;
    this.options = Object.assign({}, DEFAULT_OPTIONS, options);

    // Initialize the state manager (x, y, scale)
    this.transform = new Transform({
      persist_key: this.options.persist_key,
      persist: this.options.persist,
    });

    // Dependency Injection for gesture handlers
    const o = this.options;
    const gestureParam = {
      containerEl: this.containerEl,
      transform: this.transform,
      render: this.render,
    };
    const h = this.offHandles;

    // Register requested gesture handlers
    if (o.mouse_drag_pan) h.push(startMouseDragPan(gestureParam));
    if (o.mouse_wheel_zoom) h.push(startMouseWheel(gestureParam));
    if (o.mouse_double_click_zoom) h.push(startDoubleClickZoom(gestureParam));
    if (o.touch_tap_drag_zoom) h.push(startTouchTapDragZoom(gestureParam));
    if (o.touch_drag_pan) h.push(startTouchDragPan(gestureParam));
    if (o.touch_pinch_zoom) h.push(startTouchPinchZoom(gestureParam));

    // React to video metadata (aspect ratio) and data loading
    this.videoEl.addEventListener("loadedmetadata", this.recomputeRects);
    this.videoEl.addEventListener("loadeddata", this.recomputeRects);
    
    // React to container resizing (e.g., resizing the dashboard card)
    this.resizeObserver = new ResizeObserver(this.recomputeRects);
    this.resizeObserver.observe(this.containerEl);
    
    // Initial calculation
    this.recomputeRects();
  }

  // Cleanup: Remove all listeners to prevent memory leaks
  destroy() {
    for (const off of this.offHandles) off();
    this.videoEl.removeEventListener("loadedmetadata", this.recomputeRects);
    this.videoEl.removeEventListener("loadeddata", this.recomputeRects);
    this.resizeObserver.unobserve(this.containerEl);
  }
}

/* Gestures Implementation */

/**
 * UTILITY: Prevent Page Scroll
 * This is CRITICAL. When zooming the video, we must stop the browser
 * from scrolling the entire page.
 * * Note: This only works if the event listener is attached with { passive: false }.
 */
const preventScroll = (e) => {
  if (e.cancelable) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
  }
};

// Calculate midpoint between two fingers
const getCenter = (touches) => ({
  x: (touches[0].pageX + touches[1].pageX) / 2,
  y: (touches[0].pageY + touches[1].pageY) / 2,
});

// Calculate distance between two fingers
const getSpread = (touches) =>
  Math.hypot(
    touches[0].pageX - touches[1].pageX,
    touches[0].pageY - touches[1].pageY
  );

/**
 * GESTURE: Pinch to Zoom (Two fingers)
 */
function startTouchPinchZoom({ containerEl, transform, render }) {
  const onTouchStart = (downEvent) => {
    const relevant = downEvent.touches.length === 2;
    if (!relevant) return;
    
    let lastTouches = downEvent.touches;
    
    const onTouchMove = (moveEvent) => {
      const newTouches = moveEvent.touches;
      
      // Calculate movement (Pan) based on the center of the pinch
      const oldCenter = getCenter(lastTouches);
      const newCenter = getCenter(newTouches);
      const dx = newCenter.x - oldCenter.x;
      const dy = newCenter.y - oldCenter.y;
      transform.move(dx, dy);
      
      // Calculate scaling (Zoom) based on finger spread
      const oldSpread = getSpread(lastTouches);
      const newSpread = getSpread(newTouches);
      const zoom = newSpread / oldSpread;
      
      // Apply zoom focused on the center point
      transform.zoomAtCoords(zoom, newCenter.x, newCenter.y);
      
      lastTouches = moveEvent.touches;
      render();
      preventScroll(moveEvent);
    };
    
    const onTouchEnd = () =>
      containerEl.removeEventListener("touchmove", onTouchMove);
    
    // FIX NOTE: We use { passive: false } explicitly.
    // Chrome will complain with a [Violation] warning in the console.
    // This is EXPECTED and NECESSARY to allow preventScroll() to work.
    containerEl.addEventListener("touchmove", onTouchMove, { passive: false });
    containerEl.addEventListener("touchend", onTouchEnd, { once: true });
  };
  
  // FIX NOTE: { passive: false } required here too.
  containerEl.addEventListener("touchstart", onTouchStart, { passive: false });
  return () => containerEl.removeEventListener("touchstart", onTouchStart);
}

const getDist = (t1, t2) =>
  Math.hypot(
    t1.touches[0].pageX - t2.touches[0].pageX,
    t1.touches[0].pageY - t2.touches[0].pageY
  );

/**
 * GESTURE: Tap + Drag (One finger zoom)
 * Interaction: Tap once, lift, then tap again and hold/drag up or down to zoom.
 * Common in map applications (Google Maps).
 */
function startTouchTapDragZoom({ containerEl, transform, render }) {
  let lastEvent;
  let fastClicks = 0;
  
  const onTouchStart = (downEvent) => {
    // Detect double-tap timing
    const isFastClick =
      lastEvent && downEvent.timeStamp - lastEvent.timeStamp < DBL_CLICK_MS;
    if (!isFastClick) fastClicks = 0;
    fastClicks++;
    
    // Reset if more than 1 finger
    if (downEvent.touches.length > 1) fastClicks = 0;
    lastEvent = downEvent;
  };
  
  const onTouchMove = (moveEvent) => {
    if (fastClicks === 2) {
      // We are in the "Drag" phase of "Tap-Tap-Drag"
      const lastY = lastEvent.touches[0].pageY;
      const currY = moveEvent.touches[0].pageY;
      
      // Dragging down zooms out, up zooms in
      transform.zoom(1 - (lastY - currY) * ONE_FINGER_ZOOM_SPEED);
      lastEvent = moveEvent;
      render();
      preventScroll(moveEvent);
    } else if (getDist(lastEvent, moveEvent) > 10) {
      // If moved too much between taps, it's not a tap, it's a pan
      fastClicks = 0;
    }
  };
  
  // FIX: Passive: false required to block scroll during zoom drag
  containerEl.addEventListener("touchmove", onTouchMove, { passive: false });
  containerEl.addEventListener("touchstart", onTouchStart, { passive: false });
  return () => {
    containerEl.removeEventListener("touchmove", onTouchMove);
    containerEl.removeEventListener("touchstart", onTouchStart);
  };
}

/**
 * GESTURE: Mouse Wheel Zoom
 */
function startMouseWheel({ containerEl, transform, render }) {
  const onWheel = (e) => {
    const zoom = 1 - e.deltaY / 1000;
    transform.zoomAtCoords(zoom, e.pageX, e.pageY);
    render();
    preventScroll(e);
  };
  
  // FIX: Passive: false required to block page scroll while wheeling over video
  containerEl.addEventListener("wheel", onWheel, { passive: false });
  return () => containerEl.removeEventListener("wheel", onWheel);
}

/**
 * GESTURE: Double Click Zoom
 * Handles "Zoom In" on double click, and "Reset" if already zoomed.
 */
function startDoubleClickZoom({ containerEl, transform, render }) {
  let lastDown = 0;
  let clicks = 0;
  
  const onDown = (downEvent) => {
    const isFastClick = downEvent.timeStamp - lastDown < DBL_CLICK_MS;
    lastDown = downEvent.timeStamp;
    if (!isFastClick) clicks = 0;
    clicks++;
    if (clicks !== 2) return;
    
    const onUp = (upEvent) => {
      const isQuickRelease = upEvent.timeStamp - lastDown < DBL_CLICK_MS;
      // Ensure mouse didn't move too much (drag)
      const dist = Math.hypot(
        upEvent.pageX - downEvent.pageX,
        upEvent.pageY - downEvent.pageY
      );
      if (!isQuickRelease || dist > 20) return;
      
      // Toggle Zoom: 2x or Reset
      const zoom = transform.scale == 1 ? 2 : 0.01;
      transform.zoomAtCoords(zoom, upEvent.pageX, upEvent.pageY);
      render(true); // Pass true to enable CSS transition smoothing
    };
    window.addEventListener("mouseup", onUp, { once: true });
  };
  containerEl.addEventListener("mousedown", onDown);
  return () => containerEl.removeEventListener("mousedown", onDown);
}

/**
 * GESTURE: Generic Pan (Mouse or Touch)
 * Unified handler for dragging the image around.
 */
function startGesturePan({ containerEl, transform, render }, type) {
  const [downName, moveName, upName] =
    type === "mouse"
      ? ["mousedown", "mousemove", "mouseup"]
      : ["touchstart", "touchmove", "touchend"];
  
  const isTouchEvent = (ev) => window.TouchEvent && ev instanceof TouchEvent;

  const onDown = (downEvt) => {
    let last = isTouchEvent(downEvt) ? downEvt.touches[0] : downEvt;
    
    const onMove = (moveEvt) => {
      // Multi-touch is handled by pinch zoom, ignore here
      if (isTouchEvent(moveEvt) && moveEvt.touches.length !== 1) return;
      
      const curr = isTouchEvent(moveEvt) ? moveEvt.touches[0] : moveEvt;
      transform.move(curr.pageX - last.pageX, curr.pageY - last.pageY);
      last = curr;
      render();
      
      // Block scroll only if we are actually panned/zoomed in
      if (transform.scale !== 1) preventScroll(moveEvt);
    };
    
    // FIX: Passive: false required for touch moves
    const options = isTouchEvent(downEvt) ? { passive: false } : undefined;
    containerEl.addEventListener(moveName, onMove, options);
    
    const onUp = () => containerEl.removeEventListener(moveName, onMove);
    window.addEventListener(upName, onUp, { once: true });
  };
  
  // FIX: Passive: false required for touch start
  const options = type === 'touch' ? { passive: false } : undefined;
  containerEl.addEventListener(downName, onDown, options);
  return () => containerEl.removeEventListener(downName, onDown);
}

function startTouchDragPan(params) {
  return startGesturePan(params, "touch");
}
function startMouseDragPan(params) {
  return startGesturePan(params, "mouse");
}

/** * TRANSFORM CLASS
 * Manages the State (X, Y, Scale) and geometry calculations.
 */
const PERSIST_KEY_PREFIX = "webrtc-digital-ptc:";
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Helper: Calculate actual video dimensions in DOM pixels, accounting for CSS transforms
function getTransformedDimensions(video) {
  const { videoWidth, videoHeight } = video;
  if (!videoHeight || !videoWidth) return undefined;
  var transform = window.getComputedStyle(video).getPropertyValue("transform");
  const match = transform.match(/matrix\((.+)\)/);
  if (!match || !match[1]) return { videoWidth, videoHeight }; // the video isn't transformed
  
  // Apply matrix to corner points to get bounding box
  const matrix = new DOMMatrix(match[1].split(", ").map(Number));
  const points = [
    new DOMPoint(0, 0),
    new DOMPoint(videoWidth, 0),
    new DOMPoint(0, videoHeight),
    new DOMPoint(videoWidth, videoHeight),
  ].map((point) => point.matrixTransform(matrix));
  
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  return { videoWidth: maxX - minX, videoHeight: maxY - minY };
}

class Transform {
  constructor(settings) {
    this.scale = 1;
    this.x = 0;
    this.y = 0;
    
    // Load state from LocalStorage (Persistence)
    this.loadPersistedTransform = () => {
      const { persist_key, persist } = this.settings;
      if (!persist) return;
      try {
        const loaded = JSON.parse(localStorage[persist_key]);
        const isValid = [loaded.scale, loaded.x, loaded.y].every(
          Number.isFinite
        );
        if (!isValid) {
          throw new Error("Broken local storage");
        }
        this.x = loaded.x;
        this.y = loaded.y;
        this.scale = loaded.scale;
      } catch (e) {
        delete localStorage[persist_key];
      }
    };
    
    // Save state to LocalStorage
    this.persistTransform = () => {
      const { persist_key, persist } = this.settings;
      if (!persist) return;
      const { x, y, scale } = this;
      localStorage[persist_key] = JSON.stringify({
        x,
        y,
        scale,
      });
    };
    
    this.settings = Object.assign(Object.assign({}, settings), {
      persist_key: PERSIST_KEY_PREFIX + settings.persist_key,
    });
    this.loadPersistedTransform();
  }

  // GEOMETRY ENGINE
  // Calculates where the video is relative to the container.
  // This handles the "black bars" logic of object-fit: contain.
  updateRects(videoEl, containerEl) {
    const containerRect = containerEl.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) {
      return;
    }
    this.containerRect = containerRect;
    const transformed = getTransformedDimensions(videoEl);
    if (!transformed) {
      return;
    }
    
    const screenAspectRatio =
      this.containerRect.width / this.containerRect.height;
    const videoAspectRatio = transformed.videoWidth / transformed.videoHeight;
    
    // Determine if black bars are vertical or horizontal
    if (videoAspectRatio > screenAspectRatio) {
      // Black bars on the top and bottom (Letterbox)
      const videoHeight = this.containerRect.width / videoAspectRatio;
      const blackBarHeight = (this.containerRect.height - videoHeight) / 2;
      this.videoRect = new DOMRect(
        this.containerRect.x,
        blackBarHeight + this.containerRect.y,
        this.containerRect.width,
        videoHeight
      );
    } else {
      // Black bars on the sides (Pillarbox)
      const videoWidth = this.containerRect.height * videoAspectRatio;
      const blackBarWidth = (this.containerRect.width - videoWidth) / 2;
      this.videoRect = new DOMRect(
        blackBarWidth + this.containerRect.x,
        this.containerRect.y,
        videoWidth,
        this.containerRect.height
      );
    }
  }

  // Move image (Pan) with Clamping to bounds
  // dx,dy are deltas.
  move(dx, dy) {
    if (!this.videoRect) return;
    const bound = (this.scale - 1) / 2;
    this.x += dx / this.videoRect.width;
    this.y += dy / this.videoRect.height;
    // Keep image within the viewport based on current scale
    this.x = clamp(this.x, -bound, bound);
    this.y = clamp(this.y, -bound, bound);
    this.persistTransform();
  }

  // Zoom focusing on specific screen coordinates
  // x,y are relative to viewport (clientX, clientY)
  zoomAtCoords(zoom, x, y) {
    if (!this.containerRect || !this.videoRect) return;
    const oldScale = this.scale;
    this.scale *= zoom;
    this.scale = clamp(this.scale, 1, MAX_ZOOM);
    zoom = this.scale / oldScale;
    
    // Convert screen coords to container offsets
    x = x - this.containerRect.x - this.containerRect.width / 2;
    y = y - this.containerRect.y - this.containerRect.height / 2;
    
    // Adjust Pan to keep the zoomed point stable
    const dx = x - this.x * this.videoRect.width;
    const dy = y - this.y * this.videoRect.height;
    this.move(dx * (1 - zoom), dy * (1 - zoom));
  }

  // Simple center zoom
  zoom(zoom) {
    if (!this.containerRect || !this.videoRect) return;
    const x = this.containerRect.width / 2;
    const y = this.containerRect.height / 2;
    this.zoomAtCoords(zoom, x, y);
  }

  // Output CSS string
  render() {
    if (!this.videoRect) return "";
    const { x, y, scale } = this;
    return `translate(${x * this.videoRect.width}px, ${
      y * this.videoRect.height
    }px) scale(${scale})`;
  }
}