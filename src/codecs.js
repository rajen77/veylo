'use strict';

// This build advertises Dolby/DTS codecs it cannot decode, causing playback failures.
const UNDECODABLE_CODECS = '^(ec-3|ac-3|ec\\+3|dtsc|dtsh|dtsl|dtsx)$';

// Patch the page's world because isolated preload prototypes are invisible to it.
const MAIN_WORLD_SOURCE = `(() => {
  // Avoid wrapping the APIs repeatedly across navigations.
  if (window.__veyloCodecCapabilitiesFixed) return true;

  const UNDECODABLE = new RegExp(${JSON.stringify(UNDECODABLE_CODECS)}, 'i');
  const codecOf = (s) => {
    const m = String(s == null ? '' : s).match(/codecs\\s*=\\s*"?([^";]+)"?/i);
    return m ? m[1].trim() : '';
  };
  const isUndecodable = (s) => UNDECODABLE.test(codecOf(s));

  if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) {
    const original = MediaSource.isTypeSupported.bind(MediaSource);
    MediaSource.isTypeSupported = (type) =>
      (isUndecodable(type) ? false : original(type));
  }

  if (typeof HTMLMediaElement !== 'undefined') {
    const original = HTMLMediaElement.prototype.canPlayType;
    HTMLMediaElement.prototype.canPlayType = function (type) {
      if (isUndecodable(type)) return '';
      return original.call(this, type);
    };
  }

  if (navigator.mediaCapabilities && navigator.mediaCapabilities.decodingInfo) {
    const original = navigator.mediaCapabilities.decodingInfo.bind(
      navigator.mediaCapabilities,
    );
    navigator.mediaCapabilities.decodingInfo = async (config) => {
      const audio = config && config.audio && config.audio.contentType;
      const video = config && config.video && config.video.contentType;
      if (isUndecodable(audio) || isUndecodable(video)) {
        return { supported: false, smooth: false, powerEfficient: false };
      }
      return original(config);
    };
  }

  window.__veyloCodecCapabilitiesFixed = true;
  return true;
})()`;

module.exports = { MAIN_WORLD_SOURCE, UNDECODABLE_CODECS };
