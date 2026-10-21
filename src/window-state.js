'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const log = require('./logger');

/**
 * `screen` is only usable once the app is ready, and this module is required
 * while the main process is still loading, so it is fetched on demand rather
 * than destructured at the top level.
 */
function getScreen() {
  return require('electron').screen;
}

/**
 * Remembers how the window was left: windowed, maximized or fullscreen, the
 * position and size it had in windowed mode, and which display it was on.
 *
 * Two Electron behaviours make this less direct than it looks, both measured
 * against the castLabs Electron 44 build used here:
 *
 *  - `getBounds()` is useless for persistence. Entering fullscreen or maximizing
 *    rewrites it, and a saved position is snapped back to the origin, so a
 *    window left at x=2231 on a second display is restored on the primary one.
 *    `getNormalBounds()` keeps the pre-maximize/pre-fullscreen bounds, so that
 *    is what gets stored.
 *  - The display has to be remembered explicitly. Centres are ambiguous on
 *    layouts where one display's bounds start at a negative coordinate, and the
 *    compositor moves a window that it considers off-screen.
 */

const FILE_NAME = 'window-state.json';
const DEFAULTS = { width: 1280, height: 800 };

// Bounds are only honoured by the window manager when the window is still at
// least partially visible, so a stored position always gets clamped into the
// work area of its display.
const MIN_VISIBLE_PX = 80;

// A display that was unplugged, a resolution change, or a corrupt file must not
// produce a window that cannot be dragged back.
const MIN_SIZE = { width: 480, height: 360 };

// A window manager is free to round a requested geometry, and the frameless
// setup here gets a scale factor that is not a whole number (0.921875 on the
// machine this was developed against), so a stored size is handed back slightly
// different from the one that was asked for. Saving that reading again would
// compound the difference: measured over six maximize cycles it grew the window
// by 2x1 px each time, without ever converging. A change this small is therefore
// treated as the window manager's rounding and not as the user resizing.
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

/** True when two rectangles differ by no more than the rounding allowance. */
function isSameWithinRounding(a, b) {
  if (!a || !b) return false;
  return ['x', 'y', 'width', 'height'].every((key) => Math.abs(a[key] - b[key]) <= GEOMETRY_EPSILON);
}

function displayById(id) {
  if (!Number.isFinite(id)) return null;
  return getScreen().getAllDisplays().find((display) => display.id === id) || null;
}

