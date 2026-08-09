import logging
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.entity import DeviceInfo

from .utils import DOMAIN
from . import CLIENT_SESSIONS, SHADOW_SESSIONS

_LOGGER = logging.getLogger(__name__)

async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the WebRTC connection sensors."""
    # We pass the entry_id to link the sensors to the specific integration instance
    async_add_entities([
        WebRTCConnectionSensor(hass, config_entry.entry_id),
        WebRTCShadowSensor(hass, config_entry.entry_id),
    ])


class _WebRTCSessionSensor(SensorEntity):
    """Base sensor that reports the size of a session registry."""

    _attr_has_entity_name = True
    _attr_native_unit_of_measurement = "clients"

    # Subclasses set these.
    _registry: dict = {}

    def __init__(self, hass: HomeAssistant, entry_id: str):
        self.hass = hass
        self._attr_extra_state_attributes = {}

        # LINK TO DEVICE REGISTRY
        # This ensures the sensor appears under the "WebRTC Camera" device
        # and not as an orphan entity.
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, entry_id)},
            name="WebRTC Camera",
            manufacturer="Fuzzybear",
        )

    async def async_added_to_hass(self) -> None:
        """Register callbacks."""
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, "webrtc_sessions_updated", self._update_data
            )
        )
        self._update_data()

    @callback
    def _update_data(self) -> None:
        """Update sensor state and attributes from this sensor's registry."""
        count = len(self._registry)
        self._attr_native_value = count

        # Convert the dict to a list for easier dashboard rendering
        session_list = [
            {"session_id": session_id, **data}
            for session_id, data in self._registry.items()
        ]

        self._attr_extra_state_attributes = {
            "total_streams": count,
            "sessions": session_list,
        }

        self.async_write_ha_state()


class WebRTCConnectionSensor(_WebRTCSessionSensor):
    """Real viewer streams proxied over the ws (main drivers on MSE)."""

    _attr_translation_key = "proxied_connections"
    _attr_unique_id = "webrtc_proxied_connections"
    _attr_icon = "mdi:lan-connect"
    _registry = CLIENT_SESSIONS


class WebRTCShadowSensor(_WebRTCSessionSensor):
    """Background WebRTC upgrade probes (shadow drivers) — diagnostic."""

    _attr_translation_key = "shadow_probes"
    _attr_unique_id = "webrtc_shadow_probes"
    _attr_icon = "mdi:radar"
    _attr_entity_registry_enabled_default = True
    _registry = SHADOW_SESSIONS