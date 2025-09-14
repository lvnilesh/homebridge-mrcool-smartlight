# Changelog

All notable changes to this project will be documented in this file. The format is inspired by Keep a Changelog and Semantic Versioning.

## [0.1.0] - 2025-09-14
### Added
- Initial public preview.
- SSE event subscription with automatic reconnect.
- Thermostat service (OFF / HEAT / COOL / AUTO) with 0.5°C step.
- Outdoor temperature sensor.
- Humidity reporting (if provided by device climate state).
- Beeper on/off switch + optional autoDisableBeeper.
- Differential debounced command sender & acknowledgement timeout warnings.
- Detailed debug logging (raw climate payload + mapped state, state id enumeration, missing climate warning).
- Optional experimental preset & swing switches (device currently ignores commands).

### Removed
- Display Toggle and Swing Step button services (no observable device effect).

### Notes
- Preset & swing retained as optional for future firmware support.
- Future roadmap: fan speed granularity, multi-unit discovery, config schema publication.
