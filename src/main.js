'use strict';

// These two modules must be required before anything that touches `app`. The
// switches have to exist before the ready event, and the sandbox decision has
// to exist before Chromium starts its zygote.
const flags = require('./flags');
const { applySwitches } = flags;
const { shouldDisableSandbox } = require('./sandbox');

const { app, BrowserWindow, components, ipcMain, Menu } = require('electron');
const log = require('./logger');

// Chromium cannot start without a usable sandbox, and a missing one kills the
// process before any window appears. scripts/launch.js handles this for the
// development path, but a packaged build is started straight through the desktop
// entry or the AppImage runtime, which never runs the launcher. Applying it here
// as well covers every way the app can be started.
disallowUnusableSandbox();

function disallowUnusableSandbox() {
  const { disable, reason, helper } = shouldDisableSandbox();
  if (!disable) return;

  // --no-zygote is required in addition to --no-sandbox: without it Chromium
  // still forks a zygote, which fails under the same restriction.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');

  log.warn(`Chromium process sandbox is unavailable (${reason}); starting without it.`);
  if (helper) {
    log.warn(`To re-enable it: sudo chown root:root ${helper} && sudo chmod 4755 ${helper}`);
  }
}

let applied = { nvidia: false, nvidiaVaapi: false };

// The switches have to exist before the ready event, so they come first.
applied = applySwitches();

const { MainWindow } = require('./window');
const { Playback } = require('./playback');
const { TrayController } = require('./tray');
const { Updater } = require('./updater');
const { buildMenu } = require('./menu');
const { SERVICES, getService, resolveService } = require('./services');
const prefsStore = require('./prefs');
const { pickService, focusPicker } = require('./picker');
const i18n = require('./i18n');

// A second instance would create a competing MPRIS entry and a second Widevine
// session, so hand focus back to the running one instead. While the service
// chooser is up there is no player window yet, so the second launch focuses
// that instead of starting a second chooser.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('Another instance is already running; focusing it.');
  app.quit();
} else {
  // Focus the player if there is one, otherwise the startup chooser: while the
  // chooser is up no main window exists yet.
  app.on('second-instance', () => {
    if (windowController.isAlive) windowController.show();
    else focusPicker();
  });
}

app.setName('veylo');
app.setAppUserModelId('io.github.veylo.Client');

// Which service to open, and whether to open it without asking. Read before
// the window exists so the very first launch already knows what to show.
let prefs = prefsStore.load();
let activeService = resolveService(prefs.lastServiceId);
let switching = false;
// True while the startup chooser is the only window: closing it is the picker's
// own decision (handled by its promise), not the user quitting the app.
let pickerOpen = false;

const windowController = new MainWindow({
  serviceId: activeService.id,
  onStateHint: (hint) => {
    if (hint === 'reload-needed' && windowController.isAlive) {
      log.warn('Reloading the player after a renderer crash');
      windowController.window.webContents.reload();
      return;
    }
    // The window is gone: leave the single-instance lock so the next launch
    // starts a fresh chooser instead of focusing nothing.
    if (hint === 'window-closed' && !switching) {
      log.info('Window closed; releasing the single-instance lock');
      app.releaseSingleInstanceLock();
    }
  },
});

// The window controls are drawn by the client, so the main process has to
// answer for them. Registering here rather than in the window module keeps the
// IPC surface in one place.
windowController.titlebar.register();

// The media state arrives every second while something plays; only touch the
// native window title when it actually changed, otherwise every update is an
// X11/Wayland round trip for the same string.
let lastWindowTitle = null;
// The fullscreen listener is attached once per window; see syncFullscreenMenuItem().
let fullscreenSyncedWindow = null;

const playback = new Playback({
  window: windowController,
  onTitleChange: (title) => {
    tray.setNowPlaying(title);
    const next = title ? `${title} — Veylo` : 'Veylo';
    if (next !== lastWindowTitle) {
      lastWindowTitle = next;
      windowController.window?.setTitle(next);
    }
  },
});

const updater = new Updater({ window: windowController.window });