/** Clamp stored bounds into a display's work area, preserving size where possible. */
function clampToDisplay(bounds, display) {
  const area = display.workArea;
  const width = Math.max(MIN_SIZE.width, Math.min(Math.round(bounds.width), area.width));
  const height = Math.max(MIN_SIZE.height, Math.min(Math.round(bounds.height), area.height));

  // Leave a strip of the titlebar reachable instead of allowing a fully
  // off-screen window.
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

/**
 * Reads the stored state. The returned bounds are always usable: an unknown or
 * removed display falls back to the primary one, and unusable geometry is
 * discarded in favour of the defaults.
 */
function load(storedFile = stateFile()) {
  const screen = getScreen();
  try {
    const raw = JSON.parse(fs.readFileSync(storedFile, 'utf8'));

    const mode = MODES.includes(raw.mode) ? raw.mode : 'normal';
    const display = displayById(raw.displayId) || screen.getPrimaryDisplay();

    let bounds = isRectangle(raw.bounds) ? raw.bounds : null;
    if (!bounds && isRectangle(raw)) {
      // Tolerate an older or hand-edited file that stored the keys flat.
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

    return { mode, displayId: display.id, bounds: clampToDisplay(bounds, display) };
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`Window state could not be read from ${storedFile}: ${err.message}`);
    }
    const display = screen.getPrimaryDisplay();
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

/**
 * Watches a window and writes its state on every transition that changes it.
 *
 * Capturing the state from events rather than at exit is deliberate: a crash, a
 * SIGKILL or a session logout never reaches a save-on-quit path, and the
 * maximized/fullscreen transitions are exactly the moments the value changes.
 */
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

    // Entering a mode leaves the windowed geometry untouched, so the mode is
    // recorded at once while the geometry stays as it was.
    for (const event of ['maximize', 'enter-full-screen']) {
      win.on(event, () => {
        this.mode = this.currentMode();
        this.save();
      });
    }

    // Coming back is different: the window manager is still animating it into
    // its restored rectangle when the event arrives, and a reading taken then is
    // a blend of the two states (measured: unmaximizing recorded 1284x1067 for a
    // window whose real size is 1284x805). The mode is written immediately so
    // that a crash cannot lose it, and the geometry is re-read once the window
    // has settled.
    for (const event of ['unmaximize', 'leave-full-screen']) {
      win.on(event, () => {
        this.mode = this.currentMode();
        this.save();
        this.settle();
      });
    }

    // A window can be dragged to another display without being maximized or
    // resized, and that is precisely the case that used to be forgotten. The
    // 'moved' event only fires once the move has settled; 'move' updates the
    // display in the meantime so that a quit during a drag still records it.
    win.on('moved', () => {
      this.rememberDisplay();
      this.scheduleSave();
    });
  }

  currentMode() {
    const win = this.window;
    if (win.isDestroyed()) return this.mode;
    // A minimized window reports neither maximized nor fullscreen, so asking it
    // for its mode would silently downgrade a maximized window to 'normal' and
    // then record the maximized rectangle as the windowed geometry.
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

  /** Snapshot the geometry that matters, from the sources that actually hold it. */
  capture() {
    const win = this.window;
    if (!win || win.isDestroyed()) return;

    this.mode = this.currentMode();
    this.rememberDisplay();

    // Only a windowed window reports its windowed geometry. While maximized or
    // fullscreen, getNormalBounds() reports the maximized rect on this build
    // (measured: a window restored maximized at 900x640 reported 1792x1067), so
    // capturing then would overwrite the size to return to with the size it is
    // already filling. The seeded value is kept instead.
    if (this.mode !== 'normal') return;

    // getNormalBounds is the only accessor that still reports the windowed
    // geometry while maximized or fullscreen.
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

    // A reading that only differs by the window manager's rounding is not a
    // resize, so the stored geometry is left alone rather than accumulated.
    if (this.bounds && isSameWithinRounding(this.bounds, best)) return;
    this.bounds = best;
  }

  /**
   * Rejects a reading that cannot be the windowed geometry.
   *
   * A windowed window never fills a display, panels and all, so a rectangle that
   * matches one exactly is a fullscreen or maximized rectangle seen mid-restore.
   * The height is checked specifically because the transition that leaks it is
   * vertical: the width is already back to the windowed value while the height
   * is still on its way down.
   */
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

  /** Re-read the geometry once the window has finished being restored. */
  settle() {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      this.capture();
      this.save();
    }, 600);
  }

  /** Coalesce drag/zoom storms into one write. */
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
    // Nothing to record if the window has never been windowed and no state was
    // seeded; writing null bounds would lose the position entirely.
    if (!this.bounds) return;

    const payload = {
      mode: this.mode,
      displayId: this.displayId,
      bounds: this.bounds,
      // Kept for readability when someone opens the file.
      savedAt: new Date().toISOString(),
    };

    try {
      const file = this.file;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
      log.debug(`Window state saved: ${this.mode} ${JSON.stringify(this.bounds)} display ${this.displayId}`);
    } catch (err) {
      log.warn(`Window state could not be saved to ${this.file}: ${err.message}`);
    }
  }

  /** Flush a pending debounce before the process exits. */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer);
      this.settleTimer = null;
    }
    this.save();
  }
}

module.exports = { load, WindowStateKeeper, stateFile, clampToDisplay, MODES };
