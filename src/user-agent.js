'use strict';

const { app, session } = require('electron');
const log = require('./logger');

/**
 * Presents the client as a current Chrome on the platform the active service
 * expects. Every service keeps its own partition (see src/services.js), so
 * each partition gets the identity its service asks for.
 *
 * The disguise has to be consistent on three levels, because each one is
 * checked independently:
 *
 *   1. The `User-Agent` request header. Stripping `Electron/x.y.z` is not
 *      enough; the platform token also has to match the claimed platform.
 *   2. The User-Agent Client Hints (`sec-ch-ua*`). Real Chrome sends them on
 *      every request; Electron sends none at all, which is itself a tell.
 *   3. The page-side `navigator` properties (`platform`, `userAgentData`).
 *      The site can read them from JavaScript, and they would otherwise keep
 *      reporting the real platform while the headers claim another one.
 *
 * The platform itself is a per-service choice:
 *
 *   - Windows (`disneyplus`): the player refuses to start on a user agent that
 *     advertises Electron, and Disney+ serves lower resolutions (reports down
 *     to 480p) to clients it identifies as Linux.
 *   - Linux (`netflix`): Netflix compares the claimed platform against the one
 *     the Widevine CDM reports inside the licence request (`platform_name:
 *     Linux`). Claiming Windows breaks the licence exchange — playback fails
 *     with E100 and, on resume, with M7111-1957-205064.
 *
 * The version tokens mirror the Chrome stable build used for testing, so the
 * client presents itself as a current, ordinary Chrome on the claimed platform.
 *
 * This is a compatibility measure only; the client still loads the services'
 * own web apps and performs no request rewriting beyond these identity headers.
 */

// Chrome stable used as the reference for this build.
const CHROME_MAJOR = '156';
const CHROME_FULL = '156.0.8078.47';

// The identities the app can assume. The three platform values of an entry
// always have to agree with each other, otherwise the disguise contradicts
// itself and the service treats the client as tampered with.
const IDENTITIES = {
  windows: {
    // Windows 10 and 11 both report NT 10.0; Win64/x64 covers either.
    platformToken: 'Windows NT 10.0; Win64; x64',
    platformHint: '"Windows"',
    navigatorPlatform: 'Win32',
    uaDataPlatform: 'Windows',
    // Windows 11 reports platformVersion 15.x, Windows 10 reports 10.x.
    platformVersion: '15.0.0',
  },
  linux: {
    platformToken: 'X11; Linux x86_64',
    platformHint: '"Linux"',
    navigatorPlatform: 'Linux x86_64',
    uaDataPlatform: 'Linux',
    // Chrome on Linux reports the kernel's major version.
    platformVersion: '6.0.0',
  },
};

function identityOf(name) {
  return IDENTITIES[name] || IDENTITIES.windows;
}

function userAgentFor(identity) {
  return `Mozilla/5.0 (${identity.platformToken}) AppleWebKit/537.36 ` +
    `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;
}

// Exactly what Chrome stable puts on the wire, including the greased brand.
const SEC_CH_UA =
  `"Not:A-Brand";v="8", "Chromium";v="${CHROME_MAJOR}", "Google Chrome";v="${CHROME_MAJOR}"`;

const BRANDS = [
  { brand: 'Not:A-Brand', version: '8' },
  { brand: 'Chromium', version: CHROME_MAJOR },
  { brand: 'Google Chrome', version: CHROME_MAJOR },
];

const FULL_VERSION_LIST = [
  { brand: 'Not:A-Brand', version: '99.0.0.0' },
  { brand: 'Chromium', version: CHROME_FULL },
  { brand: 'Google Chrome', version: CHROME_FULL },
];

/**
 * Builds the self-contained expression for `webContents.executeJavaScript`
 * that rewrites the page-side `navigator` properties for one identity. It is
 * evaluated in the page's main world before any of the site's own scripts run.
 * A preload script cannot be used here: it runs in an isolated world and its
 * changes to `navigator` are invisible to the player.
 */
function navigatorPatchSource(identity) {
  return `(() => {
  // Repeated on every main-frame navigation; guard so the prototypes are not
  // wrapped again on each one.
  if (window.__veyloUASpoofed) return true;

  const brands = ${JSON.stringify(BRANDS)};
  const fullVersionList = ${JSON.stringify(FULL_VERSION_LIST)};
  const snapshot = { brands, mobile: false, platform: ${JSON.stringify(identity.uaDataPlatform)} };
  const highEntropy = {
    ...snapshot,
    fullVersionList,
    platformVersion: ${JSON.stringify(identity.platformVersion)},
    architecture: 'x86',
    bitness: '64',
    model: '',
    uaFullVersion: ${JSON.stringify(CHROME_FULL)},
    wow64: false,
  };

  Object.defineProperty(Navigator.prototype, 'userAgentData', {
    configurable: true,
    get: () => ({
      ...snapshot,
      // Only the requested hints are returned, like the real implementation.
      getHighEntropyValues: async (hints = []) => {
        const result = { brands, mobile: false, platform: ${JSON.stringify(identity.uaDataPlatform)} };
        for (const hint of hints) {
          if (hint in highEntropy) result[hint] = highEntropy[hint];
        }
        return result;
      },
      toJSON: () => snapshot,
    }),
  });

  // Chromium derives this from the real OS, not from the UA string, so it would
  // otherwise contradict the headers.
  Object.defineProperty(Navigator.prototype, 'platform', {
    configurable: true,
    get: () => ${JSON.stringify(identity.navigatorPlatform)},
  });

  window.__veyloUASpoofed = true;
  return true;
})()`;
}

// Each service keeps its own partition (see src/services.js), so every
// partition gets the identity of the service that owns it.
const applied = new Map(); // partition -> { identity, session }
let navigatorPatchInstalled = false;

/**
 * Applies the given identity to `app`, to every request in the given
 * partition (the main window and the sign-in popups share it), and patches the
 * page-side `navigator` properties in every document of that partition.
 *
 * Safe to call again for another partition: the app-wide parts are installed
 * once, the per-partition parts once per partition.
 */
function applyUserAgent(partition, identityName) {
  if (applied.has(partition)) return;

  const identity = identityOf(identityName);
  const userAgent = userAgentFor(identity);

  app.userAgentFallback = userAgent;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(userAgent);
  applied.set(partition, { identity, session: ses });

  // Electron does not send User-Agent Client Hints at all, so they are added
  // here to match what the claimed Chrome puts on the wire.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['sec-ch-ua'] = SEC_CH_UA;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = identity.platformHint;
    callback({ requestHeaders: headers });
  });

  // Covers the main window and every popup created afterwards. Installed once:
  // the handler is app-wide, and a second one would run the patch twice. The
  // identity is resolved per navigation because the handler cannot know which
  // service a new webContents belongs to.
  if (!navigatorPatchInstalled) {
    navigatorPatchInstalled = true;
    app.on('web-contents-created', (_event, webContents) => {
      webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        const entry = [...applied.values()].find((item) => item.session === webContents.session);
        if (!entry) {
          log.debug('No identity registered for this session; navigator untouched');
          return;
        }
        webContents
          .executeJavaScript(navigatorPatchSource(entry.identity), true)
          .then(() => log.debug('Spoofed navigator identity:', entry.identity.navigatorPlatform))
          .catch((err) => log.debug('UA data patch failed:', err.message));
      });
    });
  }

  log.debug(`User agent presented to ${partition}: ${userAgent}`);
}

module.exports = { applyUserAgent, IDENTITIES };