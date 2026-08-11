import asyncio
import logging
import time
import uuid
from pathlib import Path
from urllib.parse import urlencode, urljoin

import jwt
import voluptuous as vol
from aiohttp import web
from aiohttp.web_exceptions import HTTPUnauthorized, HTTPGone, HTTPNotFound
from homeassistant.components.camera import async_get_stream_source, async_get_image
from homeassistant.components.http import HomeAssistantView
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_ENTITY_ID, CONF_URL, EVENT_HOMEASSISTANT_STOP, Platform
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.network import get_url
from homeassistant.helpers.template import Template

from . import utils
from .utils import DOMAIN, Server

_LOGGER = logging.getLogger(__name__)

CREATE_LINK_SCHEMA = vol.Schema(
    {
        vol.Required("link_id"): cv.string,
        vol.Exclusive("url", "url"): cv.string,
        vol.Exclusive("entity", "url"): cv.entity_id,
        vol.Optional("open_limit", default=1): cv.positive_int,
        vol.Optional("time_to_live", default=60): cv.positive_int,
    },
    required=True,
)

DASH_CAST_SCHEMA = vol.Schema(
    {
        vol.Required(ATTR_ENTITY_ID): cv.entity_ids,
        vol.Exclusive("url", "url"): cv.string,
        vol.Exclusive("entity", "url"): cv.entity_id,
        vol.Optional("extra"): dict,
        vol.Optional("force", default=False): bool,
        vol.Optional("hass_url"): str,
    },
    required=True,
)

LINKS = {}
# Active proxy connections, split by role (both exposed via the sensor platform):
#   CLIENT_SESSIONS = real viewer streams (main drivers) — media proxied over the ws.
#   SHADOW_SESSIONS = background WebRTC upgrade probes (shadow drivers) — signalling only.
# A camera on WebRTC contributes 0 to either (its ws is handed off; media is P2P).
CLIENT_SESSIONS = {}
SHADOW_SESSIONS = {}

HLS_COOKIE = "webrtc-hls-session"
HLS_SESSION = str(uuid.uuid4())


async def async_setup(hass: HomeAssistant, config: dict):
    path = Path(__file__).parent / "www"
    for name in ("video-rtc.js", "webrtc-camera.js", "digital-ptz.js", "ui-interaction.js"):
        await utils.register_static_path(hass, "/webrtc/" + name, str(path / name))

    version = getattr(hass.data["integrations"][DOMAIN], "version", 0)
    await utils.init_resource(hass, "/webrtc/webrtc-camera.js", str(version))

    await utils.register_static_path(hass, "/webrtc/embed", str(path / "embed.html"))

    hass.http.register_view(WebSocketView)
    hass.http.register_view(HLSView)

    async def create_link(call: ServiceCall):
        link_id = call.data["link_id"]
        ttl = call.data["time_to_live"]
        LINKS[link_id] = {
            "url": call.data.get("url"),
            "entity": call.data.get("entity"),
            "limit": call.data["open_limit"],
            "ts": time.time() + ttl if ttl else 0,
        }

    async def dash_cast(call: ServiceCall):
        link_id = uuid.uuid4().hex
        LINKS[link_id] = {
            "url": call.data.get("url"),
            "entity": call.data.get("entity"),
            "limit": 1,
            "ts": time.time() + 30,
        }

        hass_url = call.data.get("hass_url") or get_url(hass)
        query = call.data.get("extra", {})
        query["url"] = link_id
        cast_url = hass_url + "/webrtc/embed?" + urlencode(query)

        _LOGGER.debug(f"dash_cast: {cast_url}")

        await hass.async_add_executor_job(
            utils.dash_cast,
            hass,
            call.data[ATTR_ENTITY_ID],
            cast_url,
            call.data.get("force", False),
        )

    hass.services.async_register(DOMAIN, "create_link", create_link, CREATE_LINK_SCHEMA)
    hass.services.async_register(DOMAIN, "dash_cast", dash_cast, DASH_CAST_SCHEMA)

    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry):
    go_url = entry.data.get(CONF_URL)

    if not go_url:
        go_url = await utils.check_go2rtc(hass)

    if go_url:
        hass.data[DOMAIN] = go_url
        return True

    binary = await utils.validate_binary(hass)
    if not binary:
        return False

    # PASSING HASS INSTANCE TO SERVER CLASS TO LOCATE CONFIG FILE
    hass.data[DOMAIN] = server = Server(binary, hass)
    server.start()

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STOP, server.stop)

    # Load sensor platform to expose active sessions
    await hass.config_entries.async_forward_entry_setups(entry, [Platform.SENSOR])

    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry):
    server = hass.data[DOMAIN]
    if isinstance(server, Server):
        server.stop()
    return True


