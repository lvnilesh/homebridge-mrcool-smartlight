## homebridge-mrcool-smartlight

Homebridge plugin providing local (cloud‑independent) control of a MrCool HVAC unit through the SMARTLIGHT SLWF‑01 Pro Wi‑Fi module using its Server‑Sent Events (SSE) event stream and simple HTTP command endpoints.

> Status: Early preview. Core thermostat + outdoor temperature + beeper work reliably. Preset / swing features are exposed optionally but the device currently ignores those commands. Removed non‑functional Display / Swing Step buttons to keep the UI clean.

### Working Today
* Thermostat: OFF / HEAT / COOL / AUTO (HEAT_COOL) + current & target temperature (16–30°C, 0.5° steps)
* Current relative humidity (if provided by climate entity)
* Outdoor temperature sensor (separate TemperatureSensor)
* Beeper on/off switch (stateful)
* Differential, debounced command sending with acknowledgement timeout
* Robust SSE subscription with automatic reconnect + missing‑climate warning
* Detailed debug logging (raw climate payload, mapped state, every SSE state id)

### Optional / Experimental
* Preset switches (BOOST / ECO / SLEEP) – device accepts HTTP 200 but no observable effect
* Swing mode switch (BOTH / OFF) – currently not reflected by SSE (likely ignored)
* Fan Only & Dry “modes” (implemented as helper switches mapping to internal state logic)

### Removed (No observable effect)
* Display Toggle button
* Swing Step button

---

## Installation

### Via Homebridge UI (recommended)
When published to npm (e.g. `homebridge-mrcool-smartlight`):
1. Open Homebridge UI -> Plugins.
2. Search for `mrcool smartlight`.
3. Install and configure.

### Manual / Local (development)
```bash
git clone https://github.com/your-user/homebridge-mrcool-smartlight.git
cd homebridge-mrcool-smartlight
npm install
npm run build
npm link      # optional: makes it available globally
homebridge -D # start Homebridge and test
```

Or inside your existing mapped custom-plugins folder (Docker):
```bash
docker exec -it homebridge bash
cd /homebridge/custom-plugins/homebridge-mrcool-smartlight
npm install
npm run build
```

---
## Configuration (config.json)

Minimal:
```json
{
  "accessory": "MrCoolSmartLight",
  "name": "MrCool HVAC",
  "ip": "192.168.40.149",
  "mac": "f8:b3:b7:8a:d6:b8"
}
```

Extended (with options):
```json
{
  "accessory": "MrCoolSmartLight",
  "name": "MrCool HVAC",
  "ip": "192.168.40.149",
  "mac": "f8:b3:b7:8a:d6:b8",
  "commandDebounceMs": 450,
  "ackTimeoutMs": 5000,
  "autoDisableBeeper": true,
  "enablePresets": false,
  "enableSwing": false,
  "enableFanOnly": false,
  "enableDryMode": false,
  "debug": true
}
```

### Option Reference
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `ip` | string | (required) | IPv4/host of the SMARTLIGHT module. |
| `mac` | string | (recommended) | MAC used for stable UUID (prevents accessory duplication). |
| `commandDebounceMs` | number | 450 | Merge rapid HomeKit changes before sending to device. |
| `ackTimeoutMs` | number | 5000 | Warn if SSE doesn’t reflect sent change within this window. |
| `autoDisableBeeper` | boolean | false | Automatically turns beeper off after connecting. |
| `enablePresets` | boolean | false | Expose preset switches (experimental; device ignores). |
| `enableSwing` | boolean | false | Expose swing BOTH/OFF switch (experimental; ignored). |
| `enableFanOnly` | boolean | false | Expose Fan Only helper switch (maps to target state logic). |
| `enableDryMode` | boolean | false | Expose Dry helper switch. |
| `debug` | boolean | false | Verbose internal & raw SSE logging. |

---
## How It Works
* Subscribes to `/events` SSE endpoint; parses climate, sensor, and switch state ids.
* Maintains internal cached state; reconciles HomeKit commands vs. device reports.
* Sends updates via `POST /climate/<id>/set?mode=...&target_temperature=...` (only when changed).
* Beeper switch maps to `/switch/air_conditioner_beeper/(turn_on|turn_off)`.
* Optional commands for presets/swing are issued but currently produce no state change.

If the module firmware begins honoring ignored parameters, the exposed optional switches will immediately become useful without code changes.

---
## Known Limitations
* No fan speed granularity (only implicit via thermostat modes).
* Preset & swing currently inert (device returns HTTP 200 without state mutation).
* No caching across restarts beyond what HomeKit retains.
* Single-unit support per accessory instance (add multiple accessories for multiple units).

---
## Troubleshooting
| Symptom | Suggestion |
|---------|------------|
| Thermostat stuck / no updates | Enable `debug`, restart, confirm climate SSE events appear. |
| Commands delayed | Lower `commandDebounceMs` (e.g. 200) but keep >150ms to avoid floods. |
| Ack timeout warnings | Verify device actually changed; network latency; increase `ackTimeoutMs`. |
| Duplicate accessories | Ensure `mac` is set and stable. Remove cached accessory from Homebridge UI. |

---
## Development
Scripts:
```bash
npm run build   # compile TypeScript
npm run watch   # incremental build
npm pack        # preview package tarball
```

The build emits JavaScript + declarations into `dist/` (only contents published). Use `npm run pack:check` to review included files before publishing.

---
## Publishing (Maintainers)
1. Update version in `package.json` (semver).
2. Update `CHANGELOG.md`.
3. `npm run build` & `npm run pack:check`.
4. `npm publish` (ensure you are logged in and have 2FA if required).
5. Create a Git tag: `git tag vX.Y.Z && git push origin vX.Y.Z`.

---
## Security
This plugin performs only local HTTP(S) calls to the configured IP. No data leaves your network unless your Homebridge instance uploads logs elsewhere.

---
## License
MIT — see `LICENSE` file.

---
## Changelog (Excerpt)
See full details in `CHANGELOG.md`.

### 0.1.0
* Initial public preview: core thermostat, outdoor temperature, beeper, SSE integration, optional experimental switches.

