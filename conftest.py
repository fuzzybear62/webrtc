"""Root conftest.

Its presence puts the repo root on sys.path so tests can `import
custom_components.webrtc`. pytest-homeassistant-custom-component supplies the
Home Assistant test harness (matched HA pin, asyncio config); our tests use plain
imports plus aiohttp's make_mocked_request, so no extra fixtures are needed here.
"""
