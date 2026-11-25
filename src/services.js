'use strict';

const path = require('node:path');

// Shared DRM and CDN hosts supplement each service's navigation allowlist.
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
    // Preserve sign-ins created before service-specific partitions.
    partition: 'persist:veylo',
    // Disney+ restricts Linux playback and rejects Electron's user agent.
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
    // Netflix checks the claimed platform against the Linux Widevine CDM.
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
    // Keep the platform consistent with Widevine's Linux identity.
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
    // Apple TV+ rejects Linux browser identities.
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
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'primevideo.jpg'),
    allowedHostSuffixes: [
      'primevideo.com', // site, sign-in, account, playback and media APIs
      'amazonvideo.com', // legacy brand endpoints still referenced by the player
      // Sign-in redirects to the user's regional Amazon domain.
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
  },
  {
    id: 'skyshowtime',
    name: 'SkyShowtime',
    startUrl: 'https://www.skyshowtime.com/',
    backgroundColor: '#0b1220',
    partition: 'persist:veylo-skyshowtime',
    // The catalogue regions are listed in skyshowtime.com/sitemap.xml.
    availableIn: ['AD', 'AL', 'BA', 'BG', 'CZ', 'DK', 'ES', 'FI', 'HR', 'HU', 'ME', 'MK', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE', 'SI', 'SK', 'XK'],
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'skyshowtime.jpg'),
    allowedHostSuffixes: [
      'skyshowtime.com', // site, sign-in (auth.*), account, playback APIs (sas.skyshowtime.com)
      'skyshowtime.net', // service endpoints referenced by the player
    ],
  },
  {
    id: 'crunchyroll',
    name: 'Crunchyroll',
    startUrl: 'https://www.crunchyroll.com/',
    backgroundColor: '#1f1f1f',
    partition: 'persist:veylo-crunchyroll',
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'crunchyroll.jpg'),
    allowedHostSuffixes: [
      'crunchyroll.com', // site, sign-in, account, playback and media APIs
      'crunchyroll.net', // static assets and media delivery
      'crunchyroll.tv', // short links referenced by the player
    ],
  },
  {
    id: 'plutotv',
    name: 'Pluto TV',
    startUrl: 'https://pluto.tv/',
    backgroundColor: '#1b1145',
    partition: 'persist:veylo-plutotv',
    // Catalogue regions follow pluto.tv/sitemap/.
    availableIn: ['US', 'CA', 'GB', 'DE', 'AT', 'CH', 'FR', 'IT', 'ES', 'DK', 'NO', 'SE', 'AR', 'BO', 'BR', 'CL', 'CO', 'CR', 'DO', 'EC', 'SV', 'GT', 'HN', 'MX', 'NI', 'PA', 'PY', 'PE', 'UY', 'VE'],
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
  },
  {
    id: 'tubi',
    name: 'Tubi',
    startUrl: 'https://tubitv.com/',
    backgroundColor: '#160b04',
    partition: 'persist:veylo-tubi',
    // Regions follow Tubi's help page for devices outside the US.
    availableIn: ['US', 'CA', 'MX', 'GB', 'AU', 'NZ', 'PR', 'CR', 'EC', 'SV', 'GT', 'PA'],
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'tubi.jpg'),
    allowedHostSuffixes: [
      'tubitv.com', // site, sign-in, account and playback APIs
      'tubi.tv', // service endpoints and the GDPR interstitial (gdpr.tubi.tv)
      'tubi.io', // media delivery and previews (video-previews-cdn.production-public.tubi.io)
    ],
  },
  {
    id: 'peacock',
    name: 'Peacock',
    startUrl: 'https://www.peacocktv.com/',
    backgroundColor: '#0a0a0a',
    partition: 'persist:veylo-peacock',
    availableIn: ['US', 'AS', 'GU', 'MP', 'PR', 'VI'],
    // Peacock's supported desktop browsers exclude Linux.
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
    // Regions follow paramountplus.com/global/ and include the US home market.
    availableIn: ['US', 'AR', 'AT', 'AU', 'BO', 'BR', 'CA', 'CH', 'CL', 'CO', 'CR', 'DE', 'DO', 'EC', 'FR', 'GB', 'GT', 'HN', 'HU', 'IE', 'IT', 'MX', 'NI', 'PA', 'PE', 'PY', 'SV', 'UY', 'VE'],
    // Paramount+'s supported desktop browsers exclude Linux.
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
  {
    id: 'youtube',
    name: 'YouTube',
    startUrl: 'https://www.youtube.com/',
    backgroundColor: '#0f0f0f',
    partition: 'persist:veylo-youtube',
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'youtube.jpg'),
    allowedHostSuffixes: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  },
  {
    id: 'youtubemusic',
    name: 'YouTube Music',
    startUrl: 'https://music.youtube.com/',
    backgroundColor: '#030303',
    partition: 'persist:veylo-youtubemusic',
    // Google's published YouTube Music locations, excluding Russia, which is
    // listed as temporarily unavailable. South Korea requires a paid plan.
    availableIn: [
      'DZ', 'AS', 'AR', 'AW', 'AU', 'AT', 'AZ', 'BH', 'BD', 'BY', 'BE', 'BM', 'BO', 'BA',
      'BR', 'BG', 'KH', 'CA', 'KY', 'CL', 'CO', 'CR', 'HR', 'CY', 'CZ', 'DK', 'DO', 'EC',
      'EG', 'SV', 'EE', 'FI', 'FR', 'GF', 'PF', 'GE', 'DE', 'GH', 'GR', 'GP', 'GU', 'GT',
      'HN', 'HK', 'HU', 'IS', 'IN', 'ID', 'IQ', 'IE', 'IL', 'IT', 'JM', 'JP', 'JO', 'KZ',
      'KE', 'KW', 'LA', 'LV', 'LB', 'LY', 'LI', 'LT', 'LU', 'MY', 'MT', 'MX', 'MA', 'NP',
      'NL', 'NZ', 'NI', 'NG', 'MK', 'MP', 'NO', 'OM', 'PK', 'PA', 'PG', 'PY', 'PE', 'PH',
      'PL', 'PT', 'PR', 'QA', 'RE', 'RO', 'SA', 'SN', 'RS', 'SG', 'SK', 'SI', 'ZA', 'KR',
      'ES', 'LK', 'SE', 'CH', 'TW', 'TZ', 'TH', 'TN', 'TR', 'TC', 'VI', 'UG', 'UA', 'AE',
      'GB', 'US', 'UY', 'VE', 'VN', 'YE', 'ZW',
    ],
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'youtube_music.jpg'),
    allowedHostSuffixes: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
  },
  {
    id: 'plex',
    name: 'Plex',
    startUrl: 'https://app.plex.tv/desktop/',
    backgroundColor: '#1f1f1f',
    partition: 'persist:veylo-plex',
    identity: 'linux',
    icon: path.join(__dirname, '..', 'assets', 'plex.jpg'),
    allowedHostSuffixes: ['plex.tv'],
    externalHostSuffixes: ['support.plex.tv'],
  },
];

