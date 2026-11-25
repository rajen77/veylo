'use strict';

const { ipcMain, Menu, app } = require('electron');
const log = require('./logger');

// Linux overlays do not reliably receive input, so the preload draws the controls.

const COMMANDS = {
  'window:titlebar:minimize': (win) => win.minimize(),
  'window:titlebar:maximize': (win) => (win.isMaximized() ? win.unmaximize() : win.maximize()),
  'window:titlebar:close': (win) => win.close(),
};

// Keep in sync with the preload so the fallback menu anchor stays below the strip.
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

  // Clamp the renderer-supplied anchor to keep the menu inside the window.
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
