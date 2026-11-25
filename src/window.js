'use strict';

const path = require('node:path');
const { BrowserWindow, session, shell } = require('electron');
const log = require('./logger');
const { isAllowed, isExternal, applyPermissionPolicy } = require('./security');
const { MAIN_WORLD_SOURCE } = require('./codecs');
const { MAIN_WORLD_SOURCE: EME_SOURCE } = require('./eme');
const { applyUserAgent } = require('./user-agent');
const i18n = require('./i18n');
const { load: loadWindowState, WindowStateKeeper } = require('./window-state');
const { TitleBar } = require('./titlebar');
const { resolveService } = require('./services');

class MainWindow {
  constructor({ onStateHint, titlebar, serviceId } = {}) {
    this.window = null;
    this.onStateHint = onStateHint || (() => {});
    this.stateKeeper = null;
    // The screen API is unavailable until app readiness.
    this.restored = null;
    this.titlebar = titlebar || new TitleBar({
      getWindow: () => this.window,
      toggleFullscreen: () => this.toggleFullscreen(),
    });
    this.service = resolveService(serviceId);
  }

  get serviceId() {
    return this.service.id;
  }

  // Position before fullscreen to select the display and avoid a visible jump.
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

  wireTitlebarState() {
    const push = () => {
      if (!this.isAlive) return;
      TitleBar.sendState(this.window, TitleBar.stateFor(this.window));
    };

    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
      this.window.on(event, push);
    }
    this.window.on('page-title-updated', push);
    // A navigation replaces the document and its title bar.
    this.window.webContents.on('did-finish-load', push);
  }

  create({ displayId } = {}) {
    const { partition } = this.service;

    // Each service uses a separate session partition and browser identity.
    applyUserAgent(partition, this.service.identity);
    applyPermissionPolicy(session.fromPartition(partition));

    const restored = loadWindowState(undefined, displayId);
    this.restored = restored;

    this.window = new BrowserWindow({
      x: restored.bounds.x,
      y: restored.bounds.y,
      width: restored.bounds.width,
      height: restored.bounds.height,
      minWidth: 480,
      minHeight: 360,
      title: `Veylo — ${this.service.name}`,
      // Taskbars may not match the window to its desktop entry.
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      backgroundColor: this.service.backgroundColor || '#040814',
      frame: false,
      autoHideMenuBar: true,
      show: false,
      // Do not swallow the first click when the window opens under the pointer.
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Widevine requires EME negotiation.
        enableBlinkFeatures: 'EncryptedMedia',
      },
    });

    this.applyRestoredState();

    // Mapping the empty frameless window avoids a transparent surface on X11.
    this.window.show();

    this.window.once('ready-to-show', () => {
      // Some window managers drop state requests made before mapping.
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
      this.stateKeeper = null;
      this.onStateHint('window-closed');
    });

    // This is the last chance to read geometry before the window is destroyed.
    this.window.on('close', () => {
      if (this.stateKeeper) this.stateKeeper.flush();
    });

    this.wireTitlebarState();

    // Seed normal bounds so maximized-only sessions retain their windowed size.
    this.stateKeeper = new WindowStateKeeper(this.window, this.restored);

    this.window.webContents.setWindowOpenHandler(({ url }) => this.handleWindowOpen(url));
    // Report codec support before stream selection to avoid unsupported E-AC-3.
    this.window.webContents.on('did-start-navigation', (_event, _url, _isInPlace, isMainFrame) => {
      if (!isMainFrame) return;
      this.window.webContents
        .executeJavaScript(MAIN_WORLD_SOURCE, true)
        .then(() => log.debug('Corrected codec capabilities in the page (Dolby audio reported unsupported)'))
        .catch((err) => log.debug('Codec capability patch failed:', err.message));
      // The Windows identity can trigger hardware-secure DRM unsupported by this build.
      this.window.webContents
        .executeJavaScript(EME_SOURCE, true)
        .then(() => log.debug('Downgraded EME robustness requests to SW secure'))
        .catch((err) => log.debug('EME robustness patch failed:', err.message));
      this.window.webContents.send('service:name', this.service.name);
      this.window.webContents.send('veylo:titlebar-labels', i18n.titlebarLabels());
    });

    // Resend after load because the preload may not yet be listening at navigation start.
    this.window.webContents.on('did-finish-load', () => {
      this.window.webContents.send('service:name', this.service.name);
      this.window.webContents.send('veylo:titlebar-labels', i18n.titlebarLabels());
    });
    this.window.webContents.on('will-navigate', (event, url) => this.handleNavigate(event, url));
    // A sign-in popup is allowed by its first URL only; later navigations
    // inside it go through the same allowlist as the main window.
    this.window.webContents.on('did-create-window', (child) => {
      child.webContents.on('will-navigate', (event, url) => this.handleNavigate(event, url));
      child.webContents.on('will-redirect', (event, url) => this.handleNavigate(event, url));
    });
    // Send early when the preload is already listening.
    this.window.webContents.send('service:name', this.service.name);
    this.window.webContents.send('veylo:titlebar-labels', i18n.titlebarLabels());
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

    this.window.loadURL(this.service.startUrl);
    log.info(`Loading ${this.service.startUrl} (${this.service.name})`);
    return this.window;
  }

  handleNavigate(event, url) {
    if (isAllowed(url, this.service)) return;
    event.preventDefault();
    log.info(`Navigation blocked inside the app: ${url}`);
    if (isExternal(url, this.service)) {
      shell.openExternal(url).catch((err) => log.warn('openExternal failed:', err.message));
    }
  }

  handleWindowOpen(url) {
    if (isAllowed(url, this.service)) {
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
            partition: this.service.partition,
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
    this.window = null;
    this.stateKeeper = null;
  }
}
module.exports = { MainWindow };
