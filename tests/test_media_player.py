"""Behavioral tests for the media_player fixes (upstream PR #942 + #945).

#942: play_media must POST to go2rtc's /api/ffmpeg helper with {dst, file}
(audio auto-negotiated), not the old /api/streams path with a hardcoded
`ffmpeg:...#audio=<codec>`. `audio:` is now optional.

#945: with a `volume_entity` (a number/input_number), the player exposes
VOLUME_SET and maps HA's 0..1 volume_level onto the entity's native min..max.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from homeassistant.components.media_player import MediaPlayerEntityFeature

import custom_components.webrtc.media_player as mp
from custom_components.webrtc.media_player import WebRTCPlayer


def _state(value, min_v=0, max_v=100):
    return SimpleNamespace(state=str(value), attributes={"min": min_v, "max": max_v})


# --- #942: play_media via /api/ffmpeg ---------------------------------------


async def test_play_media_uses_api_ffmpeg(monkeypatch):
    """play_media POSTs {dst, file} to /api/ffmpeg, not the old /api/streams src."""
    post = AsyncMock(return_value=SimpleNamespace(ok=True))
    session = SimpleNamespace(post=post)

    monkeypatch.setattr(mp, "async_get_clientsession", lambda hass: session)
    monkeypatch.setattr(mp.utils, "api_ffmpeg", lambda hass: "http://go2rtc/api/ffmpeg")
    monkeypatch.setattr(mp.media_source, "is_media_source_id", lambda media_id: False)
    monkeypatch.setattr(mp, "async_process_play_media_url", lambda hass, url: url)

    player = WebRTCPlayer(name="Cam", stream="cam", audio=None)
    player.hass = MagicMock()

    await player.async_play_media("music", "http://tts/say.mp3")

    post.assert_awaited_once()
    args, kwargs = post.call_args
    assert args[0] == "http://go2rtc/api/ffmpeg"
    assert kwargs["params"] == {"dst": "cam", "file": "http://tts/say.mp3"}


def test_audio_is_optional():
    """The player constructs without `audio` (was Required)."""
    player = WebRTCPlayer(name="Cam", stream="cam")
    assert player.audio is None
    # No volume_entity -> VOLUME_SET must NOT be advertised.
    assert not (player.supported_features & MediaPlayerEntityFeature.VOLUME_SET)


# --- #945: volume_entity mapping --------------------------------------------


def test_volume_entity_enables_volume_set():
    player = WebRTCPlayer(name="Cam", stream="cam", volume_entity="number.vol")
    assert player.supported_features & MediaPlayerEntityFeature.VOLUME_SET


def test_volume_level_maps_native_range_to_unit():
    player = WebRTCPlayer(name="Cam", stream="cam", volume_entity="number.vol")
    player.hass = MagicMock()
    # 30 on a 0..100 entity -> 0.3
    player.hass.states.get.return_value = _state(30, 0, 100)
    assert player.volume_level == pytest.approx(0.3)


def test_volume_level_none_without_entity():
    player = WebRTCPlayer(name="Cam", stream="cam")
    assert player.volume_level is None


async def test_set_volume_level_calls_set_value_scaled(monkeypatch):
    player = WebRTCPlayer(name="Cam", stream="cam", volume_entity="number.vol")
    player.hass = MagicMock()
    player.hass.states.get.return_value = _state(0, 0, 100)
    player.hass.services.async_call = AsyncMock()
    monkeypatch.setattr(player, "async_write_ha_state", lambda: None)

    await player.async_set_volume_level(0.75)

    player.hass.services.async_call.assert_awaited_once()
    args, kwargs = player.hass.services.async_call.call_args
    assert args[0] == "number"          # domain from entity_id
    assert args[1] == "set_value"
    assert args[2]["entity_id"] == "number.vol"
    assert args[2]["value"] == pytest.approx(75)   # 0.75 of 0..100
