'use strict';

const { app, session } = require('electron');
const log = require('./logger');

/**
 * Presents the client to Disney+ as current Chrome on Windows 10/11.
 *
 * The player refuses to start on a user agent that advertises Electron, and
 * Disney+ is known to serve lower resolutions (reports down to 480p) to clients
 * it identifies as Linux. The disguise has to be consistent on three levels,
 * because each one is checked independently:
 *
 *   1. The `User-Agent` request header. Stripping `Electron/x.y.z` is not
 *      enough; the `X11; Linux x86_64` platform token also has to go.
 *   2. The User-Agent Client Hints (`sec-ch-ua*`). Real Chrome sends them on
 *      every request; Electron sends none at all, which is itself a tell. The
 *      platform hint has to say `"Windows"` to match the UA string.
 *   3. The page-side `navigator` properties (`platform`, `userAgentData`).
 *      The site can read them from JavaScript, and they would otherwise keep
 *      reporting Linux while the headers claim Windows.
 *
 * The version tokens mirror the Chrome stable build used for testing
 * (`Chrome/${CHROME_MAJOR}` in the UA, full version in the client hints), so
 * the client presents itself as a current, ordinary Chrome on Windows.
 *
 * This is a compatibility measure only; the client still loads Disney's own
 * web app and performs no request rewriting beyond these identity headers.
 */

// Chrome stable used as the reference for this build.
const CHROME_MAJOR = '156';
const CHROME_FULL = '156.0.8078.47';

// Windows 10 and 11 both report NT 10.0; Win64/x64 covers either.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

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
 * A self-contained expression for `webContents.executeJavaScript`, evaluated in
 * the page's main world before any of the site's own scripts run. A preload
 * script cannot be used here: it runs in an isolated world and its changes to
 * `navigator` are invisible to the player.
 */
const UA_DATA_SOURCE = `(() => {
  // Repeated on every main-frame navigation; guard so the prototypes are not
  // wrapped again on each one.
  if (window.__veyloUASpoofed) return true;

  const brands = ${JSON.stringify(BRANDS)};
  const fullVersionList = ${JSON.stringify(FULL_VERSION_LIST)};
  const snapshot = { brands, mobile: false, platform: 'Windows' };
  const highEntropy = {
    ...snapshot,
    fullVersionList,
    // Windows 11 reports platformVersion 15.x; Windows 10 reports 10.x.
    platformVersion: '15.0.0',
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
        const result = { brands, mobile: false, platform: 'Windows' };
        for (const hint of hints) {
          if (hint in highEntropy) result[hint] = highEntropy[hint];
        }
        return result;
      },
      toJSON: () => snapshot,
    }),
  });

  // Chromium derives this from the real OS, not from the UA string, so it
  // would keep saying "Linux x86_64" and contradict the headers.
  Object.defineProperty(Navigator.prototype, 'platform', {
    configurable: true,
    get: () => 'Win32',
  });

  window.__veyloUASpoofed = true;
  return true;
})()`;

let applied = false;

/**
 * Applies the Windows/Chrome identity to `app`, to every request in the given
 * partition (the main window and the sign-in popups share it), and patches the
 * page-side `navigator` properties in every document the app creates.
 */
function applyUserAgent(partition) {
  if (applied) return;
  applied = true;

  app.userAgentFallback = USER_AGENT;
  const ses = session.fromPartition(partition);
  ses.setUserAgent(USER_AGENT);

  // Electron does not send User-Agent Client Hints at all, so they are added
  // here to match what the claimed Chrome puts on the wire.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers['sec-ch-ua'] = SEC_CH_UA;
    headers['sec-ch-ua-mobile'] = '?0';
    headers['sec-ch-ua-platform'] = '"Windows"';
    callback({ requestHeaders: headers });
  });

  // Covers the main window and every popup created afterwards.
  app.on('web-contents-created', (_event, webContents) => {
    webContents.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      webContents
        .executeJavaScript(UA_DATA_SOURCE, true)
        .then(() => log.debug('Spoofed navigator identity (Windows / Google Chrome)'))
        .catch((err) => log.debug('UA data patch failed:', err.message));
    });
  });

  log.debug(`User agent presented to Disney+: ${USER_AGENT}`);
}

module.exports = { applyUserAgent, USER_AGENT, SEC_CH_UA, UA_DATA_SOURCE };