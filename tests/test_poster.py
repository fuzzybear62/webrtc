"""Behavioral tests for the ws_poster None-image guard (upstream PR #961).

When an image entity's async_image() returns None, ws_poster must not crash: the
debug log used `len(image)`, which raises TypeError on None. The fix is
`len(image) if image else 0`. These tests lock both the None path (no crash) and
the normal path (bytes still served).
"""

from unittest.mock import AsyncMock, MagicMock

from aiohttp import web

import custom_components.webrtc as webrtc
from custom_components.webrtc import ws_poster


def _fake_image_entity(image_bytes):
    entity = MagicMock()
    entity.async_image = AsyncMock(return_value=image_bytes)
    return entity


async def test_ws_poster_image_none_no_crash(monkeypatch):
    """image.* entity returning None must not raise (was TypeError on len(None))."""
    monkeypatch.setattr(
        webrtc, "_get_image_from_entity_id", lambda hass, poster: _fake_image_entity(None)
    )

    resp = await ws_poster(MagicMock(), {"poster": "image.doorbell"})

    assert isinstance(resp, web.Response)
    assert resp.content_type == "image/jpeg"


async def test_ws_poster_image_ok(monkeypatch):
    """Normal path: image bytes are served unchanged."""
    payload = b"\x00\x01\x02\x03"
    monkeypatch.setattr(
        webrtc,
        "_get_image_from_entity_id",
        lambda hass, poster: _fake_image_entity(payload),
    )

    resp = await ws_poster(MagicMock(), {"poster": "image.doorbell"})

    assert isinstance(resp, web.Response)
    assert resp.body == payload
    assert resp.content_type == "image/jpeg"
