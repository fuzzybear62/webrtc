"""Behavioral tests for the 401 -> 403 auth-rejection fix (upstream PR #956).

Invalid/expired stream signatures and stale HLS cookies must be rejected with
HTTPForbidden (403), not HTTPUnauthorized (401). HA's ban middleware counts every
401 as a failed login and IP-bans the client after login_attempts_threshold; the
fork's aggressive reconnection (shadow + reprobe + teardown-recreate) makes a
sleeping tab that wakes with an expired signature self-ban. 403 still denies the
stream without touching the login-ban counter.

The tests exercise the reject path in isolation via aiohttp's make_mocked_request;
they do not need a running go2rtc or a valid JWT, only the rejection branch.
"""

import pytest
from aiohttp.test_utils import make_mocked_request
from aiohttp.web_exceptions import HTTPForbidden

from custom_components.webrtc import HLSView, WebSocketView, HLS_COOKIE
from custom_components.webrtc import utils


async def test_ws_invalid_signature_returns_403(monkeypatch):
    """An invalid signed request is rejected with 403, not 401."""
    monkeypatch.setattr(utils, "validate_signed_request", lambda request: False)

    # No `embed` query param -> flow reaches the signature check.
    req = make_mocked_request("GET", "/api/webrtc/ws?client_id=t")

    with pytest.raises(HTTPForbidden) as exc:
        await WebSocketView().get(req)

    # Regression guard: must be 403 (Forbidden), never 401 (Unauthorized).
    assert exc.value.status == 403


async def test_hls_bad_cookie_returns_403():
    """A missing/stale HLS session cookie is rejected with 403, not 401."""
    req = make_mocked_request("GET", "/api/webrtc/hls/playlist.m3u8")

    with pytest.raises(HTTPForbidden) as exc:
        await HLSView().get(req, "playlist.m3u8")

    assert exc.value.status == 403


async def test_hls_valid_cookie_passes_auth_gate(monkeypatch):
    """A correct HLS cookie passes the auth gate (proves 403 is not blanket).

    We stop right after the auth check by requesting an unknown filename, which
    raises HTTPNotFound -- distinct from HTTPForbidden, so we know the cookie was
    accepted.
    """
    from custom_components.webrtc import HLS_SESSION
    from aiohttp.web_exceptions import HTTPNotFound

    req = make_mocked_request(
        "GET",
        "/api/webrtc/hls/nope.txt",
        headers={"Cookie": f"{HLS_COOKIE}={HLS_SESSION}"},
    )

    with pytest.raises(HTTPNotFound):
        await HLSView().get(req, "nope.txt")
