# Changelog

All notable, user-facing changes to this fork are documented here. This is a hardened, **drop-in fork**
of [AlexxIT/WebRTC](https://github.com/AlexxIT/WebRTC): it keeps 100% of the upstream card and
configuration surface (same `webrtc` domain, `webrtc-camera` card, and paths), so it can replace the
upstream integration without touching your config entry, entity IDs, or dashboards.

The format follows [Keep a Changelog](https://keepachangelog.com/). Detailed per-version engineering
notes are maintained privately and are intentionally not part of the public tree.

## [14.16.0] — 2026-08-28 — first public release

First public release of the fork. To migrate: remove the AlexxIT/WebRTC source in HACS, add
`https://github.com/fuzzybear62/webrtc`, and reinstall — everything else survives.

### Added — reliability & low-bandwidth architecture

- **Reversible MSE→WebRTC upgrade.** MSE comes up first and stays on screen; WebRTC is attempted
  invisibly on a background *shadow* connection and only ever *replaces* the visible stream after it has
  played gaplessly for a proof window. A stalling upgrade is discarded silently — no black frame, no
  flicker. A background re-probe loop keeps retrying (with increasing spacing) and upgrades the moment
  the network allows, without ever disturbing the live picture.
- **Sustained-stream resilience.** A congested MSE stream is *nursed*, not killed: the fork measures the
  link and, while it is congested, extends its patience and rides out short blackouts instead of
  reconnecting into a storm. A frozen-but-still-fed picture is nudged back to the live edge rather than
  torn down.
- **Low-bandwidth optimization.** On a narrow link the WebRTC probe is *additive* uplink load that can
  starve the MSE feed, so a camera that repeatedly reaches for WebRTC and falls back is latched to
  MSE-only for a while (re-tested later). WebRTC probes across all cameras are serialized through a
  shared gate, and a blacked-out path is suppressed grid-wide so tiles don't repeat a doomed attempt.
- **All of the above is automatic** — a plain card needs no options. The new card options only *tune* it.
- **Two diagnostic sensors** exposing how many cameras are streaming and whether the background upgrade
  path is working.
- **Dual stream** — a light substream in the dashboard grid, swapped to a full-res stream only while
  fullscreen, via `url_fullscreen` (desktop / Android PWA; iOS keeps the substream). Reuses the full
  resilience stack.
- **New card options**: `url_fullscreen` (grid-vs-fullscreen dual stream), `network_indicator`
  (network-state dot), `live_indicator` (#922), `tap_action`
  (#668), `ice_servers` (#952/#923/#915), `spinner_delay`/`spinner` (#924), `digital_ptz.persist`,
  plus tuning knobs (`rtc_swap_prove_ms`, `firstframe_timeout`, `rtc_reprobe*`, `network_strict`,
  `pause_delay`). `background` now defaults to `true`. See the README for the full reference.

### Fixed — upstream issues & PRs folded in

- Crashes & stability: `InvalidStateError` / constant buffering (#886, #901, #933, PR #938); ~1 fps
  crawl on iOS 26.1 (#910, #884); black screen after MSE→WebRTC switch (#871, mitigated).
- Home Assistant compatibility: `SUPPORT_PLAY_MEDIA` import break (#897); `'LovelaceData' object is not
  subscriptable` (#926, #927, #930).
- Networking, auth & ICE: reject expired signatures with 403 instead of 401 to avoid HA IP-bans
  (PR #956); `ws_poster` None guard (PR #961); use Home Assistant's own ICE servers incl. Nabu Casa
  TURN (PR #923); browser-configurable `ice_servers` (#952); dual default STUN, Google + Cloudflare
  (#915).
- Card & media-player features: `tap_action` (PR #668), `live_indicator` (PR #922), muted autoplay
  fallback only on `NotAllowedError` (PR #951), `media_player.play_media` via go2rtc `/api/ffmpeg`
  (PR #942), `volume_entity` (PR #945), `fire-dom-event` shortcuts (PR #940), duplicate
  `customElements.define` guard (#932).
- Bundled **go2rtc 1.9.14**.

### Changed

- Defaults are tuned to work, unchanged, on both a clean LAN and a pathological 4G link — no
  per-network configuration required.

[14.16.0]: https://github.com/fuzzybear62/webrtc/releases/tag/v14.16.0
