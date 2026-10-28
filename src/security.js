'use strict';

/**
 * Every navigation target is checked against an allowlist built from the
 * active service (see src/services.js). The client renders an official web
 * player, so it only ever needs to reach that service's own hosts plus the
 * infrastructure the player legitimately talks to (authentication, DRM licence
 * delivery, CDN). Opening anything else in the main window is refused.
 *
 * The lists are resolved on demand rather than captured at load time, so a
 * service switch takes effect for the very next navigation.
 */

const { allowedHostSuffixes } = require('./services');

const INTERNAL_SCHEMES = new Set(['devtools:', 'chrome:', 'chrome-extension:', 'blob:', 'data:', 'about:']);

function hostMatches(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isAllowed(url, service) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (INTERNAL_SCHEMES.has(parsed.protocol)) return true;
  // Every service is HTTPS-only: a plain-http target is refused outright
  // rather than downgraded or handed to the browser.
  if (parsed.protocol !== 'https:') return false;
  return hostMatches(parsed.hostname, allowedHostSuffixes(service));
}

function isExternal(url, service) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const external = service && service.externalHostSuffixes
    ? hostMatches(parsed.hostname, service.externalHostSuffixes)
    : false;
  return external || !isAllowed(url, service);
}

module.exports = { isAllowed, isExternal, hostMatches };
