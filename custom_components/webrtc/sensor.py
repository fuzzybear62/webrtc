import logging
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.entity import DeviceInfo

from .utils import DOMAIN
from . import SESSIONS

_LOGGER = logging.getLogger(__name__)

async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the WebRTC connections sensor."""
    # We pass the entry_id to link the sensor to the specific integration instance
    async_add_entities([WebRTCConnectionSensor(hass, config_entry.entry_id)])


class WebRTCConnectionSensor(SensorEntity):
    """Sensor that reports active WebRTC sessions."""

    _attr_has_entity_name = True
    # Replaced hardcoded name with translation key for I18n support
    _attr_translation_key = "proxied_connections"
    # Updated Unique ID to reflect the semantic change (Proxied/MSE clients)
    _attr_unique_id = "webrtc_proxied_connections"
    _attr_icon = "mdi:lan-connect"
    _attr_native_unit_of_measurement = "clients"

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
        """Update sensor state and attributes from the global registry."""
        # Update State (Count)
        count = len(SESSIONS)
        self._attr_native_value = count
        
        # Update Attributes (Detail list)
        # We convert the dict to a list for easier dashboard rendering
        session_list = []
        for session_id, data in SESSIONS.items():
            session_list.append({
                "session_id": session_id,
                **data
            })
            
        self._attr_extra_state_attributes = {
            "total_streams": count,
            "sessions": session_list
        }
        
        self.async_write_ha_state()