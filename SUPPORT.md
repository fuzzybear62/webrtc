# Support

This is an independent, **hardened drop-in fork** of
[AlexxIT/WebRTC](https://github.com/AlexxIT/WebRTC), maintained as a **personal project** for a live
multi-camera Home Assistant fleet. It is shared because the fixes here may help others hitting the same
camera-streaming problems — not as a commercially supported product.

## What that means

- **Issues and questions are welcome.** They are read, and genuine bugs — especially reproducible ones
  with logs — are appreciated and do get fixed when they affect the fork's own use cases.
- **Support is best-effort and not guaranteed.** This is maintained alongside other work, so there is no
  response-time commitment, no SLA, and no promise that every request will be actioned. A quiet issue is
  not being ignored on purpose.
- **The fork is provided as-is**, under its [MIT license](LICENSE), with no warranty.

## Before opening an issue

You will get a useful answer much faster — and often solve it yourself — by attaching the diagnostics:

1. **Confirm the running version.** Open the browser console and check the banner
   (`[WebRTC Camera] vXX.XX.X`). An old version usually means a stale service-worker bundle — hard-reload
   (Ctrl/Cmd+Shift+R) first. See the README's [Debug](README.md#debug) note.
2. **Collect the logs.** The fork is heavily instrumented. Follow
   **[DIAGNOSTICS.md](DIAGNOSTICS.md)** to enable and read the Home Assistant log
   (`custom_components.webrtc.card`) and/or the browser console, and include the relevant lines —
   especially the `metrics` line and any `connection-closed` / `rtc-revert` / `rtc-suppressed` events.
3. **Describe the path.** Wired LAN, Wi-Fi repeater, 4G/5G, remote tunnel, TURN relay — the network path
   is usually the whole story.

## Good places to look first

- [README](README.md) — features, options, and network-path tuning.
- [DIAGNOSTICS.md](DIAGNOSTICS.md) — how to read the instrumentation and interpret a stream problem.
- [Upstream issues & PRs addressed](README.md#upstream-issues--prs-addressed) — if your problem matches
  a known upstream bug, the fix may already be in place.
