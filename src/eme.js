'use strict';

// Windows identity can trigger hardware-secure requests that the L3 CDM cannot satisfy.
// Patch the page's world because isolated preload prototypes are invisible to it.

const MAIN_WORLD_SOURCE = `(() => {
  // Avoid wrapping the API repeatedly across navigations.
  if (window.__veyloEmeRobustnessFixed) return true;

  const toSoftware = (value) =>
    (typeof value === 'string' && /hw/i.test(value) ? 'SW secure' : value);

  // Players can specify robustness on the config or in capability arrays.
  const patchCapability = (cap) => {
    if (!cap || typeof cap !== 'object') return cap;
    const patched = { ...cap };
    if ('robustness' in patched) {
      patched.robustness = toSoftware(patched.robustness);
    }
    return patched;
  };

  const patchCapabilityList = (list) =>
    (Array.isArray(list) ? list.map(patchCapability) : list);

  const patchConfig = (config) => {
    if (!config || typeof config !== 'object') return config;
    const patched = { ...config };
    if ('videoRobustness' in patched) {
      patched.videoRobustness = toSoftware(patched.videoRobustness);
    }
    if ('audioRobustness' in patched) {
      patched.audioRobustness = toSoftware(patched.audioRobustness);
    }
    if ('videoCapabilities' in patched) {
      patched.videoCapabilities = patchCapabilityList(patched.videoCapabilities);
    }
    if ('audioCapabilities' in patched) {
      patched.audioCapabilities = patchCapabilityList(patched.audioCapabilities);
    }
    return patched;
  };

  if (typeof navigator !== 'undefined' && navigator.requestMediaKeySystemAccess) {
    const original = navigator.requestMediaKeySystemAccess.bind(navigator);
    navigator.requestMediaKeySystemAccess = (keySystem, configs) =>
      original(keySystem, Array.isArray(configs) ? configs.map(patchConfig) : configs);
  }

  window.__veyloEmeRobustnessFixed = true;
  return true;
})()`;

module.exports = { MAIN_WORLD_SOURCE };