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
 * `assets/<id>.jpg`.
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
    icon: path.join(__dirname, '..', 'assets', 'disneyplus.jpg'),
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
    icon: path.join(__dirname, '..', 'assets', 'netflix.jpg'),
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
  {
    id: 'hbomax',
    name: 'Max',
    startUrl: 'https://www.max.com/',
    backgroundColor: '#080814',
    partition: 'persist:veylo-hbomax',
    // Max plays in Chrome on Linux with Widevine and does not reject an
    // Electron-flavoured user agent, so the real platform is kept — the same
    // reasoning as Netflix: the Widevine CDM reports `Linux` in the licence
    // request, and a contradicting claim risks breaking the DRM exchange.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'hbomax.jpg'),
    allowedHostSuffixes: [
      'max.com', // site, sign-in, account, playback and media APIs
      'hbomax.com', // legacy brand: auth and playback endpoints
      'discomax.com', // Max API platform (telegraph, images, playback)
      'hbo.com', // legacy HBO links and assets
      'azurefd.net', // Azure Front Door CDN used for stream delivery
    ],
    externalHostSuffixes: [
      'help.max.com',
      'help.hbomax.com',
    ],
  },
  {
    id: 'appletv',
    name: 'Apple TV+',
    startUrl: 'https://tv.apple.com/',
    backgroundColor: '#000000',
    partition: 'persist:veylo-appletv',
    // Apple TV+ refuses to play on a Linux identity (the player surfaces a
    // generic "An Error Occurred" and never starts), so the service is
    // presented as Windows Chrome — the same approach as Disney+. Unlike
    // Netflix, Apple does not appear to cross-check the platform the Widevine
    // CDM reports in the licence request, so the spoof does not break DRM.
    identity: 'windows',
    icon: path.join(__dirname, '..', 'assets', 'appletv.jpg'),
    allowedHostSuffixes: [
      'apple.com', // site, sign-in (appleid), account, store APIs
      'aiv-cdn.net', // Apple iTunes video: stream manifests and segments
      'mzstatic.com', // artwork and static assets
      'itunes.com', // legacy store endpoints still referenced by the player
    ],
    externalHostSuffixes: [
      'support.apple.com',
    ],
  },
  {
    id: 'primevideo',
    name: 'Prime Video',
    startUrl: 'https://www.primevideo.com/',
    backgroundColor: '#0f171e',
    partition: 'persist:veylo-primevideo',
    // Prime Video's player runs in a regular browser on Linux, so the real
    // platform is kept — the same reasoning as Netflix and Max: the Widevine
    // CDM reports `Linux` in the licence request, and a contradicting claim
    // risks breaking the DRM exchange.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'primevideo.jpg'),
    allowedHostSuffixes: [
      'primevideo.com', // site, sign-in, account, playback and media APIs
      'amazonvideo.com', // legacy brand endpoints still referenced by the player
      // Sign-in and account live on the regional amazon domains: the site
      // redirects to amazon.<tld>/ap/signin for the caller's region, so the
      // region set has to be covered as well as the main domains.
      'amazon.com',
      'amazon.co.uk',
      'amazon.de',
      'amazon.fr',
      'amazon.it',
      'amazon.es',
      'amazon.nl',
      'amazon.se',
      'amazon.pl',
      'amazon.com.br',
      'amazon.ca',
      'amazon.com.mx',
      'amazon.com.au',
      'amazon.co.jp',
      'amazon.in',
      'amazon.sg',
      'amazon.ae',
      'amazon.sa',
      'amazon.com.tr',
      'amazon.eg',
      'pv-cdn.net', // stream manifests and segments
      'aiv-cdn.net', // Amazon video CDN: manifests and segments
      'aiv-delivery.net', // stream delivery
      'media-amazon.com', // images and static assets
      'ssl-images-amazon.com', // legacy image CDN
      'a2z.com', // playback service endpoints (video.a2z.com)
      'doubleclick.net', // required by the player's analytics stack
    ],
    // No externalHostSuffixes: the player's links (help, account, terms of
    // use) are all on primevideo.com or amazon.*, which are already allowed
    // above, so nothing needs to open in the system browser.
  },
  {
    id: 'skyshowtime',
    name: 'SkyShowtime',
    startUrl: 'https://www.skyshowtime.com/',
    backgroundColor: '#0b1220',
    partition: 'persist:veylo-skyshowtime',
    // The 22 countries whose content the service's own sitemap lists
    // (skyshowtime.com/sitemap.xml); outside them the site has no catalogue.
    availableIn: ['AD', 'AL', 'BA', 'BG', 'CZ', 'DK', 'ES', 'FI', 'HR', 'HU', 'ME', 'MK', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'XK'],
    // SkyShowtime's web player runs in a regular browser on Linux, so the real
    // platform is kept — the same reasoning as Netflix, Max and Prime Video:
    // the Widevine CDM reports `Linux` in the licence request, and a
    // contradicting claim risks breaking the DRM exchange.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'skyshowtime.jpg'),
    allowedHostSuffixes: [
      'skyshowtime.com', // site, sign-in (auth.*), account, playback APIs (sas.skyshowtime.com)
      'skyshowtime.net', // service endpoints referenced by the player
    ],
    // No externalHostSuffixes: help/FAQ links live on skyshowtime.com itself,
    // which is already allowed above.
  },
  {
    id: 'crunchyroll',
    name: 'Crunchyroll',
    startUrl: 'https://www.crunchyroll.com/',
    backgroundColor: '#1f1f1f',
    partition: 'persist:veylo-crunchyroll',
    // Crunchyroll's web player runs in a regular browser on Linux, so the real
    // platform is kept — the same reasoning as Netflix, Max, Prime Video and
    // SkyShowtime: the Widevine CDM reports `Linux` in the licence request, and
    // a contradicting claim risks breaking the DRM exchange.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'crunchyroll.jpg'),
    allowedHostSuffixes: [
      'crunchyroll.com', // site, sign-in, account, playback and media APIs
      'crunchyroll.net', // static assets and media delivery
      'crunchyroll.tv', // short links referenced by the player
    ],
    // No externalHostSuffixes: help links live on help.crunchyroll.com, which
    // the `crunchyroll.com` suffix above already covers.
  },
  {
    id: 'plutotv',
    name: 'Pluto TV',
    startUrl: 'https://pluto.tv/',
    backgroundColor: '#1b1145',
    partition: 'persist:veylo-plutotv',
    // Pluto TV streams in 30 countries (its own region list, pluto.tv/sitemap/):
    // the US, Canada, the UK, parts of Western and Northern Europe and Latin
    // America. Hungary is not one of them, so the service is not offered here.
    availableIn: ['US', 'CA', 'GB', 'DE', 'AT', 'CH', 'FR', 'IT', 'ES', 'DK', 'NO', 'SE', 'AR', 'BO', 'BR', 'CL', 'CO', 'CR', 'DO', 'EC', 'SV', 'GT', 'HN', 'MX', 'NI', 'PA', 'PY', 'PE', 'UY', 'VE'],
    // Pluto TV's web player runs in a regular browser on Linux, so the real
    // platform is kept — the same reasoning as Netflix, Max, Prime Video,
    // SkyShowtime and Crunchyroll: the Widevine CDM reports `Linux` in the
    // licence request, and a contradicting claim risks breaking the DRM
    // exchange.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'plutotv.jpg'),
    allowedHostSuffixes: [
      'pluto.tv', // site, guide, player, auth, and the *.prd.pluto.tv service/CDN hosts
      'plutotv.net', // legacy service endpoints still referenced by the player
      'paramount.com', // Paramount Streaming: consent delivery (cdn.privacy.paramount.com) and shared account infrastructure
      'ketchcdn.com', // consent management (global.ketchcdn.com)
      'adobedc.net', // Adobe Experience Platform consent/analytics (data.adobedc.net)
      'datadoghq.com', // client-side telemetry
    ],
    // No externalHostSuffixes: help and legal links live on pluto.tv itself,
    // which is already allowed above.
  },
  {
    id: 'tubi',
    name: 'Tubi',
    startUrl: 'https://tubitv.com/',
    backgroundColor: '#160b04',
    partition: 'persist:veylo-tubi',
    // Tubi streams in 12 countries (its help page for devices outside the US).
    // The whole EU has been excluded since the GDPR took effect in 2018, so
    // the service is not offered here.
    availableIn: ['US', 'CA', 'MX', 'GB', 'AU', 'NZ', 'PR', 'CR', 'EC', 'SV', 'GT', 'PA'],
    // Tubi's web player runs in a regular browser on Linux, so the real
    // platform is kept — the same reasoning as Netflix, Max, Prime Video,
    // SkyShowtime, Crunchyroll and Pluto TV: the Widevine CDM reports `Linux`
    // in the licence request, and a contradicting claim risks breaking the
    // DRM exchange. Note that Tubi is not offered in the EU: from an EU IP
    // the service answers with the gdpr.tubi.tv interstitial instead of the
    // catalogue, which the allowlist below covers.
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'tubi.jpg'),
    allowedHostSuffixes: [
      'tubitv.com', // site, sign-in, account and playback APIs
      'tubi.tv', // service endpoints and the GDPR interstitial (gdpr.tubi.tv)
      'tubi.io', // media delivery and previews (video-previews-cdn.production-public.tubi.io)
    ],
    // No externalHostSuffixes: help links live on tubitv.com itself, which
    // is already allowed above.
  },
  {
    id: 'peacock',
    name: 'Peacock',
    startUrl: 'https://www.peacocktv.com/',
    backgroundColor: '#0a0a0a',
    partition: 'persist:veylo-peacock',
    // Peacock streams in the United States and five US territories only;
    // anywhere else the site answers with its "Unavailable In Your Region"
    // page, so the service is offered only there (see availableIn).
    availableIn: ['US', 'AS', 'GU', 'MP', 'PR', 'VI'],
    // Peacock's help lists its browsers as Chrome/Firefox/Edge on Windows and
    // Mac only — no Linux — so the service is presented as Windows Chrome, the
    // same approach as Disney+ and Apple TV+. Unlike Netflix, NBCUniversal
    // does not appear to cross-check the platform the Widevine CDM reports in
    // the licence request, so the spoof does not break DRM.
    identity: 'windows',
    icon: path.join(__dirname, '..', 'assets', 'peacock.jpg'),
    allowedHostSuffixes: [
      'peacocktv.com', // site, sign-in (id.*), account, playback (ovp.*), CDN (*.cdn.peacocktv.com)
      'peacock.com', // legacy brand domain
      'nbcuott.com', // NBCUniversal OTT platform APIs (atom.*, prod.*)
      'nbcuni.com', // NBCUniversal shared endpoints
      'nbcuniversal.com', // corporate and privacy pages referenced by the site
      'cookielaw.org', // OneTrust consent banner (cdn.cookielaw.org)
      'adobedtm.com', // Adobe Tag Manager (assets.adobedtm.com)
      'jscrambler.com', // client-side code protection the player loads
      'ada.support', // support widget (static.ada.support)
    ],
    externalHostSuffixes: [
      'nbcuniversal.com',
      'nbcunicareers.com',
    ],
  },
  {
    id: 'paramountplus',
    name: 'Paramount+',
    startUrl: 'https://www.paramountplus.com/',
    backgroundColor: '#001438',
    partition: 'persist:veylo-paramountplus',
    // The 28 countries on the service's own global page
    // (paramountplus.com/global/), plus the US home market. From anywhere else
    // the site redirects to the country picker instead of a catalogue.
    availableIn: ['US', 'AR', 'AT', 'AU', 'BO', 'BR', 'CA', 'CH', 'CL', 'CO', 'CR', 'DE', 'DO', 'EC', 'FR', 'GB', 'GT', 'HN', 'HU', 'IE', 'IT', 'MX', 'NI', 'PA', 'PE', 'PY', 'SV', 'UY', 'VE'],
    // Paramount+'s help lists its desktop browsers as Chrome on Windows and
    // Mac only — no Linux — so the service is presented as Windows Chrome, the
    // same approach as Disney+, Apple TV+ and Peacock. Unlike Netflix,
    // Paramount does not appear to cross-check the platform the Widevine CDM
    // reports in the licence request, so the spoof does not break DRM.
    identity: 'windows',
    icon: path.join(__dirname, '..', 'assets', 'paramountplus.jpg'),
    allowedHostSuffixes: [
      'paramountplus.com', // site, sign-in, account, playback (karb.*, sparrow.*), intl country sites
      'paramount.com', // shared brand and privacy endpoints (privacy.*, legal.*, cdn.privacy.paramount.com)
      'cbsig.net', // CBS Interactive image CDN (thumbnails.cbsig.net)
      'cbsinteractive.com', // legacy CBS endpoints (legalterms.*)
      'pplusstatic.com', // static assets (wwwimage-intl.pplusstatic.com)
      'cookielaw.org', // OneTrust consent banner (cdn.cookielaw.org)
      'redfast.com', // engagement/consent conduit (conduit.redfast.com)
      'recaptcha.net', // sign-in captcha (www.recaptcha.net)
      'adobe.com', // entitlement check the player calls (entitlement.auth.adobe.com)
      'skyshowtime.com', // sister service cross-links (same Comcast/Paramount joint venture)
    ],
    externalHostSuffixes: [
      'help.paramountplus.com',
      'support.paramountplus.com',
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

/**
 * Whether the service streams in the given country.
 *
 * A service without an `availableIn` list is offered everywhere. A restricted
 * one is offered only in its own countries — and never when the country is
 * unknown, because presenting it would only lead to the service's location
 * screen (see src/region.js).
 *
 * @param {object} service
 * @param {string|null} country ISO 3166-1 alpha-2 code, or null when unknown
 */
function availableInRegion(service, country) {
  if (!service || !service.availableIn) return true;
  if (!country) return false;
  return service.availableIn.includes(country);
}

/** The registry in order, minus the services that do not stream here. */
function visibleServices(country) {
  return SERVICES.filter((service) => availableInRegion(service, country));
}

module.exports = {
  SERVICES,
  DEFAULT_SERVICE_ID,
  SHARED_HOST_SUFFIXES,
  getService,
  allowedHostSuffixes,
  resolveService,
  availableInRegion,
  visibleServices,
};
