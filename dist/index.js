"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const mrcoolAccessory_1 = require("./mrcoolAccessory");
const ACCESSORY_NAME = 'MrCoolSmartLight';
exports.default = (api) => {
    api.registerAccessory(ACCESSORY_NAME, mrcoolAccessory_1.MrCoolSmartLightAccessory);
};
