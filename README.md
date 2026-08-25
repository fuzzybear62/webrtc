# WebRTC Camera

[Home Assistant](https://www.home-assistant.io/) custom component for real-time viewing of almost any
camera stream using [WebRTC](https://en.wikipedia.org/wiki/WebRTC), MSE and other technologies, powered by
the [go2rtc](https://github.com/AlexxIT/go2rtc) streaming server.

> **About this fork**
>
> This is a hardened fork of [AlexxIT/WebRTC](https://github.com/AlexxIT/WebRTC), maintained by
> [@fuzzybear62](https://github.com/fuzzybear62) and validated on a multi-camera fleet running over
> lossy multi-hop Wi-Fi repeater paths and remote tunnels.
>
> The fork keeps 100% of the upstream card/config surface and adds a **seamless, reversible
> MSE→WebRTC upgrade path** plus two diagnostic sensors. Its design rule is simple and absolute:
> **never permanently harm a working stream in order to chase a better one.** A camera that can
> only reach MSE stays on MSE forever, cleanly; a camera that can reach WebRTC is upgraded in the
> background and only ever *switched* once the better stream has proven itself. See
> [What this fork adds](#what-this-fork-adds).

---

<!-- TOC -->
* [What this fork adds](#what-this-fork-adds)
* [go2rtc](#go2rtc)
* [Installation](#installation)
* [Configuration](#configuration)
* [Custom card](#custom-card)
* [Fork card options](#fork-card-options)
* [Diagnostic sensors](#diagnostic-sensors)
* [Templates](#templates)
* [Two-way audio](#two-way-audio)
* [Snapshots to Telegram](#snapshots-to-telegram)
* [Cast or share stream](#cast-or-share-stream)
* [Stream to camera](#stream-to-camera)
* [FAQ](#faq)
* [Debug](#debug)
* [Debug logging (troubleshooting stream loss)](#debug-logging-troubleshooting-stream-loss)
* [Known work cameras](#known-work-cameras)
<!-- TOC -->

## What this fork adds

**First, a bit of background (no code required).** A browser can show a camera in two main ways:

- **MSE** (Media Source Extensions) — video streamed over a normal WebSocket. It is **robust**: it
  works through firewalls, reverse proxies and remote tunnels, and it degrades gracefully. Its downside
  is **higher latency** (typically 1–3 s behind live).
- **WebRTC** — the same peer-to-peer tech used by video calls. It is **low-latency** (sub-second) but
  **fragile**: it needs UDP and a successful "handshake" that flaky Wi-Fi, TURN relays or restrictive
  networks often break.

So the ideal is: *always show something reliable, but quietly upgrade to the fast path whenever the
network actually allows it — and never make the picture worse in the attempt.*

Upstream picks whichever technology connects first, and historically a failed WebRTC attempt could
disturb an already-working MSE picture. On a clean LAN you never notice. On **degraded paths**
(Wi-Fi repeaters, TURN relays, remote tunnels, briefly-blocked UDP) it causes black tiles and flicker.

This fork reworks that upgrade into an explicit, **reversible** process. In plain terms:

- **MSE comes up first and stays on screen.** You get a reliable picture immediately, and the card
  never tears it down just to experiment with something faster.
- **WebRTC is tried invisibly, in the background.** A throwaway second connection (internally called a
  *shadow*) attempts WebRTC off-screen. Your visible MSE picture is never touched while this happens.
- **The switch only happens once WebRTC has proven itself.** The background WebRTC feed must play
  **without a single gap for `rtc_swap_prove_ms`** (default 30 s) before it is allowed to replace the
  visible stream. If it stutters before then, it is silently thrown away — no black frame, no flicker,
  you stay on MSE. On a good network the switch is seamless and you simply get lower latency.
- **It keeps trying, forever, safely.** If a camera only landed on MSE because WebRTC happened to be
  unavailable at that moment (UDP briefly blocked, TURN down, a momentary ICE timeout), a background
  **re-probe loop** retries later with increasing spacing (30 s → 1 min → … → 10 min) and upgrades the
  moment the network recovers — again without ever disturbing the live picture. Turn it off with
  `rtc_reprobe: false`.

**The one rule behind all of it:** never permanently harm a working stream in order to chase a better
one. A camera that can only reach MSE stays on MSE, cleanly, indefinitely.

Everything above is **automatic** — a plain config (`type: custom:webrtc-camera`, `url: …`) gets it all
with no extra options. The knobs in [Fork card options](#fork-card-options) only let you *tune* the
behaviour; you never need them to benefit from it.

Unlike upstream, this fork also **creates two diagnostic sensors** so you can watch, at a glance, how
many cameras are streaming and whether the background upgrade path is working — see
[Diagnostic sensors](#diagnostic-sensors).

## go2rtc

This component uses the [go2rtc](https://github.com/AlexxIT/go2rtc) application as a streaming server:

- lowest possible streaming latency for many supported protocols
- streaming from RTSP, RTMP, HTTP (FLV/MJPEG/JPEG), HomeKit cameras, USB cameras and other sources
- streaming to RTSP, WebRTC, MSE/MP4 or MJPEG
- support popular codec H264/H265, AAC, PCMU/PCMA, OPUS
- on-the-fly transcoding for unsupported codecs via FFmpeg
- autoselect streaming technology based on stream codecs, browser capabilities, network configuration

**Read more in the go2rtc [docs](https://github.com/AlexxIT/go2rtc)!**

You can install go2rtc in several ways:

1. **Basic users** - this component will automatically download and run the latest version of go2rtc,
   you don't need to do anything yourself.
2. **Advanced users** - install the [go2rtc](https://github.com/AlexxIT/go2rtc#go2rtc-home-assistant-add-on)
   or [Frigate 12+](https://docs.frigate.video/) add-on.
3. **Hackers** - install go2rtc as [binary](https://github.com/AlexxIT/go2rtc#go2rtc-binary) or
   [Docker](https://github.com/AlexxIT/go2rtc#go2rtc-docker) on any server in LAN.

You can change the go2rtc settings by adding the `go2rtc.yaml` file to your Hass configuration folder.

**Important.** go2rtc runs its own web interface on port `1984` without a password. There you can see a
list of active camera streams. Anyone on your LAN can **access them without a password**. You can disable
this in the go2rtc config.

## Installation

**Method 1 (HACS custom repository).** HACS > Integrations > ⋮ > Custom repositories > add
`https://github.com/fuzzybear62/webrtc` as an *Integration* > install **WebRTC Camera**.

**Method 2 (manual).** Copy the `custom_components/webrtc` folder from this repo into your
`/config/custom_components` folder and restart Home Assistant.

<details>
  <summary>Additional steps if you are using the UI in YAML mode: add card to resources</summary>

  The `custom_card` will be automatically registered with the Home Assistant UI, except when you are
  managing the UI in YAML mode. In that case add this to your UI resources for the
  `custom:webrtc-camera` card to work:
  ```yaml
  url: /webrtc/webrtc-camera.js
  type: module
  ```
  - Refresh your browser

</details>

## Configuration

Settings > Devices & Services > Add Integration > **WebRTC Camera**

If the integration is not in the list, you need to clear the browser cache.

The component adds two **services** (`webrtc.create_link`, `webrtc.dash_cast`), one **lovelace custom
card**, and — specific to this fork — two **diagnostic sensor entities** (see
[Diagnostic sensors](#diagnostic-sensors)). It does not create camera entities; use your existing Hass
cameras or go2rtc stream names as the card source.

## Custom card

As a `url` you can use:
- any protocol supported by go2rtc (`rtsp`, `rtmp`, `http`, `onvif`, `dvrip`, `homekit`, `roborock`, etc.)
- stream `name` from the go2rtc config
- `Jinja2` template (should render supported protocol or stream `name`)

As an `entity` you can use almost any camera from Hass.

As a `poster` you can use:
- `http`-link (should be publicly available link)
- camera `entity` from Hass
- stream `name` from the go2rtc config
- `Jinja2` template (should render camera `entity` or stream `name`)

**Minimal**

```yaml
type: 'custom:webrtc-camera'
url: 'rtsp://rtsp:12345678@192.168.1.123:554/av_stream/ch0'
```

**or**

```yaml
type: 'custom:webrtc-camera'
url: 'camera1'  # stream name from go2rtc.yaml
```

**or**

```yaml
type: 'custom:webrtc-camera'
entity: camera.generic_stream  # change to your camera entity_id
```

**or**

```yaml
type: 'custom:webrtc-camera'
streams:
  - url: go2rtc_stream_hd
    name: HD      # name is optional
    mode: webrtc  # mode is optional
    media: video  # media is optional
  - url: go2rtc_stream_sd
    name: SD
    mode: mse
    media: audio
```

**PS.** You can change the active stream by clicking on the `mode` label. Or by clicking on the stream
`name` with enabled `ui: true`.

**Full**

**All settings are optional!** Only required setting - `url` or `entity` or `streams`.

```yaml
type: 'custom:webrtc-camera'

url: 'rtsp://rtsp:12345678@192.168.1.123:554/av_stream/ch0'
entity: camera.generic_stream
mode: webrtc,mse,hls,mjpeg  # stream technology, default: webrtc,mse,hls,mjpeg
media: video,audio  # select only video or audio track, default both

server: http://192.168.1.123:1984/     # custom go2rtc server address, default empty

ui: true  # custom video controls, default false

digital_ptz:  # digital zoom and pan via mouse/touch, defaults:
  mouse_drag_pan: true
  mouse_wheel_zoom: true
  mouse_double_click_zoom: true
  touch_drag_pan: true
  touch_pinch_zoom: true
  touch_tap_drag_zoom: true
  persist: true  # zoom factor and viewport position survive page reloads

# digital_ptz: false  # to disable all mouse/touch digital zoom and pan

title: My super camera  # optional card title
poster: https://home-assistant.io/images/cast/splash.png  # still image when stream is loading
muted: true  # initial mute toggle state, default is false (unmuted)

intersection: 0.75  # auto stop stream when less than 75% of video element is in the screen, 50% by default
background: true  # keep the stream running when off-screen / tab hidden (this fork defaults to true)

shortcuts:  # custom shortcuts, default none
- name: Record
  icon: mdi:record-circle-outline
  service: switch.toggle
  service_data:
    entity_id: switch.camera_record
```

A shortcut may also `url:` (opens a link), `more_info:` (opens the more-info dialog of the given
entity id), or use the special **`service: fire-dom-event`** (fork #940) to dispatch a Lovelace
`ll-custom` DOM event — useful e.g. to close the current `browser_mod` popup. The whole shortcut item
becomes the event detail, so your `browser_mod:` / custom keys pass through:

```yaml
shortcuts:
- name: Close
  icon: mdi:close
  service: fire-dom-event
  browser_mod:
    command: close_popup
```

Pan, tilt, zoom controls: [PTZ config examples](https://github.com/AlexxIT/WebRTC/wiki/PTZ-Config-Examples).

**Paused by default**

```yaml
type: custom:webrtc-camera
poster: dahua1-snap  # stream name from go2rtc.yaml (http-snapshot)
streams:
  - url: ''          # empty url, so only poster will be shown
  - url: dahua1      # stream name from go2rtc.yaml (rtsp-stream)
```

**Video aspect ratio** [issue](https://github.com/AlexxIT/WebRTC/issues/21)

```yaml
style: "video {aspect-ratio: 16/9; object-fit: fill;}"
```

**Video rotation**

1. On client (free CPU):
   ```yaml
   style: 'video {transform: rotate(90deg); aspect-ratio: 1}'
   ```
2. On server - [FFmpeg transcoding](https://github.com/AlexxIT/go2rtc#source-ffmpeg) (high CPU cost)

**Hide UI elements**

```yaml
style: '.mode {display: none}'             # hide mode label
style: '.fullscreen {display: none}'       # hide fullscreen button
style: '.screenshot {display: none}'       # hide screenshot button
style: '.pictureinpicture {display: none}' # hide PIP button
```

**Reposition UI elements**

```yaml
# shortcuts to the top-right, stacked vertically
style: ".shortcuts {left: unset; top: 25px; right: 5px; display: flex; flex-direction: column}"
# PTZ to the left
style: ".ptz {right: unset; left: 10px}"
# mode label to the bottom
style: '.header {bottom: 6px} .mode {position: absolute; bottom: 0px}'
# header line to the bottom
style: '.header {top: unset; bottom: 6px}'
```

## Fork card options

These options are **specific to this fork** and tune the reversible MSE→WebRTC upgrade described in
[What this fork adds](#what-this-fork-adds). **You do not need any of them** — the defaults are chosen to
behave well on bad networks. They exist only for fine-tuning or diagnostics.

| Option              | Type    | Default              | In one line |
|---------------------|---------|----------------------|-------------|
| `rtc_swap_prove_ms` | number  | `30000` (ms)         | How long the background WebRTC feed must run flawlessly before it replaces the visible stream. |
| `firstframe_timeout`| number  | `120000` (ms)        | How long to wait for the very first video frame before declaring an attempt dead. |
| `network_strict`    | boolean | `false`              | How aggressively to drop a connection on a low-level socket error. |
| `rtc_reprobe`       | boolean | `true`               | Whether to keep retrying WebRTC in the background after a camera settled on MSE. |
| `rtc_reprobe_base`  | number  | `30000` (ms)         | First wait between those background retries. |
| `rtc_reprobe_max`   | number  | `600000` (ms, 10 min)| Longest wait between those background retries. |
| `pause_delay`       | number  | `5000` (ms)          | Grace period before pausing a scrolled-away camera (only with `background: false`). |

```yaml
type: 'custom:webrtc-camera'
url: 'rtsp://rtsp:12345678@192.168.1.123:554/av_stream/ch0'

# Fork tuning — every line is optional
rtc_swap_prove_ms: 30000    # prove WebRTC for 30s before switching to it
firstframe_timeout: 120000  # give an attempt 2 min to produce a first frame
network_strict: false       # keep the working stream, recover in the background
rtc_reprobe: true           # keep trying to upgrade an MSE-only camera
```

**Per-stream overrides:** `rtc_swap_prove_ms`, `firstframe_timeout` and `network_strict` can also be set
inside an individual `streams:` entry, where they override the card-level value for that one stream.

### What each option really does

**`rtc_swap_prove_ms` — the "prove it first" timer.**
When WebRTC is being tried in the background, this is how long it must play *without a single glitch*
before the card trusts it enough to put it on screen in place of MSE. It is your safety-vs-speed dial:
- **Raise it** (e.g. `60000`) if you have flaky cameras that connect via WebRTC but then stutter — a
  longer proof window means the card only switches to WebRTC that is genuinely stable.
- **Lower it** (e.g. `10000`) on a fast, reliable LAN where you want the low-latency picture sooner.

**`firstframe_timeout` — the "is anything coming?" timer.**
Any connection attempt (the visible one *or* a background WebRTC probe) is given this long to produce
its first decoded video frame. If nothing arrives, the attempt is considered dead and cleaned up. Note
that a connection can look "connected" at the network level while never actually delivering video — this
timer is what catches that case. **Lower it** to give up on dead or misconfigured sources faster; the
default (2 min) is deliberately generous so slow-to-start cameras are not killed prematurely.

**`network_strict` — how twitchy to be about socket errors.**
This controls one narrow thing: what to do when the underlying WebSocket reports a low-level error.
- `false` (default, recommended): **relaxed.** A transient socket error is logged and ignored; if the
  connection has really died the browser will report it a moment later through the normal channel, and
  the fork's own **5-second no-data watchdog** catches any silent freeze regardless. This is the safer
  choice because it won't tear down an otherwise-healthy picture over a momentary blip.
- `true`: **fail-fast.** The connection is dropped the instant any socket error is seen. This does *not*
  make recovery more reliable — the mechanisms above already recover on their own — it just reacts a few
  milliseconds sooner. Its real use is **diagnostics**: it surfaces flaky links immediately instead of
  letting the watchdog absorb them. For everyday viewing, leave it `false`.

  On a background WebRTC probe this setting has practically no effect: a probe is disposable and is
  reaped by `firstframe_timeout`/the re-probe loop anyway, and — by design — it can never disturb the
  live picture.

**`rtc_reprobe` (+ `rtc_reprobe_base` / `rtc_reprobe_max`) — the background retry loop.**
When a camera ends up on MSE because WebRTC wasn't available at that moment, this loop keeps quietly
retrying WebRTC so the camera can be upgraded later when the network improves. Retries start spaced by
`rtc_reprobe_base` and back off up to `rtc_reprobe_max`, so a permanently WebRTC-incapable network
settles into one cheap probe every 10 minutes rather than hammering. Set `rtc_reprobe: false` to switch
the loop off entirely (the camera then keeps whatever it first connected with).

**`pause_delay` — don't tear down on a quick scroll.**
Only relevant if you set `background: false` (which stops a camera when it scrolls off-screen or the tab
is hidden). This is the grace period before that teardown actually fires, so flicking past a camera
doesn't needlessly kill and restart its stream.

### Tuning by network path (wired vs. weak Wi-Fi)

The defaults are a good all-round compromise. If you want to squeeze the best behaviour out of a
*specific* camera, the guiding idea is that **each knob should lean in opposite directions depending on
how good the path is**:

- **Wired / strong LAN** — the path is reliable, so you can afford to be **fast and confident**: switch
  to the low-latency WebRTC picture sooner, and give up on genuinely dead sources sooner.
- **Distant camera behind several Wi-Fi repeater hops** — the path is jittery and lossy, so you must be
  **patient and conservative**: only switch to WebRTC once it has proven rock-solid, never kill a
  slow-starting attempt prematurely, and above all never tear down the working MSE picture over a blip.

| Option | Wired / strong LAN | Weak path (e.g. 3× Wi-Fi repeater hops) | Why |
|---|---|---|---|
| `rtc_swap_prove_ms` (def. 30000) | **15000** (down to 10000) | **60000** (up to 90000) | The anti-flicker filter. On a good path WebRTC that starts will hold, so a shorter proof gets you to low latency sooner. On a weak path WebRTC can run 20–30 s and then stall — a long proof window lets **only** a genuinely stable feed take over, killing the swap→stall→revert churn. |
| `firstframe_timeout` (def. 120000) | **60000** | **120000** (default — do **not** lower) | On a good path the first frame arrives fast, so you can drop a dead source quicker. On a lossy path the first keyframe can genuinely take a while; lowering this would reap attempts that would have succeeded. |
| `network_strict` (def. false) | **false** | **false** | On a flaky link, transient socket errors are expected and self-heal, so `true` would needlessly tear down a healthy picture. On wired, `true` only saves a few milliseconds. Leave it `false` either way — it is a diagnostics toggle, not a reliability one. |
| `rtc_reprobe` / `_base` / `_max` | defaults | `rtc_reprobe_base: 60000` | A good path usually reaches WebRTC and the loop stops on its own. On a known-marginal path, probing a little less often trims wasted background work. |

**Ready-to-paste starting points** (add to the rest of your card config):

```yaml
# Wired / strong LAN — bias toward speed & low latency
rtc_swap_prove_ms: 15000    # a stable wired WebRTC: switch over sooner
firstframe_timeout: 60000   # first frame is fast here: drop dead sources sooner
network_strict: false
```

```yaml
# Distant camera, ~3 Wi-Fi repeater hops — bias toward stability & zero churn
rtc_swap_prove_ms: 60000    # only adopt WebRTC after 60s of flawless play
firstframe_timeout: 120000  # lossy link: give the first keyframe time (don't lower)
network_strict: false       # a transient socket error must NOT drop the working MSE
rtc_reprobe_base: 60000     # optional: probe a marginal path a little less often
```

**A note on committing (releasing MSE).** There is a third, deliberately **non-exposed** timer,
`RTC_COMMIT_MS` (180 s of flawless WebRTC), after which the card *commits*: it releases the background
MSE stream and closes its connection. This is intentional and self-protecting:
- On a **wired** camera it will be reached — after ~3 stable minutes the card commits to WebRTC and frees
  the resources. Correct.
- On a **weak path** it will almost never be reached (staying 180 s without a single gap is unlikely), so
  the camera stays **reversible indefinitely** — if WebRTC stalls it snaps back to the warm MSE with no
  black frame. Exactly what you want there.

**Verifying it in operation.** These are reasoned starting points, not per-camera measurements — set
them, then watch two signals:

1. **The `shadow_probes` sensor.** On the weak camera it should tick `0↔1` while the picture stays on MSE
   *without visible flicker*. If you see the tile flick to black and back (a swap that immediately
   reverts), raise `rtc_swap_prove_ms` further.
2. **The browser console** (with the card loaded, look for `[VideoRTC:…] RTC phase …` lines). The time it
   takes to reach the `promoted` phase is a **path-quality canary**: fast (~2–4 s) means WebRTC will adopt
   cleanly; slow (>10 s) means the long proof window is correctly doing its job filtering a marginal path.
   On a wired camera you should also see the phase reach `committed` after ~3 minutes, and that camera's
   `proxied_connections` contribution drop as the MSE connection closes.

## Card UI additions: `tap_action` and `live_indicator`

Two small, opt-in UI features this fork adds to the card (both are `false`/absent by default).

### `live_indicator` — liveness dot

Set `live_indicator: true` to show a small dot in the top-right controls that is **green while frames
are actually being presented** and **red when the video has silently frozen**. It is driven by
`requestVideoFrameCallback` on the *current* driver's `<video>` (so it also catches freezes that emit no
`waiting` event) plus a 500 ms watchdog, and it is re-bound automatically on every stream/driver swap.
It is purely visual — it does not change the stream or the upgrade logic.

```yaml
type: custom:webrtc-camera
url: mycamera
live_indicator: true
```

### `tap_action` — action on tapping the video

Set `tap_action` to run a standard Home Assistant action when you tap the video. It uses the usual
Lovelace action shape (`more-info`, `navigate`, `url`, `toggle`, `perform-action` / `call-service`,
`fire-dom-event`, `none`).

The tap is **gated so it never steals a digital-PTZ gesture**: it fires only on a *clean single-finger
tap that doesn't move*. A pinch (two fingers), a pan/drag (movement > ~10 px), and taps on the control
overlay (shortcuts, PTZ, buttons) are all ignored — so pinch-zoom and pan keep working exactly as before.

> **⚠️ This card is stream-based, not entity-based.** In the go2rtc spirit, `url: mystream` points at a
> **go2rtc stream**, which is *not* a Home Assistant entity. So a bare `action: more-info` has **no entity
> to open** and does nothing. You have two options:

**1. Name the entity explicitly** (works even though the card itself has no entity):

```yaml
tap_action:
  action: more-info
  entity: switch.cancello_interno   # required — the card provides no entity of its own
```

**2. Use an action that needs no entity** — usually the more natural choice for a stream-only card:

```yaml
# Open a gate straight from the video
tap_action:
  action: perform-action
  perform_action: switch.turn_on
  target:
    entity_id: switch.cancello_interno
```

```yaml
# Jump to another dashboard view
tap_action:
  action: navigate
  navigation_path: /lovelace/cameras
```

The action executor also accepts the older `call-service` name and the `service` + `service_data`
shape (the same shape used by `shortcuts:`), so this is equivalent to the `perform-action` example above:

```yaml
tap_action:
  action: call-service
  service: switch.turn_on
  service_data:
    entity_id: switch.cancello_interno
```

If you configure the card with `entity: camera.foo` instead of `url:`, then a bare `action: more-info`
works because the card *does* have an entity to fall back to (resolution order:
`tap_action.entity` → card `entity:` → the current stream's `entity`).

## Custom-UI overlay options (`ui: true`)

With `ui: true` the card draws its control overlay (fullscreen, screenshot, picture-in-picture,
play/pause, volume). These fork options tune that overlay:

| Option                 | Type    | Default | What it does |
|------------------------|---------|---------|--------------|
| `unmute_in_fullscreen` | boolean | `false` | (#953) Unmute the stream while it is fullscreen, then restore the previous muted state when fullscreen ends. Works on iOS (`webkitendfullscreen`) and desktop (`fullscreenchange`). |
| `spinner`              | boolean | `true`  | (#924) Set `false` to remove the loading spinner entirely. |
| `spinner_delay`        | number  | `0` (ms)| (#924) Delay before the spinner appears on a `waiting` event, so a brief stall doesn't flash it. |

```yaml
type: custom:webrtc-camera
url: mycamera
ui: true
unmute_in_fullscreen: true
spinner_delay: 800          # only show the spinner if a stall lasts > 0.8s
# spinner: false            # …or drop it altogether
```

The **play/pause** control (#913) is a toggle: it stays visible under `ui: true` and mirrors the
element state, so you can freeze the live picture and resume it (resuming re-seeks to the live edge).

A **local still image** can be used as the `poster` (#949) — any HA-served path works, since a `poster`
that starts with `/` (or contains `://`) is passed straight to the `<video>` element:

```yaml
poster: /local/mycamera.png   # file in <config>/www/mycamera.png
```

## Browser-side ICE servers (`ice_servers`)

By default the card offers the browser **two** independent public STUN servers — Google
(`stun:stun.l.google.com:19302`) and Cloudflare (`stun:stun.cloudflare.com:3478`) (fork #915). STUN is
enough to discover your public address and set up a **direct** browser↔go2rtc WebRTC path on most
networks; using two providers means a blocked, filtered or down one (some ISPs/countries block Google)
doesn't stop discovery. This default applies to **every camera**. STUN is **not** enough when the home
end is behind **CGNAT** or a symmetric NAT with no reachable public endpoint — there the browser needs a
**TURN relay**, which you must supply yourself.

`ice_servers` (fork #952) lets you supply your own STUN/TURN list, which **fully replaces** the default on
the browser's `RTCPeerConnection` (applied to every internal driver, main and shadow — it survives the
MSE↔WebRTC driver swaps). It accepts the standard `RTCIceServer` shape — a bare string, a list of
strings, or a list of objects with `urls` / `username` / `credential`:

```yaml
type: custom:webrtc-camera
url: mycamera
ice_servers:
  - urls: stun:stun.cloudflare.com:3478
  - urls: turn:turn.example.com:3478
    username: myuser
    credential: mysecret
```

**Privacy opt-out (zero third parties).** Setting an **explicit empty list** removes all default STUN
servers, so the browser contacts no external provider. WebRTC then still works on the **LAN** (host
candidates), while remote access simply falls back to the reliable MSE path. It costs nothing and is
purely for those who don't want any third-party STUN:

```yaml
ice_servers: []   # no STUN/TURN at all — no Google, no Cloudflare
```

> Note: this is only meaningful as an **explicit** `ice_servers: []`. Omitting `ice_servers` keeps the
> automatic behaviour below; a malformed non-empty list is treated as a typo and also keeps the default
> (it is not silently wiped) — and that case is **logged at `warning`** (`ice-config`, visible in
> Settings → System → Logs without enabling debug), so a fat-fingered STUN/TURN URL is easy to spot. The
> resolved ICE source in effect is also mirrored to the log at `debug` (`ice` / `ice-ha`, card sub-logger).

**Home Assistant's own ICE servers (automatic, incl. Nabu Casa TURN — fork #923).** When you do **not**
set a per-card `ice_servers`, the card automatically reuses Home Assistant's **own** ICE list — anything
you put under the core `webrtc:` config **plus any cloud-provided TURN** (Nabu Casa / Homeway) — fetched
once via HA's native `web_rtc/ice_servers` command. This matters because Nabu Casa's TURN credentials are
short-lived and rotating, so they **cannot** be pasted into `ice_servers` by hand — this is the only way a
CGNAT / symmetric-NAT home gets a working relay, and Nabu Casa subscribers get it for free with zero
config. It fails soft: on an HA too old to expose the command, the card just keeps the built-in STUN
default.

Precedence, most specific wins:

1. **per-card `ice_servers`** (#952) — fully replaces everything, including the `[]` privacy opt-out;
2. **HA native ICE** (#923) — the `webrtc:` config + Nabu Casa/Homeway TURN, used automatically when (1)
   is unset;
3. **built-in 2×STUN default** (#915) — Google + Cloudflare, used when HA exposes no ICE servers.

> All of the above is the **browser** side only — it does not touch how **go2rtc** (the home peer) gathers
> its own candidates. A per-card `ice_servers` entry is something you run and pay for yourself; the HA
> native path (2) is the free automatic one. If you only have public-IP or port-forwarded access, STUN is
> all you need; a **TURN** relay is required only for CGNAT/symmetric-NAT homes.

## Diagnostic sensors

This fork registers two number sensors under a **WebRTC Camera** device (upstream creates none). Every
camera tile talks to Home Assistant through a small connection on the go2rtc proxy; these two sensors
simply **count those connections**, split by purpose. They are useful for confirming the background
upgrade path is actually running, and for spotting leaks (a count that never returns to zero when all
cameras are closed).

| Sensor                            | What it counts | Think of it as |
|-----------------------------------|----------------|----------------|
| `sensor.proxied_connections` — *Proxied Connections* | Visible camera streams currently open (the "main" connections that carry MSE video). | **How many camera tiles are streaming right now.** |
| `sensor.shadow_probes` — *Shadow Probes* | Background WebRTC attempts in flight (the throwaway "shadow" connections — signalling only, no picture). | **How many cameras are quietly trying to upgrade to WebRTC.** |

**How to read them:**
- A camera showing MSE and trying to upgrade will make `shadow_probes` tick **up to 1 while it probes,
  then back to 0** — repeatedly, spaced further apart over time (the re-probe backoff). Seeing it
  oscillate is *normal and healthy*, not a bug: it means the fork is doing its job.
- When a camera successfully upgrades to WebRTC, its probe finishes and `shadow_probes` drops back.
- `proxied_connections` roughly tracks the number of tiles on screen. Note that a camera which fully
  commits to WebRTC eventually closes its proxy connection (the video then flows peer-to-peer, off the
  proxy), so a committed-WebRTC tile can read as **0** here even though you can see it — that is
  expected.

## Templates

- Card options `shortcuts`, `style` and `ptz` support JavaScript templates
- In `shortcuts` and `style` you can use `states` related templates
- In `ptz` you can use `streamName`/`streamID` related templates (useful for a card with multiple templates)

```yaml
shortcuts:
  - name: Barn Light
    icon: ${ states['light.yeelight_lamp'].state === 'on' ? 'mdi:outdoor-lamp':'mdi:lamp' }
    service: light.toggle
    service_data:
      entity_id: light.yeelight_lamp
```

```yaml
ptz:
  service: notify.persistent_notification
  data_left:
    message: Left for ${ this.streamName } clicked
  data_right:
    message: Right for ${ this.streamID } clicked
```

## Two-way audio

- Only for [supported sources](https://github.com/AlexxIT/go2rtc#two-way-audio) in go2rtc
- Only for Hass with HTTPS access, this limitation is [from the browsers](https://stackoverflow.com/questions/52759992/how-to-access-camera-and-microphone-in-chrome-without-https)
- Only for WebRTC mode
- HTTPS is also important for the Hass Mobile App!

Add `microphone` to the `media` param. You can use two streams: one with mic, second without:

```yaml
type: 'custom:webrtc-camera'
streams:
  - url: go2rtc_stream
  - url: go2rtc_stream
    mode: webrtc
    media: video,audio,microphone
```

**PS.** For the Hass [Mobile App](https://www.home-assistant.io/integrations/mobile_app/) ensure that you
can use the microphone with the built-in [Assist](https://www.home-assistant.io/voice_control/).

## Snapshots to Telegram

[read more](https://github.com/AlexxIT/go2rtc/wiki/Snapshot-to-Telegram)

## Cast or share stream

The component supports streaming to [Google Cast](https://www.home-assistant.io/integrations/cast/)
Chromecast devices (including Android TV and Google Smart Screen) via the `webrtc.dash_cast` service, and
creating a temporary or permanent link to a stream via the `webrtc.create_link` service — without sharing
access to your Home Assistant. Read more in the upstream
[wiki](https://github.com/AlexxIT/WebRTC/wiki/Cast-or-share-camera-stream).

## Stream to camera

go2rtc can play audio files (ex. [music](https://www.home-assistant.io/integrations/media_source/) or
[TTS](https://www.home-assistant.io/integrations/#text-to-speech)) and live streams (ex. radio) on cameras
with [two way audio](https://github.com/AlexxIT/go2rtc#two-way-audio) support. You need to:

1. Check if your camera has a supported [two way audio](https://github.com/AlexxIT/go2rtc#two-way-audio) source
2. Setup the camera stream in the [go2rtc.yaml config](https://github.com/AlexxIT/go2rtc#configuration)
3. Check the audio codec that your [camera supports](https://github.com/AlexxIT/go2rtc#stream-to-camera)
4. Create virtual [Media Players](https://www.home-assistant.io/integrations/media_player/) for your cameras in `configuration.yaml`:

```yaml
media_player:
  - platform: webrtc
    name: Dahua Camera
    stream: dahua
    audio: pcmu/48000
  - platform: webrtc
    name: Tapo Camera
    stream: tapo
    audio: pcma
```

## FAQ

**Q. External access with WebRTC doesn't work**
A. [Read more](https://github.com/AlexxIT/WebRTC/issues/378). On this fork, external/tunnel paths that
cannot complete a WebRTC handshake will simply stay on MSE — this is by design and not a bug.

**Q. My camera never switches to WebRTC / `shadow_probes` keeps ticking up and down**
A. That oscillation is normal — it's the background re-probe loop keeping an MSE-only camera under
observation (see [Diagnostic sensors](#diagnostic-sensors)). The camera isn't switching because the path
can't hold WebRTC gaplessly for `rtc_swap_prove_ms`, so each probe is discarded and the reliable MSE
picture is kept — the safety behaviour working as intended. If you'd rather it stop probing entirely,
set `rtc_reprobe: false`.

**Q. Audio doesn't work**
A. Check what audio codec your camera outputs and what technology you use to watch. Different technologies
support different codecs.

## Debug

Add to your `configuration.yaml`:

```yaml
logger:
  default: warning
  logs:
    custom_components.webrtc: debug
```

Client-side, open the browser console and confirm the card banner (`[WebRTC Camera] vXX.X.X`). After
updating the card, do a **hard reload** (Cmd/Ctrl+Shift+R) so the browser/PWA service worker picks up the
new resource version.

## Debug logging (troubleshooting stream loss)

The browser console is the natural place to watch a stream — but the **Home Assistant mobile app has no
console**. If a camera keeps dropping only on a phone (e.g. on mobile data / 5G) you are blind. The card
fixes that by mirroring every stream's lifecycle to the HA log, which you can read from the app under
**Settings → System → Logs** — no console required.

There is **no `debug` card option and no on/off switch**: the mirroring is always on, and what you see is
decided entirely by the **native HA logger level** for the sub-logger `custom_components.webrtc.card`.
Events are emitted at rationalized levels — recoverable anomalies at `warning` (visible by default),
routine lifecycle at `debug` (filtered out unless you ask for it). This is the same discipline the browser
console follows (`console.warn`/`console.error` show by default; `console.debug` needs "Verbose").

**What it logs** (logger `custom_components.webrtc.card`, one line per event, prefixed with the camera `url`):

| Event | Level | Meaning |
|---|---|---|
| `connection-closed` | warning | The stream dropped. The reason is included: `ws-close` (server/network closed the socket), `no-data-watchdog` (the picture froze — 5s of silence with the socket still open, the classic weak-link symptom), or `ws-error`. |
| `driver-error` | warning | go2rtc reported an error (e.g. `no route to host`, `i/o timeout`). Recoverable — the retry loop handles it. |
| `retry` | debug | A reconnect was scheduled, with the attempt number and back-off delay. |
| `stream-up` | debug | The stream (re)connected, with the transport (`mse` / `webrtc` / …). |
| `mode` | debug | A mode transition, e.g. `mse -> rtc` (the background WebRTC upgrade succeeded) or `rtc -> mse` (RTC stalled and reverted). This is the **only** app-visible signal that a camera reached — or fell back from — WebRTC: `stream-up` only reports the *initial* transport, while the shadow swap and direct-RTC upgrades happen later. |
| `page-hidden` / `page-visible` | debug | The tab/app went to the background or came back. **Key for mobile:** if losses line up with `page-hidden`, the app is being backgrounded (or handing off 5G↔Wi-Fi), not a camera fault. |
| `auto-pause` / `auto-resume` | debug | Only with `background: false` — the card tore down / restarted a scrolled-away camera. |

Repeated identical events are **throttled**: the first logs immediately, further ones in a 10-second
window are counted and flushed once as `(repeated N× in 10s)`, so a flapping camera can't flood the log.

The card's events log under their **own** sub-logger, `custom_components.webrtc.card`, separate from the
integration's backend logger `custom_components.webrtc`. The two `warning` events (`connection-closed`,
`driver-error`) show up in **Settings → System → Logs** out of the box. The `debug` events (`retry`,
`stream-up`, `page-hidden` / `page-visible`, `auto-pause` / `auto-resume`) are filtered out at the default
level — to see them, lower the level for **only this sub-logger** in `configuration.yaml` and restart:

```yaml
logger:
  logs:
    custom_components.webrtc.card: debug   # ONLY the card events — backend stays quiet
```

> **Note:** modern Home Assistant no longer keeps a persistent `home-assistant.log` file on disk (it was
> dropped to cut SD-card write wear) — read the log live in the app under **Settings → System → Logs**,
> not from a file over SSH. Scope the override to `custom_components.webrtc.card`: raising the parent
> `custom_components.webrtc` to debug instead un-mutes the backend proxy's own per-stream handshake and
> benchmark lines, which flood the log on a multi-camera fleet.

**Recipe for the 5G stream-loss case:** the `warning` events already land in **Settings → System → Logs**
with no configuration. If you also want the surrounding lifecycle, add the
`custom_components.webrtc.card: debug` logger block above and restart, reproduce the loss on the phone,
then watch the log. A run of `connection-closed: no-data-watchdog` → `retry` → `stream-up` is the network
dropping and the card recovering; the same run *immediately after* a `page-hidden` points at the app
backgrounding instead.

## Companion add-on: cameras behind Wi-Fi repeaters (`no route to host`)

If a camera reached over **cascaded Wi-Fi repeaters** intermittently becomes unreachable *from Home
Assistant* — go2rtc logs `driver-error: … dial tcp <ip>:554: connect: no route to host` — while the
**vendor app keeps working** and **only a camera reboot** recovers it, the cause is almost always
ARP/broadcast black-holing across the repeater chain, not the card or go2rtc: Home Assistant's ARP
resolution for the camera fails (the neighbor entry goes `INCOMPLETE`), so the direct LAN dial to `:554`
dies even though the camera is up.

A small companion Home Assistant add-on works around it by pinning each camera's `IP → MAC` as a
**permanent ARP entry** on the host, so HA never needs to re-resolve it via the (black-holed) broadcast:

**→ [Static ARP for cameras](https://github.com/fuzzybear62/ha-apps)** — add the repository URL under
**Settings → Apps → App Store → ⋮ → Repositories**, then install.

> **Scope:** this is a **Home Assistant OS** add-on built for **aarch64**, developed and validated on a
> **Raspberry Pi 5** (it applies to other aarch64 HAOS hosts too). It relies on the Supervisor add-on model
> (`host_network` + `NET_ADMIN`), so it does **not** apply to Home Assistant Container/Core installs or
> other architectures without changes. It is a Layer-2 workaround for a flaky repeater path — the robust
> structural fix remains a wired or mesh backhaul.

## Known work cameras

| Brand        | Models                                                | Comment                                                                                                                                                                                                                              |
|--------------|-------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ActiveCam    | AC-D2121IR3                                           |                                                                                                                                                                                                                                      |
| ActiveCam    | AC-D7121IR1W                                          | support sound                                                                                                                                                                                                                        |
| Android      | [IP Webcam Pro][1]                                    | support sound, `rtsp://192.168.1.123:8080/h264_ulaw.sdp`                                                                                                                                                                             |
| C-tronics    | CTIPC-690C                                            | support sound, main : `rtsp://username:password@192.168.1.xx:554/11` or `onvif://username:password@192.168.1.xx:8080?subtype=MainStreamProfileToken`                                                                                 |
| Dahua        | DH-IPC-HDPW1431FP-AS-0280B, VTO2211G-P                | support sound                                                                                                                                                                                                                        |
| Dahua        | VTO2202F-P-S2                                         | [read more](https://github.com/blakeblackshear/frigate/discussions/2572)                                                                                                                                                             |
| D-Link       | DCS-5222LB1, DCS-8300LHV2                             | ✅ verified with this fork                                                                                                                                                                                                            |
| EZVIZ        | C3S                                                   | `rtsp://admin:pass@192.168.1.123:554/h264/ch01/main/av_stream` and `/h264/ch01/sub/av_stream`                                                                                                                                        |
| EZVIZ        | C3W, C3WN, C6CN, C6T                                  | `rtsp://admin:pass@192.168.1.123:554/h264_stream`                                                                                                                                                                                    |
| EZVIZ        | C8C                                                   | `rtsp://admin:pass@192.168.1.123:554/channel80`                                                                                                                                                                                      |
| Foscam       | C1                                                    | `rtsp://user:pass@192.168.1.123:554/videoMain`                                                                                                                                                                                       |
| Foscam       | C2M, R2M                                              | `rtsp://user:pass@192.168.1.123:88/videoMain`                                                                                                                                                                                       |
| GW Security  | GW5088IP                                              | `rtsp://192.168.1.123:554/mpeg4cif?username=admin&password=123456`                                                                                                                                                                   |
| GW Security  | GW5078IP                                              | `rtsp://192.168.1.123:554/stream0?username=admin&password=123456`                                                                                                                                                                   |
| GW Security  | GW5071IP                                              | Not working yet, something similar to `rtsp://admin:123456@192.168.0.207:554/live/main` or `rtsp://192.168.0.207:554/live/main?username=admin&password=123456`                                                                       |
| Hikvision    | DS-2CD2T47G1-L, DS-2CD1321-I, DS-2CD2143G0-IS         | `rtsp://user:pass@192.168.1.123:554/ISAPI/Streaming/Channels/102`                                                                                                                                                                    |
| Hikvision    | IPC-HDW3849H-AS-PV, IPC-EW5531-AS                     | wired to nvr DHI-NVR2108HS-8P-I using [custom component](https://github.com/rroller/dahua)                                                                                                                                           |
| Imou         | IPC-F42-B2E3 (Bullet 2C 4MP)                          | `rtsp://admin:password@192.168.1.123:554/cam/realmonitor?channel=1&subtype=0`                                                                                                                                                        |
| QNAP         | QUSBCam2                                              | `rtsp://username:password@192.168.1.123:554/channel1` [docs](https://www.qnap.com/en/how-to/faq/article/what-is-the-qusbcam2-rtsp-url-format)                                                                                        |
| Raspberry Pi | PiCam                                                 | [read more](https://github.com/AlexxIT/WebRTC/issues/261)                                                                                                                                                                            |
| Reolink      | RLC-410, RLC-410W, RLC-510WA, E1 Pro, E1 Zoom, 4505MP | RLC-510WA support sound, E1 Zoom support sound, PTZ and zoom                                                                                                                                                                         |
| Reolink      | E1                                                    | `rtsp://admin:password@192.168.1.123:554/h264Preview_01_main`                                                                                                                                                                        |
| Sonoff       | GK-200MP2-B                                           | support sound and [PTZ](https://github.com/AlexxIT/SonoffLAN#sonoff-gk-200mp2-b-camera), `rtsp://rtsp:12345678@192.168.1.123:554/av_stream/ch0` and `/av_stream/ch1`                                                                 |
| SriHome      | SH035                                                 | `rtsp://192.168.xxx.xxx:8554/profile0` and `/profile1` and `/profile2`                                                                                                                                                               |
| Topvico      |                                                       | `rtsp://192.168.1.123:8554/stream0` or `rtsp://192.168.1.123:554/ch0_0.264`                                                                                                                                                          |
| TP-Link      | Tapo C100/C200/C210/C220/C310; C110/C210/C320WS ✅ verified with this fork | `rtsp://user:pass@192.168.1.123:554/stream1` and `/stream2`                                                                                                                                                                          |
| TVT/Secutech | NVR-0808B2-8P                                         | `rtsp://user:pass@192.168.1.123:554/chID=1&streamType=main` and `chID=2&streamType=main`                                                                                                                                             |
| TVT/Secutech | IPC5-DF28SN                                           | `rtsp://user:pass@192.168.1.123:554/profile1` and `/profile2`                                                                                                                                                                        |
| Unifi        | G4 Dome, G4 doorbell, G3 Bullet, G3 Flex              | Copy the rtsps link from the camera's settings in Unifi Protect, but change the link to `rtsp://` (it defaults to rtsps://), change the port to `7447`, and remove any query params                                                  |
| Wyze         | Cam v2/v3, Cam Pan v1/v2                              | support sound                                                                                                                                                                                                                        |
| Xiaomi       | Dafang                                                | [with hack](https://github.com/EliasKotlyar/Xiaomi-Dafang-Hacks), `rtsp://192.168.1.123:8554/unicast` <br> Video: H264, size: 1920x1080, bitrate: 1000, format: VBR, frame rate: 10 <br> Audio: PCMU, rate in: 8000, rate out: 44100 |
| Yale         | SV-4CFDVR-2, SV-DAFX                                  | `rtsp://admin:password@192.168.1.123/cam/realmonitor?channel=1&subtype=0`                                                                                                                                                            |
| Yale         | SV-DPFX                                               | `rtsp://admin:password@192.168.1.123/cam/realmonitor?channel=1&subtype=1`                                                                                                                                                            |
| Yi           | Hi3518e Chipset                                       | [with hack](https://github.com/alienatedsec/yi-hack-v5)                                                                                                                                                                              |
| Yi           | MStar Infinity Chipset                                | [with hack](https://github.com/roleoroleo/yi-hack-MStar)                                                                                                                                                                             |

[1]: https://play.google.com/store/apps/details?id=com.pas.webcam.pro
