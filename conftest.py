"""Root conftest.

Its presence puts the repo root on sys.path so tests can `import
custom_components.webrtc`. pytest-homeassistant-custom-component supplies the
Home Assistant test harness (matched HA pin, asyncio config); our tests use plain
imports plus aiohttp's make_mocked_request, so no extra fixtures are needed here.

Importing custom_components.webrtc pulls in homeassistant.components.camera, whose
img_util does `from turbojpeg import TurboJPEG` at import time. PyTurboJPEG wraps a
native C library (libturbojpeg) that is present on a real HA install but not on a
bare CI runner, so the import would fail during collection. We never touch JPEG
turbo in these tests, so we register a minimal stub module before anything imports
the camera component.
"""

import sys
import types

if "turbojpeg" not in sys.modules:

    class _TurboJPEGModule(types.ModuleType):
        # img_util may reference module-level constants (TJPF_*, TJSAMP_*) beyond
        # the TurboJPEG class; hand back a harmless placeholder for anything.
        def __getattr__(self, name):
            if name == "TurboJPEG":
                return _TurboJPEG
            return 0

    class _TurboJPEG:  # stand-in for the native binding
        def __init__(self, *args, **kwargs):
            pass

    sys.modules["turbojpeg"] = _TurboJPEGModule("turbojpeg")
