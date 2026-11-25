'use strict';

// Configure Chromium before app readiness and zygote startup.
const flags = require('./flags');
const { applySwitches } = flags;
const { shouldDisableSandbox } = require('./sandbox');

const { app, BrowserWindow, components, dialog, ipcMain, Menu, screen } = require('electron');
const log = require('./logger');

// Packaged builds do not pass through the development launcher.
disallowUnusableSandbox();

function disallowUnusableSandbox() {
  const { disable, reason, helper } = shouldDisableSandbox();
  if (!disable) return;

  // The zygote also fails when the sandbox is unavailable.
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('no-zygote');

  log.warn(`Chromium process sandbox is unavailable (${reason}); starting without it.`);
  if (helper) {
    log.warn(`To re-enable it: sudo chown root:root ${helper} && sudo chmod 4755 ${helper}`);
  }
}

let applied = { nvidia: false, nvidiaVaapi: false };

applied = applySwitches();

const { MainWindow } = require('./window');
const { applyBrowserLanguage } = require('./user-agent');
const { Playback } = require('./playback');
const { TrayController } = require('./tray');
const { Updater } = require('./updater');
const { buildMenu } = require('./menu');
const { SERVICES, getService, resolveService, availableInRegion, orderedServices } = require('./services');
const { detectCountry, regionCode, confirmRegionalAccess } = require('./region');
const prefsStore = require('./prefs');
const { pickService, focusPicker } = require('./picker');
const { load: loadWindowState, saveDisplay } = require('./window-state');
const { serviceFromArgv } = require('./cli');
const i18n = require('./i18n');

// Avoid competing MPRIS entries and Widevine sessions.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  log.info('Another instance is already running; focusing it.');
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const requested = serviceFromArgv(argv);
    if (requested && windowController.isAlive) {
      switchService(requested.id).catch((err) => log.error('Service switch failed:', err.message));
    }
    if (windowController.isAlive) windowController.show();
    else focusPicker();
  });
}

app.setName('veylo');
app.setAppUserModelId('io.github.veylo.Client');

let prefs = prefsStore.load();
const cliService = serviceFromArgv(process.argv.slice(1));
let activeService = cliService || resolveService(prefs.lastServiceId);
let switching = false;
// Closing the startup chooser is handled by its promise, not window-all-closed.
let pickerOpen = false;

const windowController = new MainWindow({
  serviceId: activeService.id,
  onStateHint: (hint) => {
    if (hint === 'reload-needed' && windowController.isAlive) {
      log.warn('Reloading the player after a renderer crash');
      windowController.window.webContents.reload();
      return;
    }
    // Avoid focusing a nonexistent window on a subsequent launch.
    if (hint === 'window-closed' && !switching) {
      log.info('Window closed; releasing the single-instance lock');
      app.releaseSingleInstanceLock();
    }
  },
});

windowController.titlebar.register();

// Avoid repeated X11/Wayland round trips for an unchanged title.
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

const updater = new Updater({ getWindow: () => windowController.window });

const tray = new TrayController({
  window: windowController,
  updater,
  getServiceName: () => activeService.name,
  onQuit: () => {
    log.info('Quit requested from the tray');
    shutdown(0);
  },
});

function applyLanguage() {
  i18n.setLanguage(i18n.resolve(prefs.language, app.getLocale()));
  applyBrowserLanguage();
  tray.rebuild();
  const labels = i18n.titlebarLabels();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('veylo:titlebar-labels', labels);
  }
}

