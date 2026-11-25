'use strict';

const { app, session } = require('electron');
const log = require('./logger');
const i18n = require('./i18n');

// Services check headers, client hints and navigator independently; they must agree.
// Netflix also checks the claimed platform against the Linux Widevine CDM.
const CHROME_MAJOR = '156';
const CHROME_FULL = '156.0.8078.47';

// Platform fields must agree across the request and page identities.
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

// The isolated preload world cannot change the player's navigator.
function navigatorPatchSource(identity, languages) {
  return `(() => {
  // Language changes require new getters even when the identity is unchanged.
  const tag = ${JSON.stringify(`${identity.navigatorPlatform}|${languages.join(',')}`)};
  if (window.__veyloUAPatched === tag) return true;
  window.__veyloUAPatched = tag;

  const languageTags = ${JSON.stringify(languages)};
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

  // Same for the language: Chromium reports the system locale here, while the
  // header carries the language chosen in the Language menu.
  Object.defineProperty(Navigator.prototype, 'language', {
    configurable: true,
    get: () => languageTags[0],
  });
  Object.defineProperty(Navigator.prototype, 'languages', {
    configurable: true,
    get: () => languageTags.slice(),
  });

  return true;
})()`;
}

const applied = new Map(); // partition -> { identity, session, userAgent }
// Track open pages so language changes can update them.
const openContents = new Set();
let navigatorPatchInstalled = false;

function entryFor(contents) {
  return [...applied.values()].find((item) => item.session === contents.session) || null;
}

function applyUserAgent(partition, identityName) {
  if (applied.has(partition)) return;

  const identity = identityOf(identityName);
  const userAgent = userAgentFor(identity);

  app.userAgentFallback = userAgent;
  const ses = session.fromPartition(partition);
  // Keep the header and navigator language aligned.
  ses.setUserAgent(userAgent, i18n.acceptLanguages().join(','));
  applied.set(partition, { identity, session: ses, userAgent });

  // Electron does not send User-Agent Client Hints at all, so they are added
  // here to match what the claimed Chrome puts on the wire.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['sec-ch-ua'] = SEC_CH_UA;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = identity.platformHint;
    callback({ requestHeaders: headers });
  });

  // The app-wide handler resolves each page's identity from its session.
  if (!navigatorPatchInstalled) {
    navigatorPatchInstalled = true;
    app.on('web-contents-created', (_event, webContents) => {
      openContents.add(webContents);
      webContents.on('destroyed', () => openContents.delete(webContents));
      webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
        if (!isMainFrame) return;
        const entry = entryFor(webContents);
        if (!entry) {
          log.debug('No identity registered for this session; navigator untouched');
          return;
        }
        webContents
          .executeJavaScript(navigatorPatchSource(entry.identity, i18n.acceptLanguages()), true)
          .then(() => log.debug('Spoofed navigator identity:', entry.identity.navigatorPlatform))
          .catch((err) => log.debug('UA data patch failed:', err.message));
      });
    });
  }

  log.debug(`User agent presented to ${partition}: ${userAgent}`);
}

function applyBrowserLanguage() {
  const languages = i18n.acceptLanguages();
  const header = languages.join(',');
  for (const entry of applied.values()) {
    entry.session.setUserAgent(entry.userAgent, header);
  }
  for (const contents of openContents) {
    if (contents.isDestroyed()) continue;
    const entry = entryFor(contents);
    if (!entry) continue;
    contents
      .executeJavaScript(navigatorPatchSource(entry.identity, languages), true)
      .then(() => log.debug('Navigator language set to', header))
      .catch((err) => log.debug('Language patch failed:', err.message));
  }
  log.debug(`Accept-Language set to ${header} on ${applied.size} session(s)`);
}

module.exports = { applyBrowserLanguage, applyUserAgent, IDENTITIES };