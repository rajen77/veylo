'use strict';

/**
 * Every navigation target is checked against this allowlist. The client renders
 * the official Disney+ web app, so it only ever needs to reach Disney's own
 * hosts plus the infrastructure that the player legitimately talks to
 * (authentication, DRM licence delivery, CDN). Opening anything else in the
 * main window is refused.
 */

const ALLOWED_HOST_SUFFIXES = [
  'disneyplus.com',
  'dssott.com', // Disney Streaming Services: auth, playback API
  'bamgrid.com', // Disney Streaming identity platform
  'disneystreaming.com',
  'dtci.co',
  'cdn.registerdisney.go.com',
  'widevine.com', // licence proxy endpoints
  'googleapis.com', // Widevine licence backend
  'googlevideo.com', // media delivery
  'google.com',
  'gstatic.com',
  'doubleclick.net', // required by the player's analytics stack
  'd9.disney-plus.net',
  'disney-plus.net',
  'akamaihd.net',
  'akamaized.net',
  'llnwd.net',
  'cloudfront.net',
  'fastly.net',
  'edgesuite.net',
  'conviva.com', // playback telemetry, player refuses to start without it
  'scorecardresearch.com',
  'bam.nr-data.net',
  'newrelic.com',
  'bugsnag.com',
];

const INTERNAL_SCHEMES = new Set(['devtools:', 'chrome:', 'chrome-extension:', 'blob:', 'data:', 'about:']);

/** Hosts that may be opened in the system browser rather than inside the app. */
const EXTERNAL_HOST_SUFFIXES = [
  'help.disneyplus.com',
  'disneytermsofuse.com',
  'disneyprivacycenter.com',
  'disney.com',
  'd23.com',
];

function hostMatches(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isAllowed(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (INTERNAL_SCHEMES.has(parsed.protocol)) return true;
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return hostMatches(parsed.hostname, ALLOWED_HOST_SUFFIXES);
}

function isExternal(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  return hostMatches(parsed.hostname, EXTERNAL_HOST_SUFFIXES) || !isAllowed(url);
}

module.exports = { isAllowed, isExternal, hostMatches, ALLOWED_HOST_SUFFIXES, EXTERNAL_HOST_SUFFIXES };
