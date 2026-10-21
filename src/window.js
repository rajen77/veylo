'use strict';

const path = require('node:path');
const { BrowserWindow, shell, app } = require('electron');
const log = require('./logger');
const { isAllowed, isExternal } = require('./security');
const { MAIN_WORLD_SOURCE } = require('./codecs');
const { load: loadWindowState, WindowStateKeeper } = require('./window-state');
const { TitleBar } = require('./titlebar');

const START_URL = 'https://www.disneyplus.com/';
const PARTITION = 'persist:veylo';

/**
 * The player refuses to start on a user agent that advertises Electron, so the
 * bundled token is stripped to present a plain, current Chrome UA. This is a
 * compatibility measure only; the client still loads Disney's own web app and
 * performs no request rewriting.
 */
function normaliseUserAgent() {
  const original = app.userAgentFallback;
  const nameToken = app.name.replace(/[\\/]/g, '');
  const cleaned = original
    .replace(/\sElectron\/[\d.]+/, '')
    .replace(new RegExp(`\\s${nameToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/[\\d.]+`), '');
  if (cleaned !== original) {
    app.userAgentFallback = cleaned;
    log.debug(`User agent presented to Disney+: ${cleaned}`);
  }
}

class MainWindow {
  constructor({ onStateHint, titlebar } = {}) {
    this.window = null;
    this.onStateHint = onStateHint || (() => {});
    this.stateKeeper = null;
    // The stored state is read in create(), not here: it needs the `screen`
    // module, which is only usable once the app is ready.
    this.restored = null;
    this.titlebar = titlebar || new TitleBar({
      getWindow: () => this.window,
      toggleFullscreen: () => this.toggleFullscreen(),
    });
  }

  /**
   * Applies the stored mode and geometry.
   *
   * The order matters and follows two measured behaviours: fullscreen has to be
   * requested while the window is still hidden, otherwise the compositor maps
   * it windowed first and it visibly jumps; and the window has to be positioned
   * before it goes fullscreen, otherwise it lands on the primary display rather
   * than the one it was left on.
   */
  applyRestoredState() {
    const { mode, bounds, displayId } = this.restored;
    log.info(
      `Restoring window: ${mode} at ${bounds.width}x${bounds.height}+${bounds.x}+${bounds.y} ` +
      `on display ${displayId}`,
    );

    this.window.setBounds(bounds);
    if (mode === 'maximized') this.window.maximize();
    else if (mode === 'fullscreen') this.window.setFullScreen(true);
  }

  /**
   * Keeps the strip in step with the window. These signals are synchronous, so
   * the caption and the glyphs are already correct by the time the window is
   * shown rather than flipping a frame later.
   */
  wireTitlebarState() {
    const push = () => {
      if (!this.isAlive) return;
      TitleBar.sendState(this.window, TitleBar.stateFor(this.window));
    };

    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      this.window.on(event, push);
    }
    // The caption follows the title Disney+ sets, which changes as things play.
    this.window.on('page-title-updated', push);
    // A reload or a navigation creates a fresh document, so the strip has to be
    // told the state again once that document is ready.
    this.window.webContents.on('did-finish-load', push);
  }

  create() {
    normaliseUserAgent();

    const restored = loadWindowState();
    this.restored = restored;

    this.window = new BrowserWindow({
      x: restored.bounds.x,
      y: restored.bounds.y,
      width: restored.bounds.width,
      height: restored.bounds.height,
      minWidth: 480,
      minHeight: 360,
      title: 'Veylo',
      backgroundColor: '#040814',
      // The window controls are drawn by the client itself, so the native frame
      // is off. Edge and corner resizing still work on X11 with this build, and
      // the drag region is provided by the injected strip; only the native title
      // bar is gone.
      frame: false,
      autoHideMenuBar: true,
      show: false,
      // The window is usually shown with the pointer already over it, because it
      // is restored to where the user left it. Without this the first click only
      // focuses the window and is swallowed.
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Left at the default (true) on purpose: timers and animation frames
        // are throttled while the window is hidden, which is what keeps a
        // minimized client from burning CPU. See the note in src/flags.js.
        // Widevine needs this to be able to negotiate the EME session.
        enableBlinkFeatures: 'EncryptedMedia',
      },
    });

    this.applyRestoredState();

    // The window is shown here, before the page has loaded, and not from
    // 'ready-to-show' below.
    //
    // A frameless window on this platform is given a 32-bit ARGB visual, and its
    // surface only starts out opaque if it is mapped while still empty: showing
    // it for the first time once the page has already rendered leaves the whole
    // surface at alpha 0, so the desktop shows straight through the client until
    // something forces the surface to be recreated (entering fullscreen, or
    // resizing). Waiting for 'ready-to-show' is the usual advice, but here it is
    // exactly what triggers the bug. Nothing is lost by showing early: the
    // reserved background colour is what is on screen until the page paints.
    this.window.show();

    this.window.once('ready-to-show', () => {
      // Re-applying after the first paint protects against a window manager that
      // dropped the request made before the window was mapped.
      if (this.restored.mode === 'fullscreen' && !this.window.isFullScreen()) {
        this.window.setFullScreen(true);
      }
      if (this.restored.mode === 'maximized' && !this.window.isMaximized()) {
        this.window.maximize();
      }
      this.window.focus();
      TitleBar.sendState(this.window, TitleBar.stateFor(this.window));
      log.info('Page ready');
    });

    this.window.on('closed', () => {
      this.window = null;
    });

    // Closing the window quits the client. The state is flushed here rather than
    // only at shutdown because this is the last moment the window still exists
    // and can report its geometry.
    this.window.on('close', () => {
      if (this.stateKeeper) this.stateKeeper.flush();
    });

    this.wireTitlebarState();

    // Persistence is wired before the first load so that a transition during
    // startup is not missed. The restored state is passed in so that a session
    // spent entirely maximized or fullscreen still remembers the windowed size
    // to return to.
    this.stateKeeper = new WindowStateKeeper(this.window, this.restored);

    this.window.webContents.setWindowOpenHandler(({ url }) => this.handleWindowOpen(url));
    // The player must be told the truth about Dolby support before it picks a
    // stream, otherwise Disney+ serves E-AC-3 and playback dies with code 83.
    // See src/codecs.js.
    this.window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.window.webContents
        .executeJavaScript(MAIN_WORLD_SOURCE, true)
        .then(() => log.debug('Corrected codec capabilities in the page (Dolby audio reported unsupported)'))
        .catch((err) => log.debug('Codec capability patch failed:', err.message));
    });

    this.window.webContents.on('will-navigate', (event, url) => this.handleNavigate(event, url));
    this.window.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 is a user-initiated abort
      log.warn(`Load failed (${code} ${description}) for ${url}`);
    });
    this.window.webContents.on('render-process-gone', (_e, details) => {
      log.error('Renderer process gone:', details.reason);
      if (details.reason === 'crashed' || details.reason === 'oom') {
        this.onStateHint('reload-needed');
      }
    });

    this.window.loadURL(START_URL);
    log.info(`Loading ${START_URL}`);
    return this.window;
  }

  handleNavigate(event, url) {
    if (isAllowed(url)) return;
    event.preventDefault();
    log.info(`Navigation blocked inside the app: ${url}`);
    if (isExternal(url)) shell.openExternal(url).catch((err) => log.warn('openExternal failed:', err.message));
  }

  handleWindowOpen(url) {
    if (isAllowed(url)) {
      // Sign-in and account flows use genuine popups; they inherit the same
      // hardened web preferences and stay inside the app.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          parent: this.window,
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    log.info(`External link handed to the system browser: ${url}`);
    shell.openExternal(url).catch((err) => log.warn('openExternal failed:', err.message));
    return { action: 'deny' };
  }

  /** Picture-in-picture is native fullscreen video plus an always-on-top window. */
  setPinned(pinned) {
    if (!this.window || this.window.isDestroyed()) return false;
    this.window.setAlwaysOnTop(pinned, 'floating');
    this.window.setSkipTaskbar(pinned);
    return pinned;
  }

  toggleFullscreen() {
    if (!this.window || this.window.isDestroyed()) return;
    this.window.setFullScreen(!this.window.isFullScreen());
  }

  show() {
    if (!this.window || this.window.isDestroyed()) {
      this.create();
      return;
    }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  get isAlive() {
    return Boolean(this.window && !this.window.isDestroyed());
  }

  send(channel, ...args) {
    if (!this.isAlive) return;
    this.window.webContents.send(channel, ...args);
  }

  /** Called on the way out so nothing that changed since the last event is lost. */
  persistState() {
    if (this.stateKeeper) this.stateKeeper.flush();
  }

  destroy() {
    this.persistState();
    if (this.isAlive) this.window.destroy();
  }
}
module.exports = { MainWindow, START_URL, PARTITION };
