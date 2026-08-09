# tools

Standalone maintenance/validation utilities. These are **not** part of the Home
Assistant integration and are not collected by pytest.

## `rtc_phase_check.py`

Validates the WebRTC driver RTC phase machine (driver ≥ v2.3.5, the explicit
`_rtcPhase` state machine) against an exported browser-console log.

Checks:

- **#3 FSM grammar** — every `RTC phase A -> B` edge is legal and chains without desync.
- **#4 per-camera lifecycle** — reports each disposable driver's outcome
  (`COMMITTED` / `REVERTED` / `REJECTED` / `no-rtc`) with its phase sequence.
- **#5 legacy canary** — the removed dead-path markers (`handing off`,
  `Mode: RTC (Socket Closing)`) must never appear.

Usage:

```bash
python3 tools/rtc_phase_check.py <logfile> [<logfile> ...]
```

Exit code `0` = all PASS, `1` = at least one FAIL (illegal edge, phase desync, or
legacy marker), with the offending line reported. Warnings do not fail the run.
