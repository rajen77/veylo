'use strict';

const { ipcMain, Menu, app } = require('electron');
const log = require('./logger');

/**
 * Window controls for the frameless window.
 *
 * The controls are an ordinary DOM element injected by the preload (see the
 * "Window controls" section of src/preload.js) rather than a native title bar,
 * because that is the
 * only layer that receives input in this configuration. Two alternatives were
 * measured against this Electron build and rejected:
 *
 *  - `titleBarStyle: 'hidden'` with `titleBarOverlay` produces no usable title
 *    bar on Linux; the client area stays as large as always and nothing is
 *    drawn in the strip.
 *  - A `WebContentsView` stacked over the page, as Electron's "custom title
 *    bar" documentation describes, paints its content but is never the input
 *    target: clicks landed on the page underneath regardless of the view's
 *    bounds, its stacking order, or whether it was transparent.
 *
 * Because nothing is drawn over the page, the strip cannot cover the streaming
 * service's own header either; the page is asked to leave the strip empty
 * instead.
 *
 * Only a bare channel name travels over IPC and every channel maps to a fixed
 * action, so a compromised renderer cannot reach arbitrary window APIs.
 */

/** Channel to fixed action. 'fullscreen' and 'menu' need the controller. */
const COMMANDS = {
  'window:titlebar:minimize': (win) => win.minimize(),
  'window:titlebar:maximize': (win) => (win.isMaximized() ? win.unmaximize() : win.maximize()),
  'window:titlebar:close': (win) => win.close(),
};

/**
 * Mirrors TITLEBAR_HEIGHT in src/preload.js. Used only as the fallback anchor
 * for the menu when the renderer did not supply one, so the popup still opens
 * below the strip rather than over it.
 */
const TITLEBAR_HEIGHT = 36;

class TitleBar {
  /**
   * @param {object} hooks
   * @param {() => object | null} hooks.getWindow returns the window controller's window
   * @param {() => void} hooks.toggleFullscreen
   */
  constructor({ getWindow, toggleFullscreen }) {
    this.getWindow = getWindow;
    this.toggleFullscreen = toggleFullscreen;
    this.registered = false;
  }

  register() {
    if (this.registered) return;
    this.registered = true;

    for (const [channel, action] of Object.entries(COMMANDS)) {
      ipcMain.on(channel, () => {
        const win = this.getWindow();
        if (!win || win.isDestroyed()) return;
        log.debug(`Title bar: ${channel}`);
        try {
          action(win);
        } catch (err) {
          log.warn(`Title bar command ${channel} failed: ${err.message}`);
        }
      });
    }

    ipcMain.on('window:titlebar:fullscreen', () => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      log.debug('Title bar: toggle fullscreen');
      try {
        this.toggleFullscreen();
      } catch (err) {
        log.warn('Fullscreen toggle from the title bar failed:', err.message);
      }
    });

    ipcMain.on('window:titlebar:menu', (_event, anchor) => {
      const win = this.getWindow();
      if (!win || win.isDestroyed()) return;
      this.showMenu(win, anchor);
    });
  }

  /**
   * The menu button shows the real application menu, which is where the
   * accelerators, the update check and the About box already live, rather than
   * a second, parallel set of entries.
   *
   * The anchor comes from the renderer, which is the only side that knows where
   * the button ended up in the layout. It is clamped to the window so that a
   * button near an edge cannot push the popup off screen.
   */
  showMenu(win, anchor) {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;

    const { width, height } = win.getContentBounds();
    const point = anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      ? {
          x: Math.min(Math.max(Math.round(anchor.x), 0), Math.max(width - 1, 0)),
          y: Math.min(Math.max(Math.round(anchor.y), 0), Math.max(height - 1, 0)),
        }
      : { x: 0, y: TITLEBAR_HEIGHT };

    try {
      log.debug(`Title bar: menu at ${point.x},${point.y}`);
      menu.popup({ window: win, ...point });
    } catch (err) {
      log.debug('Application menu could not be shown:', err.message);
    }
  }

  static stateFor(win) {
    return {
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      title: win.getTitle(),
      version: app.getVersion(),
    };
  }

  static sendState(win, state) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('window:titlebar-state', state);
  }
}

module.exports = { TitleBar };
