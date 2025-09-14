import { API, AccessoryPluginConstructor } from 'homebridge';
import { MrCoolSmartLightAccessory } from './mrcoolAccessory';

const ACCESSORY_NAME = 'MrCoolSmartLight';

export default (api: API) => {
  api.registerAccessory(ACCESSORY_NAME, MrCoolSmartLightAccessory as unknown as AccessoryPluginConstructor);
};
