import io
import logging
import os
import platform
import re
import stat
import subprocess
import zipfile
import asyncio
import time
from typing import Optional
from urllib.parse import urljoin

import aiohttp
import jwt
from aiohttp import web
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http.auth import DATA_SIGN_SECRET, SIGN_QUERY_PARAM
from homeassistant.components.lovelace.resources import ResourceStorageCollection
from homeassistant.const import MAJOR_VERSION, MINOR_VERSION
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_component import DATA_INSTANCES

_LOGGER = logging.getLogger(__name__)

DOMAIN = "webrtc"

BINARY_VERSION = "1.9.14"

SYSTEM = {
    "Windows": {"AMD64": "go2rtc_win64.zip", "ARM64": "go2rtc_win_arm64.zip"},
    "Darwin": {"x86_64": "go2rtc_mac_amd64.zip", "arm64": "go2rtc_mac_arm64.zip"},
    "Linux": {
        "armv7l": "go2rtc_linux_arm",
        "armv8l": "go2rtc_linux_arm",  # https://github.com/AlexxIT/WebRTC/issues/18
        "aarch64": "go2rtc_linux_arm64",
        "x86_64": "go2rtc_linux_amd64",
        "i386": "go2rtc_linux_386",
        "i486": "go2rtc_linux_386",
        "i586": "go2rtc_linux_386",
        "i686": "go2rtc_linux_386",
    },
}

DEFAULT_URL = "http://127.0.0.1:1984/"

BINARY_NAME = re.compile(
    r"^(go2rtc-\d\.\d\.\d+|go2rtc_v0\.1-rc\.[5-9]|rtsp2webrtc_v[1-5])(\.exe)?$"
)


def get_arch() -> Optional[str]:
    system = SYSTEM.get(platform.system())
    if not system:
        return None
    return system.get(platform.machine())


def unzip(content: bytes) -> bytes:
    with zipfile.ZipFile(io.BytesIO(content)) as zf:
        for filename in zf.namelist():
            with zf.open(filename) as f:
                return f.read()


async def validate_binary(hass: HomeAssistant) -> Optional[str]:
    filename = f"go2rtc-{BINARY_VERSION}"
    if platform.system() == "Windows":
        filename += ".exe"

    filename = hass.config.path(filename)
    
    try:
        if os.path.isfile(filename):
            version_check = await hass.async_add_executor_job(
                subprocess.check_output, [filename, "-v"]
            )
            if version_check.startswith(b"go2rtc"):
                return filename
    except Exception:
        pass

    for file in await hass.async_add_executor_job(os.listdir, hass.config.config_dir):
        if BINARY_NAME.match(file):
            _LOGGER.debug(f"Remove old binary: {file}")
            await hass.async_add_executor_job(os.remove, hass.config.path(file))

    url = (
        f"https://github.com/AlexxIT/go2rtc/releases/download/"
        f"v{BINARY_VERSION}/{get_arch()}"
    )
    _LOGGER.debug(f"Download new binary: {url}")
    
    session = async_get_clientsession(hass)
    try:
        async with session.get(url) as r:
            if not r.ok:
                return None
            raw = await r.read()
    except Exception as e:
        _LOGGER.error(f"Download failed: {e}")
        return None

    if url.endswith(".zip"):
        raw = await hass.async_add_executor_job(unzip, raw)

    def save_file():
        with open(filename, "wb") as f:
            f.write(raw)
        os.chmod(filename, os.stat(filename).st_mode | stat.S_IEXEC)

    await hass.async_add_executor_job(save_file)

    return filename


async def register_static_path(hass: HomeAssistant, url_path: str, path: str):
    if (MAJOR_VERSION, MINOR_VERSION) >= (2024, 7):
        from homeassistant.components.http import StaticPathConfig

        await hass.http.async_register_static_paths(
            [StaticPathConfig(url_path, path, True)]
        )
    else:
        hass.http.register_static_path(url_path, path)


async def init_resource(hass: HomeAssistant, url: str, ver: str) -> bool:
    lovelace = hass.data["lovelace"]
    resources: ResourceStorageCollection = (
        lovelace.resources if hasattr(lovelace, "resources") else lovelace["resources"]
    )

    await resources.async_get_info()

    url2 = f"{url}?v={ver}"

    for item in resources.async_items():
        if not item.get("url", "").startswith(url):
            continue

        if item["url"].endswith(ver):
            return False

        _LOGGER.debug(f"Update lovelace resource to: {url2}")

        if isinstance(resources, ResourceStorageCollection):
            await resources.async_update_item(
                item["id"], {"res_type": "module", "url": url2}
            )
        else:
            item["url"] = url2

        return True

    if isinstance(resources, ResourceStorageCollection):
        _LOGGER.debug(f"Add new lovelace resource: {url2}")
        await resources.async_create_item({"res_type": "module", "url": url2})
    else:
        _LOGGER.debug(f"Add extra JS module: {url2}")
        add_extra_js_url(hass, url2)

    return True


