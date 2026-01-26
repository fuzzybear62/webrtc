import logging
from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .utils import DOMAIN
from . import SESSIONS

_LOGGER = logging.getLogger(__name__)

async def async_setup_entry(
    hass: HomeAssistant,
    config_entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up the WebRTC connections sensor."""
    async_add_entities([WebRTCConnectionSensor(hass)])


class WebRTCConnectionSensor(SensorEntity):
    """Sensor that reports active WebRTC sessions."""

    _attr_has_entity_name = True
    _attr_name = "Active Connections"
    _attr_unique_id = "webrtc_active_connections"
    _attr_icon = "mdi:lan-connect"
    _attr_native_unit_of_measurement = "clients"

    def __init__(self, hass: HomeAssistant):
        self.hass = hass
        self._attr_extra_state_attributes = {}

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