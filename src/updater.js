'use strict';

const fs = require('node:fs');
const { app, dialog, shell } = require('electron');
const log = require('./logger');
const { t } = require('./i18n');

const FLATPAK_INFO = '/.flatpak-info';
const CHECK_DELAY_MS = 20_000;
const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

/**
 * Update strategy depends on how the client was installed:
 *
 *  - Flatpak: the sandbox has no write access to its own deployment, and the
 *    runtime is delivered by the remote. The correct behaviour is therefore to
 *    tell the user to run `flatpak update`, not to self-patch.
 *  - AppImage / deb / source: point the user at the release page, which on
 *    Linux is the only safe way to replace a running binary.
 */
class Updater {
  /**
   * @param {object} [options]
   * @param {string} [options.feedUrl] release feed URL; defaults to VEYLO_UPDATE_FEED
   * @param {() => import('electron').BrowserWindow | null} [options.getWindow]
   *   resolves the window dialogs attach to at call time. The player window is
   *   rebuilt on every service switch, so a window captured once at
   *   construction would go stale.
   */
  constructor({ feedUrl, getWindow } = {}) {
    this.feedUrl = feedUrl || process.env.VEYLO_UPDATE_FEED || '';
    this.getWindow = getWindow || (() => null);
    this.timer = null;
    this.interval = null;
    this.isFlatpak = fs.existsSync(FLATPAK_INFO);
  }

  /** The window the next dialog should attach to, or null before it exists. */
  get window() {
    return this.getWindow();
  }

  get configured() {
    return Boolean(this.feedUrl);
  }

  start() {
    if (!this.configured) return;
    this.timer = setTimeout(() => this.check({ interactive: false }), CHECK_DELAY_MS);
    this.timer.unref?.();
    this.interval = setInterval(() => this.check({ interactive: false }), CHECK_INTERVAL_MS);
    this.interval.unref?.();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  compareVersions(a, b) {
    const normalise = (v) => String(v || '').replace(/^v/, '').split(/[.+-]/).map((p) => parseInt(p, 10) || 0);
    const left = normalise(a);
    const right = normalise(b);
    const length = Math.max(left.length, right.length);
    for (let i = 0; i < length; i += 1) {
      const l = left[i] || 0;
      const r = right[i] || 0;
      if (l !== r) return l > r ? 1 : -1;
    }
    return 0;
  }

  async fetchLatest() {
    const response = await fetch(this.feedUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'veylo' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Update feed responded with ${response.status}`);
    const data = await response.json();
    return {
      version: String(data.tag_name || data.version || '').replace(/^v/, ''),
      htmlUrl: data.html_url || data.url || '',
      notes: data.body || '',
    };
  }

  async check({ interactive = false } = {}) {
    if (!this.configured) {
      if (interactive) {
        await dialog.showMessageBox(this.window, {
          type: 'info',
          title: t('dialogs.updates.title'),
          message: t('dialogs.updates.notConfigured'),
          detail: this.isFlatpak
            ? t('dialogs.updates.notConfiguredFlatpak')
            : t('dialogs.updates.notConfiguredEnv'),
          buttons: [t('menu.ok')],
        });
      }
      return { status: 'not-configured' };
    }

    const current = app.getVersion();
    try {
      const latest = await this.fetchLatest();
      if (!latest.version) return { status: 'unknown' };

      if (this.compareVersions(latest.version, current) > 0) {
        log.info(`Update available: ${current} -> ${latest.version}`);
        await this.promptUpdate(current, latest);
        return { status: 'available', latest: latest.version };
      }

      log.debug(`Up to date (${current})`);
      if (interactive) {
        await dialog.showMessageBox(this.window, {
          type: 'info',
          title: t('dialogs.updates.title'),
          message: t('dialogs.updates.upToDate', { version: current }),
          buttons: [t('menu.ok')],
        });
      }
      return { status: 'current', current };
    } catch (err) {
      log.warn('Update check failed:', err.message);
      if (interactive) {
        await dialog.showMessageBox(this.window, {
          type: 'warning',
          title: t('dialogs.updates.title'),
          message: t('dialogs.updates.failed'),
          detail: err.message,
          buttons: [t('menu.ok')],
        });
      }
      return { status: 'error', error: err.message };
    }
  }

  async promptUpdate(current, latest) {
    const detail =
      t('dialogs.updates.installed', { current, latest: latest.version }) +
      (this.isFlatpak ? t('dialogs.updates.flatpakHint') : '');

    // The buttons are matched by id rather than by their text: the text is
    // translated, the id is not.
    const choices = this.isFlatpak
      ? [
        { id: 'copy', label: t('dialogs.updates.buttons.copyCommand') },
        { id: 'release', label: t('dialogs.updates.buttons.openRelease') },
        { id: 'later', label: t('dialogs.updates.buttons.later') },
      ]
      : [
        { id: 'release', label: t('dialogs.updates.buttons.openRelease') },
        { id: 'later', label: t('dialogs.updates.buttons.later') },
      ];
    const { response } = await dialog.showMessageBox(this.window, {
      type: 'info',
      title: t('dialogs.updates.availableTitle'),
      message: t('dialogs.updates.availableMessage', { version: latest.version }),
      detail,
      buttons: choices.map((choice) => choice.label),
      defaultId: 0,
      cancelId: choices.length - 1,
    });

    const choice = choices[response];
    if (choice && choice.id === 'copy') {
      const { clipboard } = require('electron');
      clipboard.writeText('flatpak update io.github.veylo.Client');
      log.info('Flatpak update command copied to the clipboard');
    } else if (choice && choice.id === 'release' && latest.htmlUrl) {
      await shell.openExternal(latest.htmlUrl);
    }
  }
}

module.exports = { Updater };