# noinspection PyProtectedMember
def dash_cast(hass: HomeAssistant, entities: list, url: str, force: bool):
    try:
        for entity in hass.data[DATA_INSTANCES]["media_player"].entities:
            if entity.entity_id not in entities or not hasattr(entity, "_chromecast"):
                continue

            if not hasattr(entity, "dashcast"):
                from pychromecast.controllers.dashcast import DashCastController

                entity.dashcast = DashCastController()
                entity._chromecast.register_handler(entity.dashcast)

            _LOGGER.debug(f"DashCast to {entity.entity_id}")
            entity.dashcast.load_url(url, force=force)

    except Exception as e:
        _LOGGER.error(f"Can't DashCast to {entities}", exc_info=e)


def validate_signed_request(request: web.Request) -> bool:
    try:
        hass = request.app["hass"]
        secret = hass.data.get(DATA_SIGN_SECRET)
        signature = request.query.get(SIGN_QUERY_PARAM)
        claims = jwt.decode(signature, secret, algorithms=["HS256"])
        return claims["path"] == request.path
    except Exception:
        return False


async def check_go2rtc(hass: HomeAssistant, url: str = DEFAULT_URL) -> Optional[str]:
    session = async_get_clientsession(hass)
    try:
        r = await session.head(url, timeout=2, allow_redirects=False)
        return url if r.status < 300 else None
    except Exception:
        return None


def api_streams(hass: HomeAssistant) -> str:
    entry = hass.data[DOMAIN]
    go_url = "http://localhost:1984/" if isinstance(entry, Server) else entry
    return urljoin(go_url, "api/streams")


async def websocket_forward(ws_from, ws_to) -> None:
    t_start = time.perf_counter()
    bytes_count = 0
    try:
        async for msg in ws_from:
            if msg.type is aiohttp.WSMsgType.TEXT:
                await ws_to.send_str(msg.data)
                bytes_count += len(msg.data)
            elif msg.type is aiohttp.WSMsgType.BINARY:
                await ws_to.send_bytes(msg.data)
                bytes_count += len(msg.data)
            elif msg.type is aiohttp.WSMsgType.PING:
                await ws_to.ping()
            elif msg.type is aiohttp.WSMsgType.PONG:
                await ws_to.pong()
            # FIX: Explicitly handle CLOSE and ERROR to break the loop
            # This ensures the 'finally' block in __init__.py is executed,
            # clearing the session from the sensor.
            elif msg.type is aiohttp.WSMsgType.CLOSE:
                await ws_to.close()
                break
            elif msg.type is aiohttp.WSMsgType.ERROR:
                break
            
            if ws_to.closed:
                break
    except Exception as e:
        _LOGGER.debug(f"WebSocket forward exception: {repr(e)}")
    finally:
        duration = time.perf_counter() - t_start
        rate = (bytes_count / duration / 1024) if duration > 0 else 0
        _LOGGER.debug(
            f"[BENCHMARK] Channel Closed | Duration: {duration:.2f}s | Bytes: {bytes_count} | Rate: {rate:.2f} KB/s"
        )


class Server:
    def __init__(self, binary: str, hass: HomeAssistant = None):
        self.binary = binary
        self.hass = hass  # Need HASS instance to find config path
        self.process = None
        self._task = None
        self._shutdown = False

    @property
    def available(self):
        return self.process is not None and self.process.returncode is None

    def start(self):
        if self._task:
            return
        self._shutdown = False
        self._task = asyncio.create_task(self._run())

    async def _run(self):
        while self.binary and not self._shutdown:
            try:
                # 1. Base command: bind API to localhost
                cmd = [self.binary, "-c", '{"api": {"listen": "127.0.0.1:1984"}}']
                
                # 2. Append existing config file if present to load streams
                if self.hass:
                    config_file = self.hass.config.path("go2rtc.yaml")
                    if os.path.isfile(config_file):
                        cmd.extend(["-c", config_file])

                _LOGGER.debug(f"Starting go2rtc: {cmd}")
                
                self.process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.STDOUT
                )

                while self.process.returncode is None:
                    line = await self.process.stdout.readline()
                    if line == b"":
                        break
                    _LOGGER.debug(f"[go2rtc] {line[:-1].decode().strip()}")
                
                await self.process.wait()
                
                if not self._shutdown:
                    _LOGGER.error(f"go2rtc process exited unexpectedly (code {self.process.returncode}). Restarting in 5s...")
                    await asyncio.sleep(5)
                    
            except Exception as e:
                _LOGGER.error(f"Server crash: {e}")
                await asyncio.sleep(5)

    def stop(self, *args):
        self._shutdown = True
        self.binary = None
        if self.process and self.process.returncode is None:
            try:
                self.process.terminate()
            except ProcessLookupError:
                pass
        if self._task:
            self._task.cancel()