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
* [Known work cameras](#known-work-cameras)
<!-- TOC -->

## What this fork adds

Upstream plays whichever technology negotiates first and, historically, a failed WebRTC attempt could
disturb an already-working MSE picture. On clean LANs that is invisible. On degraded paths (repeaters,
TURN relays, remote tunnels, briefly-blocked UDP) it causes black tiles and churn.

This fork reworks that handoff into an explicit, reversible state machine:

- **MSE comes up first and stays visible.** The card shows the reliable MSE stream immediately and never
  tears it down to try something else.
- **WebRTC is probed in the background** by a disposable *shadow* driver on a second signalling socket.
  The live MSE picture is untouched while this happens.
- **The switch is prove-gated.** The shadow only replaces the visible stream after its WebRTC feed has
  played **gaplessly for `rtc_swap_prove_ms`** (default 30 s). A shadow that stalls before proving is
  silently reaped — no black frame, no swap, no revert. On good paths the swap is seamless.
- **Permanent safety net.** If a camera came up on MSE only because WebRTC was momentarily unavailable,
  a background re-probe loop keeps retrying with backoff (30 s → … → 10 min) and upgrades later, without
  ever disturbing the live MSE picture. Opt out with `rtc_reprobe: false`.
- **Two upgrade knobs** (`rtc_swap_prove_ms`, `firstframe_timeout`) and a **fail-fast toggle**
  (`network_strict`) are exposed per-card — see [Fork card options](#fork-card-options).

Everything above is automatic. A plain upstream card config (`type: custom:webrtc-camera`, `url: …`)
gets all of it with no extra options.

Unlike upstream, this fork also **creates two diagnostic sensor entities** so you can watch live
viewer and background-probe counts — see [Diagnostic sensors](#diagnostic-sensors).

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

These options are **specific to this fork** and control the reversible MSE→WebRTC upgrade path
described in [What this fork adds](#what-this-fork-adds). All are optional; the defaults are tuned for
degraded networks and are safe to leave alone.

| Option              | Type    | Default              | Description |
|---------------------|---------|----------------------|-------------|
| `rtc_swap_prove_ms` | number  | `30000` (ms)         | How long the background WebRTC shadow must play **gaplessly** before it is allowed to replace the visible MSE stream. Higher = more conservative (fewer swaps on flaky paths); lower = quicker switch on good paths. |
| `firstframe_timeout`| number  | `120000` (ms)        | How long a driver waits for its first decoded frame before it is considered failed. Applies to both the main and shadow drivers. Lower to give up faster on dead sources. |
| `network_strict`    | boolean | `false`              | Fail-fast vs. recovery behaviour. `false` keeps the working stream and retries in the background; `true` surfaces failures immediately instead of masking them. Leave `false` for normal viewing; useful `true` for diagnostics. |
| `rtc_reprobe`       | boolean | `true`               | The long-term background re-probe loop that keeps trying to upgrade an MSE-only camera to WebRTC. Set `false` to opt out entirely (camera stays on whatever it first negotiated). |
| `rtc_reprobe_base`  | number  | `30000` (ms)         | Initial backoff delay for the re-probe loop. |
| `rtc_reprobe_max`   | number  | `600000` (ms, 10 min)| Maximum backoff delay for the re-probe loop. |
| `pause_delay`       | number  | `5000` (ms)          | Debounce before the auto-pause teardown fires when the tile goes off-screen or the tab is hidden. Only relevant with `background: false`; a quick scroll/flick within this window does not tear the stream down. |

```yaml
type: 'custom:webrtc-camera'
url: 'rtsp://rtsp:12345678@192.168.1.123:554/av_stream/ch0'

# Fork tuning (all optional)
rtc_swap_prove_ms: 30000    # prove WebRTC for 30s before swapping in
firstframe_timeout: 120000  # 2 min to first frame
network_strict: false       # keep the working stream, recover in background
rtc_reprobe: true           # keep trying to upgrade MSE-only cameras
```

Per-stream overrides are honoured: `rtc_swap_prove_ms`, `firstframe_timeout` and `network_strict` set
inside a `streams:` entry take precedence over the card-level value for that stream.

## Diagnostic sensors

This fork registers two sensors under a **WebRTC Camera** device (upstream creates none). They count
live signalling websockets on the go2rtc proxy and are handy for spotting leaks or verifying that the
background upgrade path is actually running:

| Sensor                            | Counts |
|-----------------------------------|--------|
| `sensor.proxied_connections` — *Proxied Connections* | Real viewer streams (main drivers) — media proxied over the websocket. |
| `sensor.shadow_probes` — *Shadow Probes* | Background WebRTC upgrade probes (shadow drivers) — signalling only, no media. |

A card that has settled on MSE and is probing for WebRTC in the background will briefly show
`shadow_probes` incrementing during each probe; a card that swapped up to WebRTC shows it drop back.
`proxied_connections` tracks the number of tiles currently streaming.

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

**Q. My camera never switches to WebRTC / `shadow_probes` keeps incrementing**
A. The path can't sustain WebRTC for `rtc_swap_prove_ms`, so the shadow is reaped and MSE is kept. This is
the safety behaviour working as intended. If you want it to give up probing, set `rtc_reprobe: false`.

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

## Known work cameras

| Brand        | Models                                                | Comment                                                                                                                                                                                                                              |
|--------------|-------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| ActiveCam    | AC-D2121IR3                                           |                                                                                                                                                                                                                                      |
| ActiveCam    | AC-D7121IR1W                                          | support sound                                                                                                                                                                                                                        |
| Android      | [IP Webcam Pro][1]                                    | support sound, `rtsp://192.168.1.123:8080/h264_ulaw.sdp`                                                                                                                                                                             |
| C-tronics    | CTIPC-690C                                            | support sound, main : `rtsp://username:password@192.168.1.xx:554/11` or `onvif://username:password@192.168.1.xx:8080?subtype=MainStreamProfileToken`                                                                                 |
| Dahua        | DH-IPC-HDPW1431FP-AS-0280B, VTO2211G-P                | support sound                                                                                                                                                                                                                        |
| Dahua        | VTO2202F-P-S2                                         | [read more](https://github.com/blakeblackshear/frigate/discussions/2572)                                                                                                                                                             |
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
| TP-Link      | Tapo C100/C200/C210/C220/C310                         | `rtsp://user:pass@192.168.1.123:554/stream1` and `/stream2`                                                                                                                                                                          |
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