const DEFAULT_SERVICE_ID = 'disneyplus';

function getService(id) {
  return SERVICES.find((service) => service.id === id) || null;
}

function allowedHostSuffixes(service) {
  if (!service) return [];
  return [...(service.allowedHostSuffixes || []), ...SHARED_HOST_SUFFIXES];
}

function resolveService(id) {
  return getService(id) || getService(DEFAULT_SERVICE_ID);
}

/**
 * A service without an `availableIn` list is treated as available everywhere.
 * A restricted service returns false for an unknown country; callers should
 * distinguish unknown from confirmed unavailability when displaying it.
 *
 * @param {object} service
 * @param {string|null} country ISO 3166-1 alpha-2 code, or null when unknown
 */
function availableInRegion(service, country) {
  if (!service || !service.availableIn) return true;
  if (!country) return false;
  return service.availableIn.includes(country);
}

function visibleServices(country) {
  return SERVICES.filter((service) => availableInRegion(service, country));
}

function orderedServices(prefs, country) {
  const order = new Map((prefs.serviceOrder || []).map((id, index) => [id, index]));
  const favorites = new Set(prefs.favorites || []);
  return SERVICES
    .filter((service) => !prefs.hideUnavailable || availableInRegion(service, country))
    .map((service, index) => ({ service, index }))
    .sort((a, b) => Number(favorites.has(b.service.id)) - Number(favorites.has(a.service.id)) ||
      (order.get(a.service.id) ?? Infinity) - (order.get(b.service.id) ?? Infinity) ||
      a.index - b.index)
    .map(({ service }) => service);
}

function moveService(prefs, country, id, direction) {
  const favorites = new Set(prefs.favorites);
  const group = orderedServices(prefs, country)
    .filter((service) => favorites.has(service.id) === favorites.has(id));
  const index = group.findIndex((service) => service.id === id);
  const target = group[index + direction];
  if (index < 0 || !target || ![-1, 1].includes(direction)) return prefs;
  const order = orderedServices({ ...prefs, hideUnavailable: false }, country).map((service) => service.id);
  const from = order.indexOf(id);
  const to = order.indexOf(target.id);
  [order[from], order[to]] = [order[to], order[from]];
  return { ...prefs, serviceOrder: order };
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
  orderedServices,
  moveService,
};
