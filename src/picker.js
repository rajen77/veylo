'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const log = require('./logger');
const { t, language } = require('./i18n');

/**
 * The startup chooser: a small frameless window that asks which streaming
 * service to open. It is shown whenever "open on startup" is off, and its
 * answer decides the service for this run — and, if the box is ticked, the one
 * that opens on the next launch without asking.
 *
 * The page is written to a file under the user-data directory with the service
 * icons inlined as data URLs. A real file rather than a data: URL, because the
 * chooser answers through its preload and preload delivery on data: pages is
 * not something to rely on; inlining the icons keeps the page independent of
 * where it is written.
 *
 * Like the main window, the chooser is shown before its content loads rather
 * than from 'ready-to-show': a frameless window mapped after the first paint
 * gets a transparent surface on this platform. See the note in src/window.js.
 */

let openWindow = null;

/** Focuses the chooser if it is still up. Returns false when it is not. */
function focusPicker() {
  if (!openWindow || openWindow.isDestroyed()) return false;
  if (openWindow.isMinimized()) openWindow.restore();
  openWindow.focus();
  return true;
}

/** Inlines an icon so the data-URL page needs no file access. */
function iconDataUrl(file) {
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) {
    log.warn(`Service icon is missing: ${file}`);
    return '';
  }
  return image.resize({ width: 96, height: 96 }).toDataURL();
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Writes the chooser page where a file:// load (and its preload) works. */
function writePage(html) {
  const file = path.join(app.getPath('userData'), 'picker.html');
  try {
    fs.writeFileSync(file, html);
    return file;
  } catch (err) {
    log.warn(`Picker page could not be written to ${file}: ${err.message}`);
    return null;
  }
}

function buildHtml({ services, lastServiceId }) {
  const cards = services
    .map((service) => {
      const icon = iconDataUrl(service.icon);
      const last = service.id === lastServiceId;
      return [
        `<button class="card${last ? ' last' : ''}" type="button" data-id="${service.id}">`,
        icon ? `<img src="${icon}" alt="">` : '',
        `<span class="name">${escapeHtml(service.name)}</span>`,
        last ? `<span class="badge">${escapeHtml(t('picker.lastUsed'))}</span>` : '',
        '</button>',
      ].join('');
    })
    .join('');

  return `<!doctype html>
<html lang="${language()}">
<head>
<meta charset="utf-8">
<title>Veylo</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: flex; flex-direction: column; padding: 26px 28px 22px;
    background: #0b1220; color: #e6ecf5;
    font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-app-region: drag; user-select: none; -webkit-user-select: none;
  }
  h1 { margin: 0; font-size: 16px; font-weight: 600; }
  .sub { margin: 4px 0 18px; font-size: 12.5px; color: #93a3ba; }
  .cards { display: flex; gap: 14px; flex: 1; min-height: 0; }
  .card {
    -webkit-app-region: no-drag;
    flex: 1; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 10px; padding: 16px 10px; cursor: pointer;
    background: #131c2e; border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px; color: inherit; font: inherit;
    transition: border-color 0.12s, background 0.12s, transform 0.12s;
  }
  .card:hover { border-color: #4ea1ff; background: #16223a; }
  .card:focus-visible { outline: 2px solid #4ea1ff; outline-offset: 2px; }
  .card:active { transform: translateY(1px); }
  .card.last { border-color: rgba(78, 161, 255, 0.45); }
  .card img { width: 64px; height: 64px; object-fit: contain; }
  .card .name { font-size: 14px; font-weight: 600; }
  .card .badge {
    font-size: 10.5px; color: #7fb2ff; text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  .auto {
    -webkit-app-region: no-drag;
    display: flex; align-items: center; gap: 9px; margin-top: 16px;
    font-size: 12.5px; color: #b9c6d9; cursor: pointer;
  }
  .auto input { width: 15px; height: 15px; accent-color: #4ea1ff; cursor: pointer; }
  .hint { margin-top: 6px; font-size: 11px; color: #6d7d95; }
</style>
</head>
<body>
  <h1>${escapeHtml(t('picker.heading'))}</h1>
  <p class="sub">${escapeHtml(t('picker.subtitle'))}</p>
  <div class="cards">${cards}</div>
  <label class="auto">
    <input type="checkbox" id="auto">
    <span>${escapeHtml(t('picker.autoOpen'))}</span>
  </label>
  <div class="hint">${escapeHtml(t('picker.hint'))}</div>
  <script>
    (function () {
      var api = window.veyloPicker;
      var auto = document.getElementById('auto');
      var cards = document.querySelectorAll('.card');
      for (var i = 0; i < cards.length; i++) {
        cards[i].addEventListener('click', function (event) {
          api.select(event.currentTarget.getAttribute('data-id'), auto.checked);
        });
      }
      var preferred = document.querySelector('.card.last') || cards[0];
      if (preferred) preferred.focus();
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') api.cancel();
      });
    })();
  </script>
</body>
</html>`;
}

/**
 * Shows the chooser and resolves with the decision: `{ id, autoOpen }` when a
 * service was picked, `null` when the window was dismissed. The window is
 * destroyed before the promise settles, so the caller never has to clean up.
 *
 * @param {object} options
 * @param {import('./services').SERVICES} options.services
 * @param {string} options.lastServiceId highlighted as "last used"
 */
function pickService({ services, lastServiceId }) {
  const html = buildHtml({ services, lastServiceId });

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 500,
      height: 330,
      title: 'Veylo',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      backgroundColor: '#0b1220',
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      center: true,
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, 'picker-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
      },
    });

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('picker:select', onSelect);
      ipcMain.removeListener('picker:cancel', onCancel);
      win.removeAllListeners('closed');
      openWindow = null;
      if (!win.isDestroyed()) win.destroy();
      resolve(value);
    };

    function onSelect(_event, payload) {
      const id = payload && payload.id;
      if (!services.some((service) => service.id === id)) {
        log.warn(`Picker sent an unknown service: ${id}`);
        return;
      }
      settle({ id, autoOpen: Boolean(payload.autoOpen) });
    }

    function onCancel() {
      settle(null);
    }

    ipcMain.on('picker:select', onSelect);
    ipcMain.on('picker:cancel', onCancel);
    win.on('closed', () => settle(null));

    openWindow = win;
    const file = writePage(html);
    const loaded = file
      ? win.loadFile(file)
      : win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    Promise.resolve(loaded).catch((err) => log.warn('Service picker failed to load:', err.message));
    log.info('Service picker shown');
  });
}

module.exports = { pickService, focusPicker };