async def ws_connect(hass: HomeAssistant, params: dict) -> str:
    server: str = params.get("server")
    if not server:
        server: str | Server = hass.data[DOMAIN]
    if isinstance(server, Server):
        assert server.available, "WebRTC server not available"
        server = "http://localhost:1984/"

    if entity_id := params.get("entity"):
        src = await async_get_stream_source(hass, entity_id)
        if src is None:
            if state := hass.states.get(entity_id):
                if token := state.attributes.get("access_token"):
                    src = f"{get_url(hass)}/api/camera_proxy_stream/{entity_id}?token={token}"
        assert src, f"Can't get URL for {entity_id}"
        query = {"src": src, "name": entity_id}
    elif src := params.get("url"):
        if "{{" in src or "{%" in src:
            src = Template(src, hass).async_render()
        query = {"src": src}
    else:
        raise Exception("Missing url or entity")

    return urljoin("ws" + server[4:], "api/ws") + "?" + urlencode(query)


def _get_image_from_entity_id(hass: HomeAssistant, entity_id: str):
    if (component := hass.data.get("image")) is None:
        raise Exception("Image integration not set up")

    if (image := component.get_entity(entity_id)) is None:
        raise Exception("Image not found")

    return image


async def ws_poster(hass: HomeAssistant, params: dict) -> web.Response:
    poster: str = params["poster"]

    if "{{" in poster or "{%" in poster:
        poster = Template(poster, hass).async_render()

    if poster.startswith("camera."):
        image = await async_get_image(hass, poster)
        return web.Response(body=image.content, content_type=image.content_type)

    if poster.startswith("image."):
        image_entity = _get_image_from_entity_id(hass, poster)
        image = await image_entity.async_image()
        _LOGGER.debug(f"webrtc image_entity: {image_entity} - {len(image)}")
        return web.Response(body=image, content_type="image/jpeg")

    entry = hass.data[DOMAIN]
    url = "http://localhost:1984/" if isinstance(entry, Server) else entry
    url = urljoin(url, "api/frame.jpeg") + "?" + urlencode({"src": poster})

    async with async_get_clientsession(hass).get(url) as r:
        body = await r.read()
        return web.Response(body=body, content_type=r.content_type)