function rebuildMenu() {
  buildMenu({
    window: windowController,
    media: playback,
    updater,
    flags: applied,
    services: orderedServices(prefs, regionCode()).map((service) => ({
      ...service,
      unavailable: !availableInRegion(service, regionCode()),
      unknownRegion: !regionCode(),
    })),
    activeServiceId: activeService.id,
    autoOpen: prefs.autoOpen,
    hideUnavailable: prefs.hideUnavailable,
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
    onToggleHideUnavailable: () => {
      prefs = { ...prefs, hideUnavailable: !prefs.hideUnavailable };
      prefsStore.save(prefs);
      rebuildMenu();
    },
    onOpenPicker: () => {
      showPicker()
        .then(() => { if (!windowController.isAlive) shutdown(0); })
        .catch((err) => log.error('Service picker failed:', err.message));
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

// BrowserWindow partitions are immutable; switching services requires a new window.
async function switchService(id, confirmed = false, displayId = null) {
  const next = getService(id);
  if (!next) return;
  const sameDisplay = !windowController.isAlive || displayId === null ||
    screen.getDisplayMatching(windowController.window.getBounds()).id === displayId;
  if (next.id === activeService.id && sameDisplay) return;
  if (switching) return;
  switching = true;
  try {
    if (!confirmed && !(await confirmService(next, windowController.window))) {
      setImmediate(rebuildMenu);
      return;
    }
    log.info(`Switching service: ${activeService.name} → ${next.name}`);
    activeService = next;
    prefs = { ...prefs, lastServiceId: next.id };
    prefsStore.save(prefs);
    windowController.destroy();
    windowController.service = next;
    windowController.create({ displayId });
    // The cached window title still points at the old window.
    lastWindowTitle = null;
    playback.requestRefresh();
    tray.setNowPlaying('');
    rebuildMenu();
    // Native menu radio toggles finish after the click handler returns.
    setImmediate(rebuildMenu);
  } finally {
    switching = false;
  }
}

async function confirmService(service, parent) {
  return confirmRegionalAccess(service, regionCode(), parent, { dialog, t: i18n.t });
}

function changePickerPrefs(action, arrangement) {
  if (action === 'hide' && typeof arrangement === 'boolean') {
    prefs = { ...prefs, hideUnavailable: arrangement };
  } else if (action === 'save' && arrangement &&
    Array.isArray(arrangement.favorites) && Array.isArray(arrangement.serviceOrder) &&
    [...arrangement.favorites, ...arrangement.serviceOrder].every((id) => typeof id === 'string' && getService(id))) {
    prefs = {
      ...prefs,
      favorites: [...new Set(arrangement.favorites)],
      serviceOrder: [...new Set(arrangement.serviceOrder)],
    };
  } else {
    log.warn(`Invalid picker preference action: ${action}`);
    return prefs;
  }
  prefsStore.save(prefs);
  if (windowController.isAlive) rebuildMenu();
  return prefs;
}

async function showPicker() {
  if (pickerOpen) {
    focusPicker();
    return null;
  }
  pickerOpen = true;
  try {
    const display = windowController.isAlive
      ? screen.getDisplayMatching(windowController.window.getBounds())
      : screen.getAllDisplays().find((item) => item.id === loadWindowState().displayId) || screen.getPrimaryDisplay();
    const choice = await pickService({
      services: SERVICES,
      lastServiceId: activeService.id,
      prefs,
      country: regionCode(),
      onChange: changePickerPrefs,
      confirm: confirmService,
      display,
      onClose: (displayId) => {
        windowController.persistState();
        saveDisplay(displayId);
      },
    });
    if (!choice) return null;
    prefs = { ...prefs, autoOpen: choice.autoOpen };
    prefsStore.save(prefs);
    if (windowController.isAlive) {
      await switchService(choice.id, true, choice.displayId);
      windowController.show();
      rebuildMenu();
    }
    return choice;
  } finally {
    pickerOpen = false;
  }
}

let shuttingDown = false;
let cleanedUp = false;

// Both window close and app quit can reach cleanup.
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  switching = true; // the window is going away on purpose; keep the lock
  updater.stop();
  playback.stop();
  tray.destroy();
  windowController.destroy();
}

// Look up the current menu item at event time because rebuilding replaces it.
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
  i18n.setLanguage(i18n.resolve(prefs.language, app.getLocale()));
  // Electron's locale can be empty in a sandbox.
  log.info(`Language: ${i18n.language()} (preference: ${prefs.language}, system: ${app.getLocale() || process.env.LANGUAGE || process.env.LC_ALL || process.env.LANG || 'unknown'})`);
  if (process.platform !== 'linux') {
    log.warn('This client targets Linux; other platforms are untested.');
  }

  const country = await detectCountry();
  log.info(`Region: ${country || 'unknown'}`);

  // Prepare Widevine while the chooser is open; playback must wait for it.
  const widevineReady = (async () => {
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
  })();

  let openDirectly = prefs.autoOpen || Boolean(cliService);
  if (openDirectly && !(await confirmService(activeService, null))) openDirectly = false;
  let pickerDisplayId = null;
  if (!openDirectly) {
    const choice = await showPicker();
    if (!choice) {
      shutdown(0);
      return;
    }
    activeService = resolveService(choice.id);
    pickerDisplayId = choice.displayId;
    prefs = { ...prefs, lastServiceId: activeService.id, autoOpen: choice.autoOpen };
    prefsStore.save(prefs);
    windowController.service = activeService;
  }

  await widevineReady;
  windowController.create({ displayId: pickerDisplayId });

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

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'window') return;
  contents.setWindowOpenHandler(({ url }) => {
    log.debug(`Denying window.open from renderer: ${url}`);
    return { action: 'deny' };
  });
});

app.on('window-all-closed', () => {
  // Switching and closing the chooser can temporarily leave no windows.
  if (switching || pickerOpen) return;
  log.info('All windows closed; quitting');
  shutdown(0);
});

app.on('before-quit', () => {
  shuttingDown = true;
  switching = true; // the window is going away on purpose; keep the lock
  windowController.persistState();
  cleanup();
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception:', err.stack || err.message);
});

process.on('unhandledRejection', (reason) => {
  // Missing optional D-Bus services can reject asynchronously in sandboxes.
  const name = reason && (reason.type || reason.errorName || reason.name);
  if (name === 'org.freedesktop.DBus.Error.ServiceUnknown') {
    log.debug('A desktop D-Bus service is unavailable; MPRIS extras are limited:', reason.text || name);
    return;
  }
  log.error('Unhandled rejection:', reason);
});
