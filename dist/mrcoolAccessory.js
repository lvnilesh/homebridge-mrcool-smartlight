"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MrCoolSmartLightAccessory = void 0;
const axios_1 = __importDefault(require("axios"));
const eventsource_1 = __importDefault(require("eventsource"));
class MrCoolSmartLightAccessory {
    constructor(log, config, api) {
        this.presetSwitches = {};
        this.currentTemp = 22;
        this.targetTemp = 22;
        this.outdoorTemp = NaN;
        this.beeperOn = false;
        this.humidity = 45;
        this.internalMode = 'off';
        this.climateEntityId = null; // e.g. climate-air_conditioner
        this.pendingReconnectDelay = 5000;
        this.debounceMs = 450; // settle window for batching mode+temp
        this.ackTimeoutMs = 5000;
        this.currentPreset = 'NONE';
        this.currentSwingMode = 'OFF';
        this.log = log;
        this.config = config;
        this.api = api;
        this.hap = api.hap;
        if (!config.ip && !config.mock) {
            throw new Error('MrCoolSmartLight: ip is required unless mock=true');
        }
        this.currentState = this.hap.Characteristic.CurrentHeatingCoolingState.OFF;
        this.targetState = this.hap.Characteristic.TargetHeatingCoolingState.OFF;
        // Thermostat service
        this.thermostatService = new this.hap.Service.Thermostat(config.name);
        this.thermostatService.getCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState)
            .on('get', this.handleCurrentStateGet.bind(this));
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState)
            .on('get', this.handleTargetStateGet.bind(this))
            .on('set', this.handleTargetStateSet.bind(this));
        // Ensure AUTO is explicitly exposed (some Home apps hide it if props constrained elsewhere)
        const tState = this.hap.Characteristic.TargetHeatingCoolingState;
        this.thermostatService.getCharacteristic(tState).setProps({
            validValues: [tState.OFF, tState.HEAT, tState.COOL, tState.AUTO],
        });
        this.thermostatService.getCharacteristic(this.hap.Characteristic.CurrentTemperature)
            .on('get', this.handleCurrentTempGet.bind(this));
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetTemperature)
            .on('get', this.handleTargetTempGet.bind(this))
            .on('set', this.handleTargetTempSet.bind(this));
        // Device only accepts 0.5C steps and (from testing) roughly 16-30C range (reports 29.0 when set to 30 sometimes)
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TargetTemperature).setProps({
            minValue: 16,
            maxValue: 30,
            minStep: 0.5,
        });
        this.thermostatService.getCharacteristic(this.hap.Characteristic.TemperatureDisplayUnits)
            .on('get', (cb) => cb(null, this.hap.Characteristic.TemperatureDisplayUnits.CELSIUS));
        // Humidity (placeholder)
        this.humidityService = new this.hap.Service.HumiditySensor(config.name + ' Humidity');
        this.humidityService.getCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity)
            .on('get', (cb) => cb(null, this.humidity));
        // Outdoor temperature (TemperatureSensor). Created eagerly; updated when SSE provides value.
        this.outdoorTempService = new this.hap.Service.TemperatureSensor(config.name + ' Outdoor Temperature', 'outdoorTemp');
        this.outdoorTempService.getCharacteristic(this.hap.Characteristic.CurrentTemperature)
            .on('get', (cb) => cb(null, isNaN(this.outdoorTemp) ? 0 : this.outdoorTemp));
        // Beeper switch (stateful)
        this.beeperSwitch = new this.hap.Service.Switch(config.name + ' Beeper', 'beeper');
        this.beeperSwitch.getCharacteristic(this.hap.Characteristic.On)
            .on('get', (cb) => cb(null, this.beeperOn))
            .on('set', (value, cb) => {
            const on = !!value;
            this.sendBeeper(on).catch(err => this.debug('beeper set error', err));
            this.beeperOn = on; // optimistic
            if (this.beeperSwitch)
                this.beeperSwitch.updateCharacteristic(this.hap.Characteristic.On, this.beeperOn);
            cb(null);
        });
        // Fan-only switch
        if (config.enableFanOnly) {
            this.fanOnlySwitch = new this.hap.Service.Switch(config.name + ' Fan Only', 'fanOnly');
            this.fanOnlySwitch.getCharacteristic(this.hap.Characteristic.On)
                .on('get', (cb) => cb(null, this.internalMode === 'fan'))
                .on('set', (value, cb) => {
                const on = !!value;
                if (on) {
                    this.setInternalMode('fan');
                }
                else if (this.internalMode === 'fan') {
                    this.setInternalMode('off');
                }
                cb(null);
            });
        }
        // Dry mode switch
        if (config.enableDryMode) {
            this.dryModeSwitch = new this.hap.Service.Switch(config.name + ' Dry Mode', 'dryMode');
            this.dryModeSwitch.getCharacteristic(this.hap.Characteristic.On)
                .on('get', (cb) => cb(null, this.internalMode === 'dry'))
                .on('set', (value, cb) => {
                const on = !!value;
                if (on) {
                    this.setInternalMode('dry');
                }
                else if (this.internalMode === 'dry') {
                    this.setInternalMode('off');
                }
                cb(null);
            });
        }
        // Optional preset switches (BOOST / ECO / SLEEP) – experimental: device appears to ignore preset changes in testing.
        if (config.enablePresets) {
            ['BOOST', 'ECO', 'SLEEP'].forEach(preset => {
                const svc = new this.hap.Service.Switch(`${config.name} ${preset} Preset`, `preset-${preset}`);
                svc.getCharacteristic(this.hap.Characteristic.On)
                    .on('get', (cb) => cb(null, this.currentPreset === preset))
                    .on('set', (value, cb) => {
                    const on = !!value;
                    // Only one preset active; turning one on turns others off; turning off reverts to NONE
                    if (on) {
                        this.requestPreset(preset);
                    }
                    else if (this.currentPreset === preset) {
                        this.requestPreset('NONE');
                    }
                    cb(null);
                });
                this.presetSwitches[preset] = svc;
            });
        }
        // Optional swing switch toggles BOTH vs OFF (experimental; device ignored in testing)
        if (config.enableSwing) {
            this.swingSwitch = new this.hap.Service.Switch(`${config.name} Swing`, 'swing');
            this.swingSwitch.getCharacteristic(this.hap.Characteristic.On)
                .on('get', (cb) => cb(null, this.currentSwingMode === 'BOTH'))
                .on('set', (value, cb) => {
                const on = !!value;
                this.requestSwing(on ? 'BOTH' : 'OFF');
                cb(null);
            });
        }
        // Accessory info
        this.informationService = new this.hap.Service.AccessoryInformation()
            .setCharacteristic(this.hap.Characteristic.Manufacturer, 'MrCool')
            .setCharacteristic(this.hap.Characteristic.Model, 'SmartLight SLWF-01 Pro')
            .setCharacteristic(this.hap.Characteristic.SerialNumber, config.mac || 'Unknown');
        // Configurable debounce / ack timeouts
        if (typeof config.commandDebounceMs === 'number' && config.commandDebounceMs >= 100 && config.commandDebounceMs <= 5000) {
            this.debounceMs = config.commandDebounceMs;
        }
        if (typeof config.ackTimeoutMs === 'number' && config.ackTimeoutMs >= 500 && config.ackTimeoutMs <= 15000) {
            this.ackTimeoutMs = config.ackTimeoutMs;
        }
        if (this.config.mock) {
            const interval = (config.pollInterval || 30) * 1000;
            this.pollTimer = setInterval(() => this.pollStatus().catch(err => this.debug('Poll error', err)), interval);
            setTimeout(() => this.pollStatus().catch(() => undefined), 1000);
        }
        else {
            this.connectEventStream();
        }
    }
    // Debug logging disabled (stripped for production minimal logs)
    debug(..._msg) { }
    setInternalMode(mode) {
        this.internalMode = mode;
        this.debug('Set internal mode:', mode);
        // Sync thermostat target when relevant
        const t = this.hap.Characteristic.TargetHeatingCoolingState;
        switch (mode) {
            case 'cool':
                this.targetState = t.COOL;
                break;
            case 'heat':
                this.targetState = t.HEAT;
                break;
            case 'auto':
                this.targetState = t.AUTO;
                break;
            case 'off':
            case 'fan':
            case 'dry':
                this.targetState = t.OFF;
                break; // fan & dry not native -> OFF target
        }
        this.applyInternalModeToCurrent();
        this.scheduleSyncToDevice();
        this.updateCharacteristics();
    }
    applyInternalModeToCurrent() {
        const c = this.hap.Characteristic.CurrentHeatingCoolingState;
        switch (this.internalMode) {
            case 'cool':
                this.currentState = c.COOL;
                break;
            case 'heat':
                this.currentState = c.HEAT;
                break;
            case 'auto': // infer
                if (this.targetTemp < this.currentTemp - 0.3)
                    this.currentState = c.COOL;
                else if (this.targetTemp > this.currentTemp + 0.3)
                    this.currentState = c.HEAT;
                else
                    this.currentState = c.OFF;
                break;
            case 'fan':
            case 'dry':
            case 'off':
            default:
                this.currentState = c.OFF;
                break;
        }
    }
    // Schedule a debounced differential sync to device using query parameters only
    scheduleSyncToDevice() {
        if (this.config.mock)
            return; // no outbound when mocking
        if (this.pendingSendTimer)
            clearTimeout(this.pendingSendTimer);
        this.pendingSendTimer = setTimeout(() => this.flushPendingSend().catch(err => this.debug('flushPendingSend error', err)), this.debounceMs);
        this.pendingSendTimer = setTimeout(() => this.flushPendingSend().catch(() => undefined), this.debounceMs);
    }
    buildDeviceMode() {
        const deviceModeMap = {
            off: 'OFF',
            cool: 'COOL',
            heat: 'HEAT',
            auto: 'HEAT_COOL',
            fan: 'FAN_ONLY',
            dry: 'DRY',
        };
        return deviceModeMap[this.internalMode];
    }
    roundTemp(v) {
        const stepped = Math.round(v * 2) / 2;
        return stepped;
    }
    async flushPendingSend() {
        if (this.config.mock)
            return;
        const ip = this.config.ip;
        if (!ip)
            return;
        if (!this.climateEntityId) {
            this.debug('Deferring send; climate entity not yet discovered');
            // retry shortly until SSE gives us the entity id
            this.pendingSendTimer = setTimeout(() => this.flushPendingSend().catch(() => undefined), 1500);
            return;
        }
        const deviceMode = this.buildDeviceMode();
        // Round temperature to device step (0.5) and keep one decimal
        this.targetTemp = this.roundTemp(this.targetTemp);
        const desiredTarget = this.targetTemp;
        const params = [];
        if (deviceMode !== this.lastSentMode)
            params.push(`mode=${encodeURIComponent(deviceMode)}`);
        if (this.lastSentTarget === undefined || Math.abs(desiredTarget - this.lastSentTarget) > 0.001) {
            params.push(`target_temperature=${desiredTarget.toFixed(1)}`);
        }
        if (params.length === 0) {
            this.debug('No diff to send (mode/temperature unchanged)');
            return;
        }
        // Device silently ignores fan_mode changes so we skip sending fan_mode entirely for now.
        const endpoint = `http://${ip}/climate/${this.climateEntityId.replace('climate-', '')}/set?${params.join('&')}`;
        this.debug('Sending diff to device', endpoint);
        // sending diff to device (debug removed)
        // no diff to send
        // deferring send; climate entity not yet discovered
        try {
            await axios_1.default.post(endpoint, undefined, { timeout: 5000 });
            // Optimistically update lastSent markers (SSE confirmation will reconcile internalMode/targetTemp anyway)
            if (params.some(p => p.startsWith('mode=')))
                this.lastSentMode = deviceMode;
            if (params.some(p => p.startsWith('target_temperature=')))
                this.lastSentTarget = desiredTarget;
        }
        catch (e) {
            this.log.warn('Command POST failed', e.message || e);
        }
    }
    async pollStatus() {
        if (this.config.mock) {
            // Simulate drift and cyclic modes
            this.currentTemp += (Math.random() - 0.5) * 0.2;
            this.applyInternalModeToCurrent();
            this.updateCharacteristics();
            return;
        }
        // When not in mock, we rely on SSE; no polling here.
    }
    updateCharacteristics() {
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.currentTemp);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetTemperature, this.targetTemp);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.CurrentHeatingCoolingState, this.currentState);
        this.thermostatService.updateCharacteristic(this.hap.Characteristic.TargetHeatingCoolingState, this.targetState);
        if (this.humidityService)
            this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, this.humidity);
        if (this.fanOnlySwitch)
            this.fanOnlySwitch.updateCharacteristic(this.hap.Characteristic.On, this.internalMode === 'fan');
        if (this.dryModeSwitch)
            this.dryModeSwitch.updateCharacteristic(this.hap.Characteristic.On, this.internalMode === 'dry');
        Object.entries(this.presetSwitches).forEach(([preset, svc]) => {
            svc.updateCharacteristic(this.hap.Characteristic.On, this.currentPreset === preset);
        });
        if (this.swingSwitch)
            this.swingSwitch.updateCharacteristic(this.hap.Characteristic.On, this.currentSwingMode === 'BOTH');
    }
    // Handlers
    handleCurrentStateGet(callback) { callback(null, this.currentState); }
    handleTargetStateGet(callback) { callback(null, this.targetState); }
    handleTargetStateSet(value, callback) {
        const t = this.hap.Characteristic.TargetHeatingCoolingState;
        if (value === t.COOL)
            this.setInternalMode('cool');
        else if (value === t.HEAT)
            this.setInternalMode('heat');
        else if (value === t.AUTO)
            this.setInternalMode('auto');
        else
            this.setInternalMode('off');
        callback(null);
    }
    handleCurrentTempGet(callback) { callback(null, this.currentTemp); }
    handleTargetTempGet(callback) { callback(null, this.targetTemp); }
    handleTargetTempSet(value, callback) {
        this.targetTemp = value;
        this.applyInternalModeToCurrent();
        this.scheduleSyncToDevice();
        this.updateCharacteristics();
        callback(null);
    }
    getServices() {
        const base = [this.informationService, this.thermostatService];
        if (this.humidityService)
            base.push(this.humidityService);
        if (this.outdoorTempService)
            base.push(this.outdoorTempService);
        if (this.fanOnlySwitch)
            base.push(this.fanOnlySwitch);
        if (this.dryModeSwitch)
            base.push(this.dryModeSwitch);
        Object.values(this.presetSwitches).forEach(s => base.push(s));
        if (this.swingSwitch)
            base.push(this.swingSwitch);
        if (this.beeperSwitch)
            base.push(this.beeperSwitch);
        // display toggle & swing step removed
        return base;
    }
    // --- Event Stream Handling ---
    connectEventStream() {
        if (!this.config.ip)
            return;
        const url = `http://${this.config.ip}/events`;
        this.debug('Connecting SSE', url);
        // connecting SSE
        try {
            this.es = new eventsource_1.default(url);
        }
        catch (e) {
            this.log.error('Failed to create EventSource', e.message || e);
            this.scheduleReconnect();
            return;
        }
        // If we don't discover a climate entity within 12s, emit a warning (helps diagnose missing HEAT_COOL reflection)
        setTimeout(() => {
            if (!this.climateEntityId) {
                this.log.warn('No climate state received yet (still waiting for climate-* SSE events). Check device IP / connectivity.');
            }
        }, 12000);
        this.es.onmessage = (evt) => {
            // Generic messages (without event field) might not appear; we rely on typed handlers below
            this.debug('SSE message', evt.data?.slice(0, 120));
        };
        this.es.addEventListener('ping', (ev) => {
            // keep-alive; could parse general metadata
        });
        this.es.addEventListener('state', (ev) => {
            try {
                const data = JSON.parse(ev.data);
                if (this.config.debug && data && data.id) {
                    // debug removed: SSE state id
                }
                if (!data || !data.id)
                    return;
                if (data.id.startsWith('climate-')) {
                    this.handleClimateState(data);
                }
                else if (data.id === 'sensor-air_conditioner_indoor_humidity' && typeof data.value === 'number') {
                    this.humidity = data.value;
                    if (this.humidityService)
                        this.humidityService.updateCharacteristic(this.hap.Characteristic.CurrentRelativeHumidity, this.humidity);
                }
                else if (data.id.startsWith('sensor-air_conditioner_outdoor_temperature')) {
                    const valRaw = data.value;
                    let val = NaN;
                    if (typeof valRaw === 'number')
                        val = valRaw;
                    else if (typeof valRaw === 'string') {
                        const parsed = parseFloat(valRaw);
                        if (!isNaN(parsed))
                            val = parsed;
                    }
                    if (!isNaN(val)) {
                        this.outdoorTemp = val;
                        if (this.outdoorTempService)
                            this.outdoorTempService.updateCharacteristic(this.hap.Characteristic.CurrentTemperature, this.outdoorTemp);
                        this.debug('Updated outdoor temperature', this.outdoorTemp);
                        // updated outdoor temperature
                    }
                }
                else if (data.id === 'switch-air_conditioner_beeper' && typeof data.value === 'string') {
                    const v = data.value.toLowerCase();
                    const on = v === 'on';
                    if (this.beeperOn !== on) {
                        this.beeperOn = on;
                        this.beeperSwitch?.updateCharacteristic(this.hap.Characteristic.On, this.beeperOn);
                        this.debug('Beeper state update', this.beeperOn);
                        // beeper state update
                    }
                }
            }
            catch (e) {
                this.debug('Failed to parse state event', e.message || e);
                // failed to parse state event
            }
        });
        this.es.addEventListener('log', (ev) => {
            // Could parse internal debug; ignore for now unless debug enabled
            if (this.config.debug) {
                // device internal log ignored
            }
        });
        this.es.onerror = (err) => {
            this.log.warn('SSE error; will reconnect', err ? JSON.stringify(err) : 'unknown');
            this.cleanupEventStream();
            this.scheduleReconnect();
        };
    }
    scheduleReconnect() {
        if (this.config.mock)
            return;
        setTimeout(() => this.connectEventStream(), this.pendingReconnectDelay);
        // Exponential backoff up to 60s
        this.pendingReconnectDelay = Math.min(this.pendingReconnectDelay * 2, 60000);
    }
    cleanupEventStream() {
        if (this.es) {
            try {
                this.es.close();
            }
            catch { /* ignore */ }
            this.es = undefined;
        }
    }
    handleClimateState(data) {
        // Raw debug before any mapping so we can diagnose mismatches
        this.debug('SSE climate raw', {
            /* debug removed: SSE climate raw */
            id: data.id,
            mode: data.mode,
            current_temperature: data.current_temperature,
            target_temperature: data.target_temperature,
            preset: data.preset,
            swing_mode: data.swing_mode,
        });
        if (!this.climateEntityId) {
            this.climateEntityId = data.id; // store full id e.g. climate-air_conditioner
            this.debug('Discovered climate entity', this.climateEntityId);
            // discovered climate entity
            // Optionally auto-disable beeper once after discovery
            if (this.config.autoDisableBeeper) {
                this.disableBeeper().catch(err => this.debug('autoDisableBeeper failed', err));
                this.disableBeeper().catch(() => undefined);
            }
        }
        // Extract numbers (some come as strings)
        const parseNum = (v) => typeof v === 'number' ? v : (typeof v === 'string' ? parseFloat(v) : NaN);
        const current = parseNum(data.current_temperature);
        const target = parseNum(data.target_temperature);
        if (!isNaN(current))
            this.currentTemp = current;
        if (!isNaN(target))
            this.targetTemp = target;
        if (typeof data.mode === 'string') {
            const mode = data.mode.toUpperCase();
            const map = {
                'OFF': 'off',
                'COOL': 'cool',
                'HEAT': 'heat',
                'HEAT_COOL': 'auto',
                'FAN_ONLY': 'fan',
                'DRY': 'dry',
            };
            const internal = map[mode];
            if (internal)
                this.internalMode = internal;
            // Also update targetState to reflect device-reported mode (previously only updated when user initiated change)
            const t = this.hap.Characteristic.TargetHeatingCoolingState;
            switch (this.internalMode) {
                case 'cool':
                    this.targetState = t.COOL;
                    break;
                case 'heat':
                    this.targetState = t.HEAT;
                    break;
                case 'auto':
                    this.targetState = t.AUTO;
                    break;
                default:
                    this.targetState = t.OFF;
                    break; // fan/dry/off map to OFF target for HomeKit
            }
            // If device reports a mode different from what we last sent, allow future diff (do not overwrite lastSentMode here unless matches)
            if (this.buildDeviceMode() !== this.lastSentMode) {
                // divergence - keep lastSentMode as is so a subsequent local change will trigger send
            }
            else {
                // matched; nothing to adjust
            }
        }
        if (typeof data.preset === 'string') {
            this.currentPreset = data.preset.toUpperCase();
        }
        if (typeof data.swing_mode === 'string') {
            this.currentSwingMode = data.swing_mode.toUpperCase();
        }
        // Update lastSentTarget only if matches device (ensures we don't suppress future attempted changes if device rejected)
        if (!isNaN(target) && (this.lastSentTarget === undefined || Math.abs(target - this.lastSentTarget) < 0.001)) {
            this.lastSentTarget = target; // confirm
        }
        this.checkAckSatisfied();
        this.applyInternalModeToCurrent();
        this.updateCharacteristics();
        this.debug('SSE climate mapped', {
            /* debug removed: SSE climate mapped */
            internalMode: this.internalMode,
            currentTemp: this.currentTemp,
            targetTemp: this.targetTemp,
            currentState: this.currentState,
            targetState: this.targetState,
            preset: this.currentPreset,
            swing: this.currentSwingMode,
        });
    }
    // --- Experimental feature helpers ---
    async requestPreset(preset) {
        if (this.config.mock) {
            this.currentPreset = preset;
            this.updateCharacteristics();
            return;
        }
        if (!this.config.ip || !this.climateEntityId)
            return;
        const endpoint = `http://${this.config.ip}/climate/${this.climateEntityId.replace('climate-', '')}/set?preset=${encodeURIComponent(preset)}`;
        this.debug('Sending preset request', endpoint);
        // sending preset request (debug removed)
        try {
            await axios_1.default.post(endpoint, undefined, { timeout: 4000 });
        }
        catch (e) {
            this.log.warn('Preset request failed', e.message || e);
        }
        // We rely on SSE to update; if not changed, switch will revert on next updateCharacteristics call triggered by other events.
    }
    async requestSwing(swing) {
        if (this.config.mock) {
            this.currentSwingMode = swing;
            this.updateCharacteristics();
            return;
        }
        if (!this.config.ip || !this.climateEntityId)
            return;
        const endpoint = `http://${this.config.ip}/climate/${this.climateEntityId.replace('climate-', '')}/set?swing_mode=${encodeURIComponent(swing)}`;
        this.debug('Sending swing request', endpoint);
        // sending swing request (debug removed)
        try {
            await axios_1.default.post(endpoint, undefined, { timeout: 4000 });
        }
        catch (e) {
            this.log.warn('Swing request failed', e.message || e);
        }
    }
    async disableBeeper() {
        if (this.config.mock || !this.config.ip)
            return;
        const endpoint = `http://${this.config.ip}/switch/air_conditioner_beeper/turn_off`;
        this.debug('Auto disabling beeper');
        // auto disabling beeper
        try {
            await axios_1.default.post(endpoint, undefined, { timeout: 3000 });
        }
        catch (e) {
            this.debug('disableBeeper error', e.message || e);
        }
        try {
            await axios_1.default.post(endpoint, undefined, { timeout: 3000 });
        }
        catch { /* ignore */ }
    }
    startAck(expectedMode, expectedTarget) {
        this.pendingAck = { sentAt: Date.now(), expectedMode, expectedTarget };
        setTimeout(() => {
            if (this.pendingAck && Date.now() - this.pendingAck.sentAt >= this.ackTimeoutMs) {
                this.log.warn('No SSE acknowledgement within timeout for mode/temperature change');
                this.pendingAck = undefined;
            }
        }, this.ackTimeoutMs + 50);
    }
    checkAckSatisfied() {
        if (!this.pendingAck)
            return;
        const expected = this.pendingAck;
        let satisfied = true;
        if (expected.expectedMode && expected.expectedMode !== this.buildDeviceMode())
            satisfied = false;
        if (typeof expected.expectedTarget === 'number' && Math.abs(this.targetTemp - expected.expectedTarget) > 0.001)
            satisfied = false;
        if (satisfied) {
            this.debug('Ack satisfied for mode/temperature change');
            // ack satisfied
            this.pendingAck = undefined;
        }
    }
    // --- Device control for new switch/button services ---
    async sendBeeper(on) {
        if (this.config.mock || !this.config.ip)
            return;
        const action = on ? 'turn_on' : 'turn_off';
        const endpoint = `http://${this.config.ip}/switch/air_conditioner_beeper/${action}`;
        this.debug('Beeper request', endpoint);
        // beeper request
        try {
            await axios_1.default.post(endpoint, undefined, { timeout: 3000 });
        }
        catch (err) {
            this.log.warn('Beeper request failed', err.message || err);
        }
    }
}
exports.MrCoolSmartLightAccessory = MrCoolSmartLightAccessory;
