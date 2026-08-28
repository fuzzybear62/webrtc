# Diagnostics & instrumentation manual

This fork is heavily instrumented so a stream problem can be diagnosed **from the logs alone**, without a
debugger. This manual defines every instrumentation surface, every field it emits, and how to read and
interpret the output. For the quick "how do I turn it on" version see the
[Debug logging](README.md#debug-logging-troubleshooting-stream-loss) section of the README; this document
is the full reference behind it.

- [The four surfaces](#the-four-surfaces)
- [Turning instrumentation on](#turning-instrumentation-on)
- [Card event reference (`custom_components.webrtc.card`)](#card-event-reference)
- [The `metrics` line, field by field](#the-metrics-line-field-by-field)
- [Vocabulary: phase, band, congestion, path](#vocabulary)
- [Backend handshake log (`custom_components.webrtc`)](#backend-handshake-log)
- [Browser console](#browser-console)
- [How to read it: a mental model](#how-to-read-it-a-mental-model)
- [Worked examples](#worked-examples)
- [Quick triage recipes](#quick-triage-recipes)

---

## The four surfaces

Instrumentation lands on **four** distinct surfaces. Two are in the Home Assistant log (readable from the
mobile app, which has no browser console); two are in the browser console (richer, desktop/Android Chrome
only).

| Surface | Where | Logger / prefix | What it carries |
|---|---|---|---|
| **Card events** | HA log | `custom_components.webrtc.card` | Per-camera lifecycle, mode transitions, resilience decisions, the `metrics` telemetry line. **The main diagnostic surface.** |
| **Backend handshake** | HA log | `custom_components.webrtc` | Server-side WS connection accounting: client/shadow count, handshake latency, auth. |
| **Card console** | browser | `[WebRTC Camera]` | Cold-start vs shadow decisions, shadow swap, hard reset, auth failures, the version banner. |
| **Driver console** | browser | `[VideoRTC:<clientId>]` | The per-connection state machine: mode, RTC phase, promote/commit/revert, watchdog, ICE/SDP errors, probe-gate / grid-latch. |

**Rule of thumb:** use the browser console when you *have* one (it is the richer surface); use the HA log
when you don't (a phone on the HA app). The card **mirrors** the important events to the HA log precisely
so a mobile-only failure is still diagnosable.

---

## Turning instrumentation on

Severity mirrors the browser convention: **anomalies at `warning`** (visible by default), **routine
lifecycle and telemetry at `debug`** (hidden until you ask). There is **no `debug:` card option and no
on/off switch** — the logger level is the only control.

Add to `configuration.yaml` and restart:

```yaml
logger:
  default: warning
  logs:
    custom_components.webrtc.card: debug   # card events + the metrics line (this is what you usually want)
    # custom_components.webrtc: debug      # ALSO the backend handshake lines — noisy on a multi-camera fleet
```

> **Scope the override to `.card`.** Raising the parent `custom_components.webrtc` to `debug` un-mutes the
> backend proxy's per-stream handshake/benchmark lines, which flood the log on a large fleet. Enable the
> parent only when you are specifically chasing a server-side connection/auth problem.

> Modern Home Assistant no longer keeps a `home-assistant.log` file on disk — read the log live under
> **Settings → System → Logs**, not over SSH from a file.

In the **browser console**, the `debug`-level lines need **Verbose** enabled (Chrome DevTools → Console →
Levels ▾ → Verbose); `warn`/`error` show at the default level.

---

## Card event reference

Logger `custom_components.webrtc.card`. One line per event, prefixed with the camera stream name
(`[esternacancellocam_sub]`). Repeated identical events are throttled: the first logs immediately, further
ones in a 10 s window are counted and flushed once as `(repeated N× in 10s)` — **except** the
`ws-bursty`/`ws-reap` pair, which is exempt so an arm and its reap both land.

### Anomalies — `warning`, visible by default

| Event | Meaning & how to read it |
|---|---|
| `connection-closed` | The stream dropped. Reason follows: `ws-close` (server/network closed the socket), `no-data-watchdog` (froze — silence with the socket still open, the classic weak-link freeze), `ws-error`. A run of `connection-closed: no-data-watchdog → retry → stream-up` is *network drop → recovery*. |
| `driver-error` | go2rtc reported an error (`no route to host`, `i/o timeout`, …). Recoverable; the retry loop handles it. Repeated `no route to host` on a LAN camera → see the [Wi-Fi repeater ARP note](README.md#companion-add-on-cameras-behind-wi-fi-repeaters-no-route-to-host). |
| `rtc-revert` | A WebRTC feed was abandoned back to the warm MSE stream. Detail carries the cause (`sustained bad band (band=path, …ms)`, `grid blackout (band=path) — draining in-flight RTC probe`, …). Frequent reverts on one camera = a path that *connects* WebRTC but can't *sustain* it. |
| `rtc-suppressed` | WebRTC probing was paused because the **path itself** is blacked out. `RTC paused 300s` = this camera tripped the grid-wide latch; `in-flight probe drained` / `RTC probe denied` = another camera tripped it and this one is being held off. |
| `mse-playback: frozen` | The MSE picture stalled at the buffer edge (frozen-but-fed). The paired recovery is `mse-rideout`. Only the `frozen` state is `warning`; `flow`/`stutter` are `debug`. |
| `mse-rideout` | Non-destructive recovery: a frozen-but-fed picture was re-seeked to the live edge instead of reconnecting. |
| `ice-config` | Your `ice_servers` config had no valid entries and was ignored (falling back to defaults). |

### Lifecycle & telemetry — `debug`, needs the override

| Event | Meaning & how to read it |
|---|---|
| `stream-up` | (Re)connected, with the initial transport (`mse`/`webrtc`/…). Reports only the **first** transport — a later upgrade shows up as `mode`, not here. |
| `mode` | A transport transition: `none -> mse`, `mse -> rtc` (upgrade succeeded), `rtc -> mse` (reverted). **The only** signal that a camera reached — or fell back from — WebRTC. |
| `retry` | A reconnect was scheduled, with attempt number and back-off delay. |
| `stream-stable` | The stream cleared its probation window (`healthy 20s`) and is trusted. |
| `rtc-flap` | `score=N/3` — a camera reached WebRTC and reverted repeatedly; at 3/3 it is latched MSE-only (the weak-link protection). A lone `1.0/3` after a one-off grid event is benign. |
| `rtc-retest` | A suppression / MSE-only window elapsed; full WebRTC is being re-tested. |
| `ws-bursty` / `ws-reap` | Byte-aware watchdog milestones on a narrow link: the self-measured WS inter-chunk gap grew (`ws-bursty` armed), or a warm socket was extended/reaped (`ws-reap`). Pure storm-analysis diagnostics. |
| `metrics` | The periodic per-stream telemetry line — [decoded below](#the-metrics-line-field-by-field). |
| `mse-playback: flow`/`stutter` | Routine MSE playback health (`flow` = keeping up; `stutter` = advanced < wall-clock). |
| `ice` / `ice-ha` | Which ICE servers were used (`ice: ha-native (1)`) and how many HA supplied (`ice-ha: 1 server(s)`). |
| `page-hidden` / `page-visible` | Tab/app backgrounded or foregrounded. **Key for mobile:** losses that line up with `page-hidden` are the app being backgrounded (or a 5G↔Wi-Fi handoff), not a camera fault. |
| `auto-pause` / `auto-resume` | Only with `background: false` — a scrolled-away camera was torn down / restarted. |

---

## The `metrics` line, field by field

Emitted per stream every ~2 s while a WebRTC connection is being probed or is live. Example:

```
metrics: phase=promoted rtt=15ms(min 2) loss=1.6% gp=30kb/s jit=4ms cong=0.02 jbuf=6ms nack=9 pkt=733B path=host/host/udp band=perf exc=10ms
```

| Field | Unit | Meaning | How to read it |
|---|---|---|---|
| `phase` | enum | RTC state machine: `warm`/`negotiating`/`promoted`/`committed` — see [Vocabulary](#vocabulary). | `promoted` = WebRTC is on screen but MSE is still warm underneath (reversible). `committed` = MSE released (irreversible). |
| `rtt` | ms | Current candidate-pair round-trip time. | Compare with `(min …)`. |
| `(min N)` | ms | **Session-minimum** RTT — the queue-empty baseline. | The floor the link showed when idle. `rtt` far above `min` = a queue is building (see `exc`). |
| `loss` | % | Packet loss over the ~2 s window. | < 3 % healthy; ≥ 15 % pathological. Drives the `band` verdict. |
| `gp` | **KiB/s** | Goodput (received bytes / window). **Note:** value is kibibytes despite the `kb/s` label. | `30` ≈ 30 KB/s ≈ 240 kbps — normal for a `_sub` substream. Low `gp` **with** high `loss`/`rtt` means the link is *lossy*, not *narrow*. |
| `jit` | ms | RTP inter-arrival jitter. | Rising jitter precedes loss on a contended link. |
| `cong` | 0–1 | Smoothed congestion score (rtt-excess + loss), continuous. | The adaptive watchdog's own verdict. > ~0.3 = real pressure. |
| `jbuf` | ms | Jitter-buffer delay per emitted frame. | **Leading indicator.** A steady climb (6 → 700 ms) means the decoder is absorbing growing delay *before* `band` flips — the path is degrading while still labelled `perf`. |
| `nack` | count | NACKs (retransmit requests) sent in the window. | Non-zero = active loss recovery. High `nack` with low `loss` = loss being masked by retransmits (costs airtime). |
| `pkt` | bytes | Average received packet size. | Small `pkt` alongside high `nack` = fragmentation/partial frames, distinct from pure bufferbloat. |
| `path` | `local/remote/proto` | ICE candidate-pair types. | `host/host/udp` = direct LAN. `srflx` = STUN-reflexive. `relay` = TURN (traffic through a relay). |
| `band` | enum | Link verdict: `perf`/`degr`/`path` (or `?` when not probing) — thresholds in [Vocabulary](#vocabulary). | `perf` = healthy, `path` = pathological (triggers suppression), `degr` = ambiguous middle. |
| `exc` | ms | **Excess delay** = `rtt` EWMA − session-min RTT (standing-queue depth). | The single clearest bufferbloat signal. `exc` of 1000 ms+ on a LAN = airtime saturation, not distance. |

---

## Vocabulary

### `phase` — the RTC state machine

| Phase | Meaning | Reversible? |
|---|---|---|
| `warm` | MSE only; no RTC probe active (or one was abandoned). | — |
| `negotiating` | An RTC probe is decoding off-screen (opacity 0); MSE still shown. | ✅ yes |
| `promoted` | RTC revealed to the viewer; MSE kept warm underneath. | ✅ yes — a stall reverts to MSE with no black frame |
| `committed` | RTC collapsed onto the main element, MSE released, its socket closed. | ❌ irreversible |

The whole point of the fork's upgrade is the long `promoted` window: WebRTC has to prove itself *while
visible but with MSE still warm* before it is ever `committed`.

### `band` — the link verdict

Computed from **excess delay** and **loss**, whichever is worse (precedence: `path` dominates, else
`perf` if both healthy, else `degr`):

| Verdict | Rule | Meaning |
|---|---|---|
| `perf` | `exc` ≤ 80 ms **and** `loss` < 3 % | Queue ~empty, link healthy → fat pipe, parallel RTC ramps allowed. |
| `path` | `exc` ≥ 400 ms **or** `loss` ≥ 15 % | Standing queue or lossy path → **suppress RTC grid-wide 300 s**, stay on MSE. |
| `degr` | anything in between | Ambiguous; stay cautious, don't open the gate. |
| `?` | not currently probing | No verdict. |

### `cong` — congestion score

A **continuous** 0–1 smoothing of rtt-excess + short-window loss (deliberately *not* bucketed by `band`
label). It drives the adaptive warm-MSE watchdog: higher `cong` → the watchdog extends its patience so a
congested-but-alive stream is nursed instead of reaped into a reconnect storm.

### `path` — ICE candidate pair

`local/remote/proto`, e.g. `host/host/udp`. `host` = a direct interface address, `srflx` = server-reflexive
(via STUN), `prflx` = peer-reflexive, `relay` = via a TURN relay. Seeing `relay` means media is flowing
through a TURN server (e.g. Nabu Casa) — expect higher latency than `host/host`.

---

## Backend handshake log

Logger `custom_components.webrtc` (the Python side), prefixed with a server-assigned `client_id`:

```
[G9AOX] New client connection request: {'url': 'esternacancellocam_sub', 'client_id': 'G9AOX', …}
[G9AOX] Client: 192.168.188.23 | Handshake: 0.99ms | Clients: 1 Shadows: 0
[QDLCB] New … {'url': 'esternacitofonocam_sub', 'role': 'shadow', 'client_id': 'QDLCB'}
[QDLCB] Shadow: 192.168.188.23 | Handshake: 1.00ms | Clients: 4 Shadows: 1
```

- **`Clients` / `Shadows`** — live count of visible streams vs background RTC probes. `Shadows: 1`
  appearing is a re-probe/upgrade attempt in flight; it should return to `0` after the probe promotes or
  is reaped. A `Shadows` count that only grows is a probe leak.
- **`role: 'shadow'`** in the request marks the background probe connection (vs the visible `Client`).
- **`Handshake`** — server-side auth+setup latency (sub-ms on LAN). This is *not* stream latency.
- The `client_id` here (`G9AOX`) is the **server's** id; the browser console's `[VideoRTC:<clientId>]`
  is the **driver's** id. They are different namespaces — correlate by camera `url` and timestamp, not by id.

---

## Browser console

Two prefixes you can filter on independently:

- **`[WebRTC Camera] …`** — the card. Version banner (`v14.16.0`), `Cold Start` vs shadow scheduling,
  `Shadow RTC proven durable — SWAPPING DRIVERS NOW`, `Hard Reset Triggered`, auth failures.
- **`[VideoRTC:<clientId>] …`** — the driver, **one instance per connection**. During a shadow upgrade you
  will see **two** ids at once — the visible MSE driver and the background probe — which is how you tell
  the shadow from the live stream. Carries: `Mode: MSE/WebRTC/MJPEG/HLS/MP4`, `RTC phase X -> Y`,
  `RTC promoted (…ms flowing) — MSE kept warm`, `RTC stable … — committing (releasing MSE)`,
  `RTC Rejected (Priority < MSE) — staying on MSE`, `reverting to warm MSE`, the
  `No-data watchdog fired (…ms silent, phase=…, cong=…)` line, `MSE ride-out reseek …`, `ICE Error`,
  `SDP Error`, and the shared-gate messages (`RTC probe gate SUPPRESSED grid-wide …`,
  `MSE-reap grid latch ENGAGED …`).

**First check after any update:** confirm the banner `[WebRTC Camera] v14.16.0`. An old version = the
service worker served a stale bundle → hard-reload (Cmd/Ctrl+Shift+R). See
[the cache note](README.md#debug).

A healthy upgrade, in console order: `Mode: MSE` → `RTC promoted (…ms flowing) — MSE kept warm` →
`RTC stable … — committing`. A rejected one ends `RTC Rejected (Priority < MSE) — staying on MSE` or
`reverting to warm MSE`.

---

## How to read it: a mental model

1. **Is it one camera or the whole grid?** Independent single-camera drops = that camera/its link. Events
   that fire **correlated across every camera within a second** = a **shared** bottleneck (the uplink, the
   Wi-Fi airtime, the tab backgrounding). This distinction is the most important read in the whole log.
2. **Lossy vs narrow.** Low `gp` by itself is not a problem (substreams are low-bitrate). Low `gp`
   **together with** high `loss`, high `nack`, and `exc` in the hundreds-to-thousands of ms is a **lossy /
   contended medium** (Wi-Fi, interference), *not* a bandwidth ceiling. A true bandwidth ceiling shows
   high `gp` pinned at a limit with rising `exc`.
3. **Bufferbloat vs fragmentation.** High `exc`/`jbuf` with normal `pkt` = queue building (bufferbloat).
   High `nack` with small `pkt` = fragmentation / partial frames. They call for different fixes.
4. **Watch the leading indicators.** `jbuf` and `exc` creep up *before* `band` flips to `path`. A stream
   labelled `band=perf` with `jbuf` climbing through 500–700 ms is already stressed — the collapse, when it
   comes, will be sudden.
5. **Trust the state machine.** `rtc-revert`/`rtc-suppressed`/`mse-rideout` are the fork **working**, not
   failing. The failure would be a black tile or a `connection-closed` storm — which the resilience stack
   exists to prevent.

---

## Worked examples

### A. Healthy LAN upgrade

```
mode: none -> mse
stream-up: mse
mode: mse -> rtc
metrics: phase=promoted … cong=0.02 jbuf=6ms … band=perf exc=10ms
stream-stable: healthy 20s
```

MSE first, upgraded to RTC, `band=perf`, tiny `exc`/`cong`, then declared stable. Nothing to do.

### B. Contended-LAN collapse (real session, 4 cameras)

```
… (75 s of band=perf, but jbuf creeping 6ms → 700ms) …
metrics: … rtt=2052ms(min 2) loss=4.5% cong=0.45 … band=path exc=1313ms      ← the cliff
rtc-suppressed: grid blackout (band=path) — RTC paused 300s
rtc-revert: RTC aborted: sustained bad band (band=path, 7492ms)
mode: rtc -> mse
rtc-flap: score=1.0/3 (rtc-revert)
… (all 4 cameras revert within ~400ms) …
mse-playback: flow                                                            ← MSE rides out
… later …
Shadows: 1
rtc-suppressed: grid blackout (band=path) — RTC probe denied                  ← re-probe correctly held off
```

**Read:** `path=host/host/udp` (LAN) but `rtt` to 2 s and `exc` 1.3 s with tiny `gp` = **Wi-Fi airtime
saturation**, not narrow band. The collapse is **correlated across all 4** → a shared uplink, confirming
it is the *additive* RTC load (4 probes on contended air), not the cameras. The stack did exactly the
right thing: dropped all 4 to MSE-only in 400 ms, suppressed re-probing 300 s, and MSE rode out with **no
black screen and no `connection-closed`**. The `jbuf` creep over the preceding 75 s was the early warning.

### C. Mobile backgrounding (not a fault)

```
page-hidden
connection-closed: ws-close
… (app in background) …
page-visible
stream-up: mse
```

`connection-closed` **immediately after** `page-hidden` is the OS suspending the app, not a camera or
network fault. If losses only ever follow `page-hidden`, stop looking at the network.

---

## Quick triage recipes

| Symptom | Look for | Likely cause |
|---|---|---|
| One camera keeps dropping, others fine | `connection-closed` / `driver-error` on just that `url`; `path`/`band` on its `metrics` | That camera or its link (or ARP black-holing → `no route to host`). |
| **All** cameras stutter/revert together | correlated `rtc-revert` + `rtc-suppressed`, `band=path`, high `exc` | Shared uplink / Wi-Fi airtime saturation (example B). Working as designed. |
| Freezes only on the phone | `connection-closed` aligned with `page-hidden` | App backgrounding / 5G↔Wi-Fi handoff, not the stream (example C). |
| Never upgrades past MSE | `mode` stays `mse`; `rtc-flap`/`rtc-suppressed`; `band=degr/path` | WebRTC path constrained; check `path` (relay? no `host` pair?) and `ice`/`ice-ha`. |
| Latency high but no drops | `path=…/relay/…`, or high `jbuf`/`exc` at `band=perf` | Traffic via TURN relay, or a quietly bloating queue. |
| Version fixes not taking effect | console banner shows an **old** `vXX` | Stale service-worker bundle → hard reload (see [Debug](README.md#debug)). |
