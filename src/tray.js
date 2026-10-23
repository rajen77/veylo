'use strict';

const path = require('node:path');
const { Menu, Tray, nativeImage } = require('electron');
const log = require('./logger');
const { t } = require('./i18n');

const ASSETS = path.join(__dirname, '..', 'assets');

function trayImage() {
  // The 22px symbolic-ish icon matches the height of most Linux panels.
  const image = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  if (image.isEmpty()) {
    log.warn('Tray icon asset is missing; run "npm run icons" to regenerate it.');
    return image;
  }
  return image;
}

class TrayController {
  constructor({ window, onQuit, updater, getServiceName = () => '' }) {
    this.window = window;
    this.onQuit = onQuit;
    this.updater = updater;
    this.getServiceName = getServiceName;
    this.tray = null;
    this.lastTitle = '';
  }

  start() {
    try {
      this.tray = new Tray(trayImage());
    } catch (err) {
      // Headless sessions and some Wayland compositors have no tray host.
      log.warn('System tray is unavailable:', err.message);
      return false;
    }

    this.tray.setToolTip(`Veylo — ${this.getServiceName()}`);
    this.tray.on('click', () => this.window.show());
    this.tray.on('double-click', () => this.window.show());
    this.tray.on('middle-click', () => this.window.toggleFullscreen());
    this.rebuild();
    log.info('Tray icon created');
    return true;
  }

  rebuild() {
    if (!this.tray) return;
    const template = [
      { label: t('tray.show', { service: this.getServiceName() }), click: () => this.window.show() },
      { label: t('tray.fullscreen'), accelerator: 'F11', click: () => this.window.toggleFullscreen() },
      { type: 'separator' },
    ];

    if (this.lastTitle) {
      template.push({ label: t('tray.nowPlaying', { title: this.lastTitle }), enabled: false }, { type: 'separator' });
    }

    if (this.updater && this.updater.configured) {
      template.push({ label: t('tray.checkUpdates'), click: () => this.updater.check({ interactive: true }) });
      template.push({ type: 'separator' });
    }

    template.push({ label: t('tray.quit'), role: 'quit', accelerator: 'Ctrl+Q', click: () => this.onQuit() });

    this.tray.setContextMenu(Menu.buildFromTemplate(template));
  }

  setNowPlaying(title) {
    if (!this.tray) return;
    const clean = title || '';
    if (clean === this.lastTitle) return;
    this.lastTitle = clean;
    const service = this.getServiceName();
    this.tray.setToolTip(clean ? `Veylo — ${service} — ${clean}` : `Veylo — ${service}`);
    this.rebuild();
  }

  destroy() {
    if (!this.tray) return;
    this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayController };
