import {submodule} from '../src/hook.js';
import {prefixLog, deepAccess, mergeDeep} from '../src/utils.js';

export const LOG_PREFIX = '[51Degrees RTD Submodule]:';
const {logMessage, logWarn, logError} = prefixLog(LOG_PREFIX);

// ORTB device types
const ORTB_DEVICE_TYPE = {
  UNKNOWN: 0,
  MOBILE_TABLET: 1,
  PERSONAL_COMPUTER: 2,
  CONNECTED_TV: 3,
  PHONE: 4,
  TABLET: 5,
  CONNECTED_DEVICE: 6,
  SET_TOP_BOX: 7,
  OOH_DEVICE: 8
};

// Map of 51Degrees device types to ORTB device types
const ORTB_DEVICE_TYPE_MAP = new Map([
  ['Phone', ORTB_DEVICE_TYPE.PHONE],
  ['Console', ORTB_DEVICE_TYPE.SET_TOP_BOX],
  ['Desktop', ORTB_DEVICE_TYPE.PERSONAL_COMPUTER],
  ['EReader', ORTB_DEVICE_TYPE.PERSONAL_COMPUTER],
  ['IoT', ORTB_DEVICE_TYPE.CONNECTED_DEVICE],
  ['Kiosk', ORTB_DEVICE_TYPE.OOH_DEVICE],
  ['MediaHub', ORTB_DEVICE_TYPE.SET_TOP_BOX],
  ['Mobile', ORTB_DEVICE_TYPE.MOBILE_TABLET],
  ['Router', ORTB_DEVICE_TYPE.CONNECTED_DEVICE],
  ['SmallScreen', ORTB_DEVICE_TYPE.CONNECTED_DEVICE],
  ['SmartPhone', ORTB_DEVICE_TYPE.MOBILE_TABLET],
  ['SmartSpeaker', ORTB_DEVICE_TYPE.CONNECTED_DEVICE],
  ['SmartWatch', ORTB_DEVICE_TYPE.CONNECTED_DEVICE],
  ['Tablet', ORTB_DEVICE_TYPE.TABLET],
  ['Tv', ORTB_DEVICE_TYPE.CONNECTED_TV],
  ['Vehicle Display', ORTB_DEVICE_TYPE.PERSONAL_COMPUTER]
]);

/**
 * Extracts the parameters for 51Degrees RTD module from the config object passed at instantiation
 * @param {Object} moduleConfig Configuration object of the 51Degrees RTD module
 * @param {Object} reqBidsConfigObj Configuration object for the bidders, currently not used
 */
export const extractConfig = (moduleConfig, reqBidsConfigObj) => {
  // Resource key
  const resourceKey = deepAccess(moduleConfig, 'params.resourceKey');
  // On-premise JS URL
  const onPremiseJSUrl = deepAccess(moduleConfig, 'params.onPremiseJSUrl');

  if (!resourceKey && !onPremiseJSUrl) {
    throw new Error(LOG_PREFIX + ' Missing parameter resourceKey or onPremiseJSUrl in moduleConfig');
  } else if (resourceKey && onPremiseJSUrl) {
    throw new Error(LOG_PREFIX + ' Only one of resourceKey or onPremiseJSUrl should be provided in moduleConfig');
  }

  return {resourceKey, onPremiseJSUrl};
}

/**
 * Gets 51Degrees JS URL
 * @param {Object} pathData API path data
 * @param {string} [pathData.resourceKey] Resource key
 * @param {string} [pathData.onPremiseJSUrl] On-premise JS URL
 * @returns {string} 51Degrees JS URL
 */
export const get51DegreesJSURL = (pathData) => {
  if (pathData.onPremiseJSUrl) {
    return pathData.onPremiseJSUrl;
  }
  return `https://cloud.51degrees.com/api/v4/${pathData.resourceKey}.js?fod-js-enable-cookies=false`;
}

/**
 * Injects 51Degrees script into the document head
 * @param {string} url 51Degrees JS URL
 * @returns {Promise} Promise that resolves when the script is loaded
 */
export const inject51DegreesScript = (url) => {
  const script = document.createElement('script');
  script.src = url;
  script.async = true;
  document.head.appendChild(script);

  return new Promise((resolve, reject) => {
    script.onload = resolve;
    script.onerror = reject;
  });
}

/**
 * Check if meta[http-equiv="Delegate-CH"] tag is present in the document head and points to 51Degrees cloud
 *
 * @returns {boolean} True if 51Degrees meta is present
 * @returns {boolean} False if 51Degrees meta is not present
 */
export const is51DegreesMetaPresent = () => {
  const meta51 = document.head.querySelectorAll('meta[http-equiv="Delegate-CH"]');
  if (!meta51.length) {
    return false;
  }
  return meta51.values().some(meta => meta.content.includes('cloud.51degrees.com'));
}

/**
 * Sets the value of a key in the ORTB2 object if the value is not empty
 *
 * @param {Object} obj The object to set the key in
 * @param {string} key The key to set
 * @param {any} value The value to set
 */
export const setOrtb2KeyIfNotEmpty = (obj, key, value) => {
  if (!key) {
    throw new Error(LOG_PREFIX + ' Key is required');
  }

  if (value) {
    obj[key] = value;
  }
}

/**
 * Converts 51Degrees device data to ORTB2 format
 *
 * @param {Object} device
 * @param {string} [device.deviceid] Device ID (unique 51Degrees identifier)
 * @param {string} [device.devicetype]
 * @param {string} [device.hardwarevendor]
 * @param {string} [device.hardwaremodel]
 * @param {string[]} [device.hardwarename]
 * @param {string} [device.platformname]
 * @param {string} [device.platformversion]
 * @param {number} [device.screenpixelsheight]
 * @param {number} [device.screenpixelswidth]
 * @param {number} [device.pixelratio]
 * @param {number} [device.screeninchesheight]
 *
 * @returns {Object}
 */
export const convert51DegreesDeviceToOrtb2 = (device) => {
  const ortb2Device = {};

  if (!device) {
    return ortb2Device;
  }

  const deviceModel =
    device.hardwaremodel || (
      device.hardwarename && device.hardwarename.length
        ? device.hardwarename.join(',')
        : null
    );

  const devicePPI = device.screenpixelsheight && device.screeninchesheight
    ? Math.round(device.screenpixelsheight / device.screeninchesheight)
    : null;

  setOrtb2KeyIfNotEmpty(ortb2Device, 'devicetype', ORTB_DEVICE_TYPE_MAP.get(device.devicetype));
  setOrtb2KeyIfNotEmpty(ortb2Device, 'make', device.hardwarevendor);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'model', deviceModel);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'os', device.platformname);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'osv', device.platformversion);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'h', device.screenpixelsheight);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'w', device.screenpixelswidth);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'pxratio', device.pixelratio);
  setOrtb2KeyIfNotEmpty(ortb2Device, 'ppi', devicePPI);

  if (device.deviceid) {
    ortb2Device.ext = {
      'fiftyonedegrees_deviceId': device.deviceid
    };
  }

  return ortb2Device;
}

/**
 * @param {Object} reqBidsConfigObj Bid request configuration object
 * @param {Function} callback Called on completion
 * @param {Object} moduleConfig Configuration for 1plusX RTD module
 * @param {Object} userConsent
 */
export const getBidRequestData = (reqBidsConfigObj, callback, moduleConfig, userConsent) => {
  try {
    // Get the required config
    const {resourceKey, onPremiseJSUrl} = extractConfig(moduleConfig, reqBidsConfigObj);
    logMessage('Resource key: ', resourceKey);
    logMessage('On-premise JS URL: ', onPremiseJSUrl);

    // Get 51Degrees JS URL, which is either cloud or on-premise
    const scriptURL = get51DegreesJSURL(resourceKey ? {resourceKey} : {onPremiseJSUrl});
    logMessage('URL of the script to be injected: ', scriptURL);

    // Check if 51Degrees meta is present (cloud only)
    if (resourceKey) {
      logMessage('Checking if 51Degrees meta is present in the document head');
      if (!is51DegreesMetaPresent()) {
        logWarn('Delegate-CH meta tag is not present in the document head');
      }
    }

    // Inject 51Degrees script, get device data and merge it into the ORTB2 object
    inject51DegreesScript(scriptURL)
      .then(() => {
        logMessage('Successfully injected 51Degrees script');
        const fod = /** @type {Object} */ (window.fod);
        // Convert and merge device data in the callback
        fod.complete((data) => {
          logMessage('51Degrees raw data: ', data);
          mergeDeep(
            reqBidsConfigObj.ortb2Fragments.global,
            {device: convert51DegreesDeviceToOrtb2(data.device)},
          )
          logMessage('reqBidsConfigObj: ', reqBidsConfigObj);
          callback();
        });
      })
      .catch((error) => {
        logError('Error injecting 51Degrees script: ', error);
        callback();
      });
  } catch (error) {
    // In case of an error, log it and continue
    logError(error);
    callback();
  }
}

/**
 * Init
 * @param {Object} config Module configuration
 * @param {boolean} userConsent User consent
 * @returns true
 */
const init = (config, userConsent) => {
  return true;
}

// 51Degrees RTD submodule object to be registered
export const fiftyOneDegreesSubmodule = {
  name: '51Degrees',
  init,
  getBidRequestData,
}

submodule('realTimeData', fiftyOneDegreesSubmodule);