const tray = new TrayController({
  window: windowController,
  updater,
  getServiceName: () => activeService.name,
  onQuit: () => {
    log.info('Quit requested from the tray');
    shutdown(0);
  },
});

/**
 * Applies the active language everywhere it can change without a restart: the
 * tray labels and the title-bar labels of every open window. The menu is
 * rebuilt by the caller (its labels are only read while it is built), and the
 * chooser exists only during startup, where it reads the language itself.
 */
function applyLanguage() {
  i18n.setLanguage(i18n.resolve(prefs.language, app.getLocale()));
  tray.rebuild();
  const labels = i18n.titlebarLabels();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('veylo:titlebar-labels', labels);
  }
}

/**
 * Rebuilds the application menu so that the service radio buttons and the
 * "open on startup" checkbox show the current state. Called after every change
 * rather than only at startup, because the menu is built once.
 */
function rebuildMenu() {
  buildMenu({
    window: windowController,
    media: playback,
    updater,
    flags: applied,
    services: SERVICES,
    activeServiceId: activeService.id,
    autoOpen: prefs.autoOpen,
    languagePref: prefs.language,
    onSwitchService: (id) => {
      switchService(id).catch((err) => log.error('Service switch failed:', err.message));
    },
    onToggleAutoOpen: () => {
      prefs = { ...prefs, autoOpen: !prefs.autoOpen };
      prefsStore.save(prefs);
      log.info(`Open on startup: ${prefs.autoOpen ? 'on' : 'off'}`);
      rebuildMenu();
    },
    onSetLanguage: (value) => {
      if (prefs.language === value) return;
      prefs = { ...prefs, language: value };
      prefsStore.save(prefs);
      applyLanguage();
      rebuildMenu();
      log.info(`Language: ${i18n.language()} (preference: ${prefs.language})`);
    },
  });
  syncFullscreenMenuItem();
}

/**
 * Opens another service in place of the current one. The window is rebuilt
 * rather than navigated: each service has its own session partition, and a
 * BrowserWindow's partition is fixed when it is created.
 */
async function switchService(id) {
  const next = getService(id);
  if (!next || next.id === activeService.id) return;
  if (switching) return;
  switching = true;
  try {
    log.info(`Switching service: ${activeService.name} → ${next.name}`);
    activeService = next;
    prefs = { ...prefs, lastServiceId: next.id };
    prefsStore.save(prefs);
    windowController.destroy();
    windowController.service = next;
    windowController.create();
    // The updater and the cached window title still point at the old window.
    updater.window = windowController.window;
    lastWindowTitle = null;
    playback.requestRefresh();
    tray.setNowPlaying('');
    rebuildMenu();
  } finally {
    switching = false;
  }
}

let shuttingDown = false;
let cleanedUp = false;

/**
 * Releases everything that holds a resource. Kept separate from shutdown()
 * because the quit path can arrive from two directions: the window closing, or
 * the menu and tray calling app.quit(). Whichever happens first does the work
 * and the other one finds it already done.
 */
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  switching = true; // the window is going away on purpose; keep the lock
  updater.stop();
  playback.stop();
  tray.destroy();
  windowController.destroy();
}

/**
 * Keeps the View ▸ Fullscreen checkbox honest when the mode is changed from the
 * title bar button or with F11 rather than from the menu itself.
 *
 * The listeners are attached once per window and resolve the item through
 * Menu.getApplicationMenu() when they fire. Rebuilding the menu (on a service
 * switch or an option toggle) creates new item objects, so a listener bound to
 * an old item would update a detached one, and re-attaching on every rebuild
 * would stack listeners on a window that survived.
 */
function syncFullscreenMenuItem() {
  const win = windowController.window;
  if (!win || win.isDestroyed() || fullscreenSyncedWindow === win) return;
  fullscreenSyncedWindow = win;
  const update = () => {
    const menu = Menu.getApplicationMenu();
    const item = menu && menu.getMenuItemById('view-fullscreen');
    if (item) item.checked = Boolean(win.isFullScreen());
  };
  for (const event of ['enter-full-screen', 'leave-full-screen']) {
    win.on(event, update);
  }
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('Shutting down');
  cleanup();
  app.exit(code);
}

