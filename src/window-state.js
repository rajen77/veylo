'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const log = require('./logger');

// Electron's screen API is unavailable until the app is ready.
function getScreen() {
  return require('electron').screen;
}

const FILE_NAME = 'window-state.json';
const DEFAULTS = { width: 1280, height: 800 };

// Keep enough of the window visible for the window manager and user.
const MIN_VISIBLE_PX = 80;

const MIN_SIZE = { width: 480, height: 360 };

// Ignore window-manager rounding to prevent geometry drift across restarts.
const GEOMETRY_EPSILON = 8;

const MODES = ['normal', 'maximized', 'fullscreen'];

function stateFile() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function isRectangle(value) {
  return (
    value &&
    typeof value === 'object' &&
    ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(value[key]))
  );
}

function isSameWithinRounding(a, b) {
  if (!a || !b) return false;
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= GEOMETRY_EPSILON);
}

function displayById(id) {
  if (!Number.isFinite(id)) return null;
  return getScreen().getAllDisplays().find((display) => display.id === id) || null;
}

function clampToDisplay(bounds, display) {
  const area = display.workArea;
  const width = Math.max(MIN_SIZE.width, Math.min(Math.round(bounds.width), area.width));
  const height = Math.max(MIN_SIZE.height, Math.min(Math.round(bounds.height), area.height));

  const minX = area.x - width + MIN_VISIBLE_PX;
  const maxX = area.x + area.width - MIN_VISIBLE_PX;
  const minY = area.y;
  const maxY = area.y + area.height - MIN_VISIBLE_PX;

  return {
    x: Math.round(Math.min(Math.max(bounds.x, minX), maxX)),
    y: Math.round(Math.min(Math.max(bounds.y, minY), maxY)),
    width,
    height,
  };
}

function load(storedFile = stateFile(), preferredDisplayId = null) {
  const screen = getScreen();
  try {
    const raw = JSON.parse(fs.readFileSync(storedFile, 'utf8'));

    const mode = MODES.includes(raw.mode) ? raw.mode : 'normal';
    const display = displayById(preferredDisplayId) || displayById(raw.displayId) || screen.getPrimaryDisplay();

    let bounds = isRectangle(raw.bounds) ? raw.bounds : null;
    if (!bounds && isRectangle(raw)) {
      // Preserve compatibility with older flat state files.
      bounds = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    }
    if (!bounds) {
      bounds = {
        width: DEFAULTS.width,
        height: DEFAULTS.height,
        x: display.workArea.x + Math.round((display.workArea.width - DEFAULTS.width) / 2),
        y: display.workArea.y + Math.round((display.workArea.height - DEFAULTS.height) / 2),
      };
    }

    const area = display.workArea;
    const overlaps = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x &&
      bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    // Maximized windows need most of their normal bounds on the target display.
    if (!overlaps || screen.getDisplayMatching(bounds).id !== display.id) {
      bounds = clampToDisplay(bounds, display);
      bounds = {
        ...bounds,
        x: area.x + Math.round((area.width - bounds.width) / 2),
        y: area.y + Math.round((area.height - bounds.height) / 2),
      };
    }

    return { mode, displayId: display.id, bounds: clampToDisplay(bounds, display) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`Window state could not be read from ${storedFile}: ${err.message}`);
    }
    const display = displayById(preferredDisplayId) || screen.getPrimaryDisplay();
    return {
      mode: 'normal',
      displayId: display.id,
      bounds: {
        width: DEFAULTS.width,
        height: DEFAULTS.height,
        x: display.workArea.x + Math.round((display.workArea.width - DEFAULTS.width) / 2),
        y: display.workArea.y + Math.round((display.workArea.height - DEFAULTS.height) / 2),
      },
    };
  }
}

function writeState(file, state) {
  const payload = { ...state, savedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
    log.debug(`Window state saved: ${state.mode} ${JSON.stringify(state.bounds)} display ${state.displayId}`);
  } catch (err) {
    log.warn(`Window state could not be saved to ${file}: ${err.message}`);
  }
}

function saveDisplay(displayId, storedFile = stateFile()) {
  writeState(storedFile, load(storedFile, displayId));
}

