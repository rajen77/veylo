'use strict';

/**
 * Downgrades hardware-secure Widevine robustness requests to software-secure
 * ones before the page's player negotiates DRM.
 *
 * Presenting the client as Windows Chrome (see src/user-agent.js) makes the
 * Apple TV+ player ask for a hardware-secure content path:
 *
 *     navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
 *       videoCapabilities: [{ robustness: 'HW secure' }], …
 *
 * No such path exists on this platform: the Widevine CDM shipped with this
 * build is software-only (security level L3). The request is therefore
 * rejected with `NotSupportedError`, the player never obtains a key, and the
 * site surfaces its generic "An Error Occurred" dialog.
 *
 * Rewriting `HW secure` to `SW secure` asks for exactly what the CDM can
 * deliver. Nothing is added: a hardware-secure request could not have
 * succeeded here in the first place, so services that already fall back to a
 * software config themselves (Netflix, Disney+, Max) end up in the same place
 * they would have reached on their own.
 *
 * Like the codec patch in src/codecs.js, this has to run in the page's own
 * JavaScript world — a preload script's isolated world shares no prototypes
 * with the player, so a patch applied there would be invisible to it.
 */

const MAIN_WORLD_SOURCE = `(() => {
  // Repeated on every main-frame navigation; guard so the prototype is not
  // wrapped again on each one.
  if (window.__veyloEmeRobustnessFixed) return true;

  const toSoftware = (value) =>
    (typeof value === 'string' && /hw/i.test(value) ? 'SW secure' : value);

  // Robustness lives either directly on the config (videoRobustness /
  // audioRobustness) or inside its capability arrays (videoCapabilities /
  // audioCapabilities), depending on how the player builds the request.
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