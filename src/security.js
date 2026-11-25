'use strict';

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
  // Never downgrade streaming navigation to HTTP.
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

// Restrict permissions to those needed for playback.
const ALLOWED_PERMISSIONS = new Set([
  'fullscreen',
  'protected-media-identifier',
  'clipboard-sanitized-write',
]);

function isPermissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

function applyPermissionPolicy(session) {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(isPermissionAllowed(permission)));
  session.setPermissionCheckHandler((_contents, permission) => isPermissionAllowed(permission));
}

module.exports = { isAllowed, isExternal, hostMatches, isPermissionAllowed, applyPermissionPolicy };
