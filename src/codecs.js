'use strict';

/**
 * Corrects the media codec capabilities this build reports to the streaming
 * services' web players.
 *
 * castLabs' Electron ships a `libffmpeg.so` that contains no AC-3 or E-AC-3
 * decoder, yet the build still answers "yes" when a page asks whether it can
 * play Dolby audio:
 *
 *     MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')  ->  true
 *     document.createElement('audio').canPlayType(…)          ->  "probably"
 *
 * Both answers are wrong. Only the AAC, FLAC, MP3, Opus, Vorbis and PCM
 * decoders are linked into that library. Google Chrome, on the same machine and
 * with the same underlying decoders, answers `false` and `""`.
 *
 * The services trust those answers when they choose an audio track. Because
 * Chromium claims it can handle E-AC-3, Disney+ serves an `ec-3` init segment;
 * the audio decoder then fails to initialise and the player aborts with an
 * error the site surfaces as code 83:
 *
 *     PipelineStatus::DECODER_ERROR_NOT_SUPPORTED: audio decoder
 *     initialization failed with DecoderStatus::Codes::kUnsupportedConfig
 *
 * Once Dolby is reported as unsupported, the player falls back to AAC
 * (`mp4a`), which this build can decode, and playback proceeds. Nothing is
 * added to or removed from any media stream, and the DRM path is untouched.
 *
 * The patch has to execute in the page's own JavaScript world. A preload script
 * runs in an isolated world and shares no prototypes with the page, so
 * overriding `MediaSource.isTypeSupported` there would be invisible to the
 * player and would change nothing.
 */

// Dolby and DTS codec identifiers this build advertises but cannot decode.
// `ec-3` is E-AC-3 and `ac-3` is AC-3.
const UNDECODABLE_CODECS = '^(ec-3|ac-3|ec\\+3|dtsc|dtsh|dtsl|dtsx)$';

/**
 * A self-contained expression for `webContents.executeJavaScript`, evaluated in
 * the page's main world before any of the site's own scripts run.
 */
const MAIN_WORLD_SOURCE = `(() => {
  // Repeated on every main-frame navigation; guard so the prototypes are not
  // wrapped again on each one.
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