// Save during the session as well as on close, which may not run after a crash.
class WindowStateKeeper {
  /**
   * @param {import('electron').BrowserWindow} win
   * @param {object} [initial] the state the window was restored from, used to
   *   seed the windowed geometry so that a session spent entirely maximized or
   *   fullscreen still remembers the size to return to.
   * @param {string} [storedFile]
   */
  constructor(win, initial = null, storedFile = stateFile()) {
    this.window = win;
    this.file = storedFile;
    this.displayId = initial && Number.isFinite(initial.displayId) ? initial.displayId : null;
    this.bounds = initial && isRectangle(initial.bounds) ? initial.bounds : null;
    this.mode = initial && MODES.includes(initial.mode) ? initial.mode : 'normal';
    this.saveTimer = null;
    this.settleTimer = null;

    this.rememberDisplay();
    this.capture();

    for (const event of ['move', 'resize']) {
      win.on(event, () => this.scheduleSave());
    }

    for (const event of ['maximize', 'enter-full-screen']) {
      win.on(event, () => {
        this.mode = this.currentMode();
        this.save();
      });
    }

    // Restore events can precede the final window-manager geometry.
    for (const event of ['unmaximize', 'leave-full-screen']) {
      win.on(event, () => {
        this.mode = this.currentMode();
        this.save();
        this.settle();
      });
    }

    win.on('moved', () => {
      this.rememberDisplay();
      this.scheduleSave();
    });
  }

  currentMode() {
    const win = this.window;
    if (win.isDestroyed()) return this.mode;
    // Minimized windows do not report their previous mode reliably.
    if (win.isMinimized()) return this.mode;
    if (win.isFullScreen()) return 'fullscreen';
    if (win.isMaximized()) return 'maximized';
    return 'normal';
  }

  rememberDisplay() {
    if (!this.window || this.window.isDestroyed()) return;
    try {
      const display = getScreen().getDisplayMatching(this.window.getBounds());
      if (display && display.id !== this.displayId) {
        this.displayId = display.id;
        log.debug(`Window moved to display ${display.id}`);
      }
    } catch (err) {
      log.debug('Display lookup failed:', err.message);
    }
  }

  capture() {
    const win = this.window;
    if (!win || win.isDestroyed() || win.isMinimized()) return;

    this.mode = this.currentMode();
    this.rememberDisplay();

    // This Electron build can report fullscreen bounds as normal bounds.
    if (this.mode !== 'normal') return;

    let best = null;
    try {
      const normal = win.getNormalBounds();
      if (isRectangle(normal) && normal.width > 0 && normal.height > 0 && this.plausible(normal)) {
        best = normal;
      }
    } catch {
      /* fall through to getBounds */
    }
    if (!best) {
      const current = win.getBounds();
      if (!isRectangle(current) || !this.plausible(current)) return;
      best = current;
    }

    if (this.bounds && isSameWithinRounding(this.bounds, best)) return;
    this.bounds = best;
  }

  // Filter fullscreen-sized and intermediate restore geometry.
  plausible(rect) {
    const displays = getScreen().getAllDisplays();
    const height = displays.some((display) => Math.abs(rect.height - display.bounds.height) <= 2);
    if (height) return false;
    return !displays.some((display) => {
      const area = display.bounds;
      return (
        Math.abs(rect.x - area.x) <= 2 &&
        Math.abs(rect.y - area.y) <= 2 &&
        Math.abs(rect.width - area.width) <= 2
      );
    });
  }

  settle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.capture();
      this.save();
    }, 600);
  }

  // Coalesce rapid window-manager events.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.capture();
      this.save();
    }, 400);
  }

  save() {
    const win = this.window;
    if (!win || win.isDestroyed()) return;
    if (!this.bounds) this.capture();
    // Do not overwrite usable state with null geometry.
    if (!this.bounds) return;

    const state = {
      mode: this.mode,
      displayId: this.displayId,
      bounds: this.bounds,
    };
    writeState(this.file, state);
  }

  flush() {
    const settling = Boolean(this.settleTimer);
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    if (settling && this.window && !this.window.isDestroyed() && !this.window.isMinimized()) this.rememberDisplay();
    else this.capture();
    this.save();
  }
}

module.exports = { load, saveDisplay, WindowStateKeeper, stateFile, clampToDisplay, MODES };