class WebSocketView(HomeAssistantView):
    url = "/api/webrtc/ws"
    name = "api:webrtc:ws"
    requires_auth = False

    async def get(self, request: web.Request):
        t_start = time.perf_counter()

        params = request.query
        # [TRACE] Capture client_id from JS for logging correlation
        client_id = params.get("client_id", "unknown")
        # Role marks upgrade probes ("shadow") vs real viewer streams (everything else).
        # Signalling-only shadow drivers must be counted separately from real clients.
        is_shadow = request.query.get("role") == "shadow"
        registry = SHADOW_SESSIONS if is_shadow else CLIENT_SESSIONS
        _LOGGER.debug(f"[{client_id}] New client connection request: {dict(params)}")

        if request.query.get("embed"):
            link_id = request.query.get("url")
            if link_id not in LINKS:
                raise HTTPNotFound()

            link = LINKS[link_id]
            if link["ts"] and time.time() > link["ts"]:
                LINKS.pop(link_id)
                raise HTTPGone()

            if link["limit"]:
                link["limit"] -= 1
                if link["limit"] == 0:
                    LINKS.pop(link_id)

            params = link

        elif not utils.validate_signed_request(request):
            raise HTTPUnauthorized()

        hass = request.app["hass"]

        if "poster" in params:
            return await ws_poster(hass, params)

        # FIX: Added heartbeat=30 to kill zombie connections that fail to send FIN packet
        ws_server = web.WebSocketResponse(autoclose=False, autoping=False, heartbeat=30)
        ws_server.set_cookie(HLS_COOKIE, HLS_SESSION)
        await ws_server.prepare(request)

        # Session tracking variables
        session_id = uuid.uuid4().hex
        remote_ip = request.headers.get("X-Forwarded-For")
        remote_ip = remote_ip + ", " + request.remote if remote_ip else request.remote
        
        # Decode JWT to get expiration (without verifying signature again)
        token_expires = 0
        try:
            if auth_sig := request.query.get("authSig"):
                # Decode only payload, signature already validated by validate_signed_request
                payload = jwt.decode(auth_sig, options={"verify_signature": False})
                token_expires = payload.get("exp", 0)
        except Exception:
            pass

        # Track active tasks to cancel them later
        tasks = []

        try:
            url = await ws_connect(hass, params)

            handshake_ms = (time.perf_counter() - t_start) * 1000
            
            # Register Session in the role-appropriate registry
            registry[session_id] = {
                "client_id": client_id, # Store for sensor inspection
                "entity_id": params.get("entity") or params.get("url"),
                "client_ip": remote_ip,
                "user_agent": request.headers.get("User-Agent"),
                "connected_at": time.time(),
                "expires_at": token_expires
            }
            # Notify sensor to update
            async_dispatcher_send(hass, "webrtc_sessions_updated")

            _LOGGER.debug(
                f"[{client_id}] {'Shadow' if is_shadow else 'Client'}: {remote_ip} | "
                f"Handshake: {handshake_ms:.2f}ms | "
                f"Clients: {len(CLIENT_SESSIONS)} Shadows: {len(SHADOW_SESSIONS)}"
            )

            async with async_get_clientsession(hass).ws_connect(
                url,
                autoclose=False,
                autoping=False,
                heartbeat=30,
                headers={
                    "User-Agent": request.headers.get("User-Agent"),
                    "X-Forwarded-For": remote_ip,
                    "X-Forwarded-Host": request.host,
                    "X-Forwarded-Proto": request.scheme,
                },
            ) as ws_client:
                
                # Create Tasks
                task1 = asyncio.create_task(utils.websocket_forward(ws_server, ws_client))
                task2 = asyncio.create_task(utils.websocket_forward(ws_client, ws_server))
                tasks = [task1, task2]
                
                # Wait for FIRST completion (e.g., Browser closes connection)
                await asyncio.wait(
                    tasks,
                    return_when=asyncio.FIRST_COMPLETED,
                )

        except Exception as e:
            _LOGGER.warning(f"[{client_id}] Stream error: {e}")
            await ws_server.send_json({"type": "error", "value": str(e)})

        finally:
            # [CRITICAL FIX] Explicitly cancel pending tasks.
            # Without this, the 'other' direction might keep running, keeping the session alive.
            for task in tasks:
                if not task.done():
                    task.cancel()
            
            # Wait for cancellations to finalize (prevents asyncio warnings)
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

            if session_id in registry:
                registry.pop(session_id)
                # Notify sensor to update
                async_dispatcher_send(hass, "webrtc_sessions_updated")

            _LOGGER.debug(
                f"[{client_id}] {'Shadow' if is_shadow else 'Stream'} ended. "
                f"Remaining — Clients: {len(CLIENT_SESSIONS)} Shadows: {len(SHADOW_SESSIONS)}"
            )

        return ws_server


class HLSView(HomeAssistantView):
    url = "/api/webrtc/hls/{filename}"
    name = "api:webrtc:hls"
    requires_auth = False

    async def get(self, request: web.Request, filename: str):
        if request.cookies.get(HLS_COOKIE) != HLS_SESSION:
            raise HTTPUnauthorized()

        if filename not in ("playlist.m3u8", "init.mp4", "segment.m4s", "segment.ts"):
            raise HTTPNotFound()

        hass: HomeAssistant = request.app["hass"]
        entry = hass.data[DOMAIN]
        url = "http://localhost:1984/" if isinstance(entry, Server) else entry
        url = urljoin(url, "api/hls/" + filename) + "?" + request.query_string

        async with async_get_clientsession(hass).get(url) as r:
            if not r.ok:
                raise HTTPNotFound()

            body = await r.read()
            return web.Response(body=body, content_type=r.content_type)