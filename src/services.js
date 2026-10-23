'use strict';

const path = require('node:path');

/**
 * Registry of the streaming services the client can wrap.
 *
 * Everything that varies between services lives here: the page that is loaded,
 * the session partition it keeps (so each service stays signed in on its own),
 * the platform identity the client presents itself as (see src/user-agent.js),
 * the hosts it may reach, and the icon the startup picker shows. src/security.js
 * turns the host lists into the navigation allowlist; the picker, the menu and
 * the window all read the rest.
 *
 * Adding a service is a matter of adding an entry — its icon is expected at
 * `assets/<id>.png`.
 */

// Hosts every service legitimately needs: DRM licence delivery and the CDN
// families shared across providers.
const SHARED_HOST_SUFFIXES = [
  'widevine.com', // licence proxy endpoints
  'googleapis.com', // Widevine licence backend
  'googlevideo.com', // media delivery
  'google.com',
  'gstatic.com',
  'akamaihd.net',
  'akamaized.net',
  'llnwd.net',
  'cloudfront.net',
  'fastly.net',
  'edgesuite.net',
];

const SERVICES = [
  {
    id: 'disneyplus',
    name: 'Disney+',
    startUrl: 'https://www.disneyplus.com/',
    backgroundColor: '#040814',
    // The original partition name is kept so that sign-ins made before the
    // service picker existed survive the change.
    partition: 'persist:veylo',
    // Disney+ drops Linux clients to low resolutions and refuses to start on an
    // Electron user agent, so this service is presented as Windows Chrome.
    identity: 'windows',
    icon: path.join(__dirname, '..', 'assets', 'disneyplus.png'),
    allowedHostSuffixes: [
      'disneyplus.com',
      'dssott.com', // Disney Streaming Services: auth, playback API
      'bamgrid.com', // Disney Streaming identity platform
      'disneystreaming.com',
      'dtci.co',
      'cdn.registerdisney.go.com',
      'd9.disney-plus.net',
      'disney-plus.net',
      'doubleclick.net', // required by the player's analytics stack
      'conviva.com', // playback telemetry, player refuses to start without it
      'scorecardresearch.com',
      'bam.nr-data.net',
      'newrelic.com',
      'bugsnag.com',
    ],
    externalHostSuffixes: [
      'help.disneyplus.com',
      'disneytermsofuse.com',
      'disneyprivacycenter.com',
      'disney.com',
      'd23.com',
    ],
  },
  {
    id: 'netflix',
    name: 'Netflix',
    startUrl: 'https://www.netflix.com/',
    backgroundColor: '#141414',
    partition: 'persist:veylo-netflix',
    // Netflix checks the platform claim against the one the Widevine CDM puts
    // in the licence request, which is always `Linux` on this platform. A
    // Windows claim fails that check: playback ends with error E100 (and with
    // M7111-1957-205064 when a title is resumed), so this service keeps the
    // real platform and only drops the Electron token from the user agent.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'netflix.png'),
    allowedHostSuffixes: [
      'netflix.com', // site, sign-in, account
      'nflxvideo.net', // media delivery and DRM licences
      'nflximg.net', // artwork
      'nflximg.com',
      'nflxext.com', // static assets
      'nflxso.net', // service endpoints
      'nflxso.com',
      'netflixd.com', // device and playback telemetry
    ],
    externalHostSuffixes: [
      'help.netflix.com',
    ],
  },
];

const DEFAULT_SERVICE_ID = 'disneyplus';

function getService(id) {
  return SERVICES.find((service) => service.id === id) || null;
}

/** The full allowlist for a service: its own hosts plus the shared ones. */
function allowedHostSuffixes(service) {
  if (!service) return [];
  return [...(service.allowedHostSuffixes || []), ...SHARED_HOST_SUFFIXES];
}

/** The service a window should show: the requested one, or the default. */
function resolveService(id) {
  return getService(id) || getService(DEFAULT_SERVICE_ID);
}

module.exports = {
  SERVICES,
  DEFAULT_SERVICE_ID,
  SHARED_HOST_SUFFIXES,
  getService,
  allowedHostSuffixes,
  resolveService,
};