app.whenReady().then(async () => {
  log.info(`Veylo ${app.getVersion()}`);
  log.info(`Electron ${process.versions.electron}, Chromium ${process.versions.chrome}`);
  log.info(`Service: ${activeService.name} (auto-open ${prefs.autoOpen ? 'on' : 'off'})`);
  // Resolved before anything is shown: the chooser, the menu and the title bar
  // all read the language while they are built.
  i18n.setLanguage(i18n.resolve(prefs.language, app.getLocale()));
  log.info(`Language: ${i18n.language()} (preference: ${prefs.language}, system: ${app.getLocale()})`);
  if (process.platform !== 'linux') {
    log.warn('This client targets Linux; other platforms are untested.');
  }

  // The Widevine CDM is installed by the Component Updater on first launch. A
  // window created before this resolves will fail EME negotiation, so wait.
  try {
    log.info('Waiting for the Widevine component to be ready…');
    await components.whenReady();
    const status = components.status();
    log.info(`Widevine CDM version: ${status?.[components.WIDEVINE_CDM_ID]?.version || 'unknown'}`);
    log.debug('Component status:', JSON.stringify(status));
  } catch (err) {
    log.error('Widevine component could not be prepared:', err.message);
    log.error('Playback of protected content will fail until the CDM is available.');
  }

  // With "open on startup" off, ask which service to open. The chooser is its
  // own window, so the main one is only created once the answer is in.
  if (!prefs.autoOpen) {
    pickerOpen = true;
    let choice = null;
    try {
      choice = await pickService({ services: SERVICES, lastServiceId: activeService.id });
    } finally {
      pickerOpen = false;
    }
    // Dismissing the chooser quits the app (it is the only window, so closing
    // it already triggered window-all-closed, which the flag above suppressed).
    if (!choice) {
      shutdown(0);
      return;
    }
    activeService = resolveService(choice.id);
    prefs = { ...prefs, lastServiceId: activeService.id, autoOpen: choice.autoOpen };
    prefsStore.save(prefs);
    windowController.service = activeService;
  }

  windowController.create();

  // The window must exist before the menu and tray can reference it.
  updater.window = windowController.window;
  playback.start();
  tray.start();
  rebuildMenu();
  updater.start();

  if (applied.diagnostics) await flags.reportGpuStatus();

  if (applied.nvidia && !applied.nvidiaVaapi) {
    log.info('Tip: install nvidia-vaapi-driver for hardware video decoding on NVIDIA.');
  }

  app.on('activate', () => windowController.show());
});

ipcMain.on('media:state', (_event, state) => {
  if (!state || typeof state !== 'object') return;
  playback.updateState(state);
});

// The service chooser is its own window, so it needs its own handler: the
// global one below denies every window.open from a streaming page.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'window') return;
  contents.setWindowOpenHandler(({ url }) => {
    log.debug(`Denying window.open from renderer: ${url}`);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // A service switch closes the old window before the new one exists, and the
  // startup chooser closes itself before the player window is created; neither
  // gap may be read as the user quitting.
  if (switching || pickerOpen) return;
  // Closing the window is how the user quits, so this is the normal exit path
  // rather than something that only happens during a shutdown.
  log.info('All windows closed; quitting');
  shutdown(0);
});

app.on('before-quit', () => {
  shuttingDown = true;
  switching = true; // the window is going away on purpose; keep the lock
  // The window may still exist here when the quit came from the tray or from a
  // signal, so give it a last chance to record where it was.
  windowController.persistState();
  cleanup();
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  // mpris-service issues D-Bus calls asynchronously, so a missing desktop
  // service cannot be caught where the player is registered. That is expected
  // in a sandbox without a full session bus and must not be reported as a
  // crash: playback and media keys work, and only the extra MPRIS features
  // that the absent service would have provided are lost.
  const name = reason && (reason.type || reason.errorName || reason.name);
  if (name === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    log.debug('A desktop D-Bus service is unavailable; MPRIS extras are limited:', reason.text || name);
    return;
  }
  log.error('Unhandled rejection:', reason);
});
