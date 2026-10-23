'use strict';

// These two modules must be required before anything that touches `app`. The
// switches have to exist before the ready event, and the sandbox decision has
// to exist before Chromium starts its zygote.
const flags = require('./flags');
const { applySwitches } = flags;
const { shouldDisableSandbox } = require('./sandbox');

const { app, components, ipcMain } = require('electron');
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

// A second instance would create a competing MPRIS entry and a second Widevine
// session, so hand focus back to the running one instead.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('Another instance is already running; focusing it.');
  app.quit();
} else {
  app.on('second-instance', () => windowController.show());
}

app.setName('veylo');
app.setAppUserModelId('io.github.veylo.Client');

const windowController = new MainWindow({
  onStateHint: (hint) => {
    if (hint === 'reload-needed' && windowController.isAlive) {
      log.warn('Reloading the player after a renderer crash');
      windowController.window.webContents.reload();
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
  onQuit: () => {
    log.info('Quit requested from the tray');
    shutdown(0);
  },
});

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
  updater.stop();
  playback.stop();
  tray.destroy();
  windowController.destroy();
}

/**
 * Keeps the View ▸ Fullscreen checkbox honest when the mode is changed from the
 * title bar button or with F11 rather than from the menu itself.
 */
function syncFullscreenMenuItem(menu) {
  const item = menu.getMenuItemById('view-fullscreen');
  if (!item) return;
  const update = () => {
    const win = windowController.window;
    item.checked = Boolean(win && !win.isDestroyed() && win.isFullScreen());
  };
  for (const event of ['enter-full-screen', 'leave-full-screen']) {
    windowController.window.on(event, update);
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

  windowController.create();

  // The window must exist before the menu and tray can reference it.
  updater.window = windowController.window;
  playback.start();
  tray.start();
  const menu = buildMenu({ window: windowController, media: playback, updater, flags: applied });
  syncFullscreenMenuItem(menu);
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

// The renderer should never be able to spawn windows or navigate elsewhere on
// its own; webContents events in src/window.js arbitrate every navigation.
app.on('web-contents-created', (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    log.debug(`Denying window.open from renderer: ${url}`);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // Closing the window is how the user quits, so this is the normal exit path
  // rather than something that only happens during a shutdown.
  log.info('All windows closed; quitting');
  shutdown(0);
});

app.on('before-quit', () => {
  shuttingDown = true;
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
