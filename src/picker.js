'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
const log = require('./logger');
const { t, language } = require('./i18n');
const { computeLayout } = require('./picker-layout');
const { availableInRegion, orderedServices, moveService } = require('./services');

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

/**
 * Reads the layout constants the chooser's window size is computed from:
 * the body's horizontal padding, the card size, the grid gap, how many cards
 * there are, the grid's max-width, and the reserved scrollbar width.
 */
const READ_CONSTANTS_SOURCE = `(() => {
  const el = document.querySelector('.cards');
  const visible = el && el.querySelectorAll('.tile:not([hidden])');
  if (!visible || !visible.length) return null;
  const bodyStyle = getComputedStyle(document.body);
  const gridStyle = getComputedStyle(el);
  return {
    padL: parseFloat(bodyStyle.paddingLeft) || 0,
    padR: parseFloat(bodyStyle.paddingRight) || 0,
    cardW: visible[0].offsetWidth,
    gap: parseFloat(gridStyle.columnGap) || 0,
    cardCount: el.children.length,
    cap: parseFloat(gridStyle.maxWidth),
    scrollbar: el.offsetWidth - el.clientWidth,
  };
})()`;

/**
 * Builds the script that reports the height the page needs when its body is
 * laid out `width` pixels wide.
 *
 * The page cannot answer this from its own scroll metrics: `height: 100%`
 * pins html/body to the window (so scrollHeight reports the window height,
 * not the content's), scrollHeight drops the body's bottom padding once the
 * content overflows, and the cards area is a flex child capped by `flex: 1`
 * (so it shrinks to the window and hides how tall the grid naturally is).
 * The script releases those constraints, lays the body out at the exact width
 * the window is about to get, and reads the body's own box — which includes
 * its padding and is independent of the window. All services and arrangement
 * controls are temporarily shown so later changes do not require a resize.
 * Scrollbars are suppressed
 * during the measurement: a vertical scrollbar would take width away from the
 * body, which can drop the grid a column and report a height for the wrong
 * layout. Everything is restored before it returns, so the page never paints
 * the intermediate state.
 */
function heightSource(width) {
  return `(() => {
    const el = document.querySelector('.cards');
    if (!el) return null;
    const nodes = [document.documentElement, document.body, el];
    const saved = nodes.map((node) => node.getAttribute('style'));
    const hidden = Array.from(el.querySelectorAll('.tile[hidden]'));
    const wasEditing = el.classList.contains('editing');
    try {
      hidden.forEach((tile) => { tile.hidden = false; });
      el.classList.add('editing');
      document.documentElement.style.height = 'auto';
      document.documentElement.style.overflow = 'hidden';
      document.body.style.height = 'auto';
      document.body.style.width =
        Math.min(${Math.ceil(width)}, document.documentElement.clientWidth) + 'px';
      el.style.flex = '0 0 auto';
      el.style.minHeight = '0';
      el.style.overflow = 'visible';
      return Math.ceil(document.body.getBoundingClientRect().height);
    } finally {
      hidden.forEach((tile) => { tile.hidden = true; });
      if (!wasEditing) el.classList.remove('editing');
      nodes.forEach((node, i) => {
        if (saved[i] === null) node.removeAttribute('style');
        else node.setAttribute('style', saved[i]);
      });
    }
  })()`;
}

/** Resolves once the renderer has laid the page out after a resize. */
function nextFrames(win) {
  const frames = win.webContents
    .executeJavaScript(
      'new Promise((resolve) => ' +
        'requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
      true,
    )
    .catch(() => true);
  // Never wait on rAF alone: a window that is not being painted may not run
  // animation frames at all.
  return Promise.race([frames, new Promise((resolve) => setTimeout(resolve, 100))]);
}

/**
 * Sizes the chooser to its content so adding services never means resizing the
 * window by hand: the page wraps into as many rows as the list needs, and the
 * window grows to show them — but never past the display's work area. Content
 * that still does not fit scrolls inside the cards grid.
 *
 * The width is computed rather than measured: the grid's columns are fixed
 * tracks, so the width for a chosen column count is exact, while measuring
 * natural width would feed back on itself (a scrollbar takes width away, which
 * changes the column count, which changes the height, which decides whether
 * the scrollbar is there). The height is then measured with the window already
 * at its final width and re-checked after each application for the same
 * reason: a window that is still too short shows a scrollbar, and that can
 * change the row count.
 *
 * Window managers do not always grant exactly what is requested — this one
 * inflates by a few pixels — so each request is corrected by how much the
 * previous one overshot until the granted size both fits the content and stays
 * inside the work area.
 */
async function fitToContent(win) {
  if (win.isDestroyed()) return;
  const run = async (source) => {
    try {
      return await win.webContents.executeJavaScript(source, true);
    } catch (err) {
      log.warn('Picker content could not be measured:', err.message);
      return null;
    }
  };

  const constants = await run(READ_CONSTANTS_SOURCE);
  if (!constants || win.isDestroyed()) return;
  const { workArea } = screen.getDisplayMatching(win.getBounds());

  const { width } = computeLayout(constants, workArea);

  // Apply the width, correcting for the window manager's inflation of the
  // previous request. Extra room within the work area is fine — only a width
  // below the computed one (which would drop a column) or above the work area
  // needs correcting.
  let widthRequest = width;
  for (let pass = 0; pass < 4; pass++) {
    win.setContentSize(widthRequest, win.getContentSize()[1]);
    await nextFrames(win);
    if (win.isDestroyed()) return;
    const [granted] = win.getContentSize();
    if (granted >= width && granted <= workArea.width) break;
    widthRequest = Math.min(
      Math.max(widthRequest + (width - granted), 420),
      workArea.width,
    );
  }

  // Measure the height the content needs at the width the window actually
  // has, apply it, and correct the next request by how much this one
  // overshot — until the granted height both fits the content and stays
  // inside the work area.
  let height = 0;
  const settleHeight = async () => {
    let heightRequest = null;
    for (let pass = 0; pass < 5; pass++) {
      const [actualWidth, actualHeight] = win.getContentSize();
      const needed = await run(heightSource(actualWidth));
      if (needed === null || win.isDestroyed()) return false;
      const wanted = Math.min(Math.max(needed, 440), workArea.height);
      // Stop once the granted height covers the content and stays on the
      // display; the first pass always applies, so an oversized initial
      // window is shrunk to fit too.
      if (pass > 0 && actualHeight >= wanted && actualHeight <= workArea.height) {
        height = actualHeight;
        return true;
      }
      height = wanted;
      heightRequest = heightRequest === null
        ? wanted
        : Math.min(
            Math.max(heightRequest + (wanted - actualHeight), 440),
            workArea.height,
          );
      win.setContentSize(widthRequest, heightRequest);
      await nextFrames(win);
      if (win.isDestroyed()) return false;
    }
    return true;
  };
  if (!(await settleHeight())) return;

  // The window opens centred; growing it from the top-left corner would leave
  // it drifting down (or off-screen), so put it back in the middle of the
  // display. The one-pixel inset keeps the window inside the work area on
  // window managers that place a window a pixel above the requested position.
  const recentre = () => {
    const bounds = win.getBounds();
    win.setPosition(
      workArea.x + Math.max(1, Math.round((workArea.width - bounds.width) / 2)),
      workArea.y + Math.max(1, Math.round((workArea.height - bounds.height) / 2)),
    );
  };
  recentre();
  await nextFrames(win);
  if (win.isDestroyed()) return;

  // Repositioning can change the granted size again, so settle the height
  // once more. If that left the window above the work area, nudge it back
  // down and stop: the two corrections must not be allowed to chase each
  // other — a pixel or two of window-manager slack is harmless, a resize
  // loop is not.
  await settleHeight();
  const bounds = win.getBounds();
  if (bounds.y < workArea.y || bounds.x < workArea.x) {
    win.setPosition(
      Math.max(workArea.x + 1, bounds.x + 1),
      Math.max(workArea.y + 1, bounds.y + 1),
    );
    await nextFrames(win);
  }
  log.debug(`Picker sized to ${width}x${height} for its content`);
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

function pickerState(prefs, country, editing = false) {
  return {
    order: orderedServices(prefs, country).map((service) => service.id),
    favorites: prefs.favorites,
    hideUnavailable: prefs.hideUnavailable,
    editing,
  };
}

function buildHtml({ services, lastServiceId, prefs, country }) {
  const cards = services
    .map((service) => {
      const icon = iconDataUrl(service.icon);
      const last = service.id === lastServiceId;
      const restricted = !availableInRegion(service, country);
      return [
        `<div class="tile" data-id="${service.id}">`,
        `<button class="card${last ? ' last' : ''}" type="button" data-id="${service.id}">`,
        '<span class="favorite-mark" aria-hidden="true" hidden>★</span>',
        icon ? `<img src="${icon}" alt="">` : '',
        `<span class="name">${escapeHtml(service.name)}</span>`,
        restricted ? `<span class="region">${escapeHtml(t(country ? 'picker.unavailable' : 'picker.unknownRegion'))}</span>` : '',
        last ? `<span class="badge">${escapeHtml(t('picker.lastUsed'))}</span>` : '',
        '</button>',
        '<div class="card-actions">',
        `<button type="button" data-action="favorite" aria-label="${escapeHtml(t('picker.favorite'))}: ${escapeHtml(service.name)}" aria-pressed="false">☆</button>`,
        `<button type="button" data-action="left" aria-label="${escapeHtml(t('picker.moveEarlier'))}: ${escapeHtml(service.name)}">←</button>`,
        `<button type="button" data-action="right" aria-label="${escapeHtml(t('picker.moveLater'))}: ${escapeHtml(service.name)}">→</button>`,
        '</div></div>',
      ].join('');
    })
    .join('');
  const initialState = JSON.stringify(pickerState(prefs, country)).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="${language()}">
<head>
<meta charset="utf-8">
<title>Veylo</title>
<style>
  :root {
    color-scheme: dark;
    --card-w: 150px;   /* fixed card size: every service tile is identical */
    --card-gap: 14px;
  }
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
  /* Fixed-width grid tracks wrap into as many rows as needed, and the
     max-width caps a row at seven cards. Rows and columns
     are centred so a partially filled last row stays balanced. The 'safe'
     keyword keeps the content reachable when the window is shrunk below one
     full screen. */
  .cards {
    display: grid; gap: var(--card-gap); flex: 1; min-height: 0;
    grid-template-columns: repeat(auto-fill, var(--card-w));
    justify-content: center; align-content: safe center;
    margin: 0 auto; width: 100%; overflow: auto; scrollbar-gutter: stable; -webkit-app-region: no-drag;
    max-width: calc(7 * var(--card-w) + 6 * var(--card-gap) + 20px);
  }
  .tile { width: var(--card-w); display: flex; flex-direction: column; }
  .tile[hidden] { display: none; }
  .card {
    -webkit-app-region: no-drag;
    width: 100%; height: 200px; flex: none; position: relative;
    display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 6px; padding: 12px 10px; cursor: pointer;
    background: #131c2e; border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 14px; color: inherit; font: inherit;
    transition: border-color 0.12s, background 0.12s, transform 0.12s;
  }
  .card:hover { border-color: #4ea1ff; background: #16223a; }
  .card:focus-visible { outline: 2px solid #4ea1ff; outline-offset: 2px; }
  .card:active { transform: translateY(1px); }
  .card.last { border-color: rgba(78, 161, 255, 0.45); }
  .card img { width: 64px; height: 64px; object-fit: contain; flex: none; }
  .favorite-mark { position: absolute; right: 8px; top: 5px; color: #ffce80; }
  .card .name { font-size: 14px; font-weight: 600; }
  .card .badge {
    font-size: 10.5px; color: #7fb2ff; text-transform: uppercase;
    letter-spacing: 0.6px;
  }
  .card .region { font-size: 11px; color: #ffce80; }
  .card-actions { display: none; justify-content: center; gap: 8px; height: 34px; flex: none; padding-top: 4px; }
  .cards.editing .card-actions { display: flex; }
  .card-actions button {
    background: #1d2b42; color: #e6ecf5; border: 0; border-radius: 5px;
    min-width: 34px; cursor: pointer; font-size: 17px;
  }
  .card-actions button[aria-pressed="true"] { color: #ffce80; }
  .card-actions button:disabled { opacity: 0.35; cursor: default; }
  .auto {
    -webkit-app-region: no-drag;
    display: flex; align-items: center; gap: 9px; margin-top: 16px;
    font-size: 12.5px; color: #b9c6d9; cursor: pointer;
  }
  .auto input { width: 15px; height: 15px; accent-color: #4ea1ff; cursor: pointer; }
  .arrange {
    -webkit-app-region: no-drag; align-self: flex-start; margin-top: 12px;
    padding: 6px 12px; border: 1px solid #536883; border-radius: 6px;
    background: #1d2b42; color: inherit; font: inherit; cursor: pointer;
  }
  .hint { margin-top: 6px; font-size: 11px; color: #6d7d95; }
</style>
</head>
<body>
  <h1>${escapeHtml(t('picker.heading'))}</h1>
  <p class="sub">${escapeHtml(t('picker.subtitle'))}</p>
  <div class="cards">${cards}</div>
  <button type="button" id="arrange" class="arrange" aria-pressed="false"
    data-start="${escapeHtml(t('picker.arrange'))}" data-finish="${escapeHtml(t('picker.finishArrange'))}">${escapeHtml(t('picker.arrange'))}</button>
  <label class="auto">
    <input type="checkbox" id="hide-unavailable">
    <span>${escapeHtml(t('picker.hideUnavailable'))}</span>
  </label>
  <label class="auto">
    <input type="checkbox" id="auto"${prefs.autoOpen ? ' checked' : ''}>
    <span>${escapeHtml(t('picker.autoOpen'))}</span>
  </label>
  <div class="hint">${escapeHtml(t('picker.hint'))}</div>
  <script>
    (function () {
      var api = window.veyloPicker;
      var auto = document.getElementById('auto');
      var grid = document.querySelector('.cards');
      var hide = document.getElementById('hide-unavailable');
      var arrange = document.getElementById('arrange');
      var editing = false;
      var tiles = Array.prototype.slice.call(document.querySelectorAll('.tile'));
      function update(state) {
        editing = state.editing;
        grid.classList.toggle('editing', editing);
        arrange.textContent = editing ? arrange.dataset.finish : arrange.dataset.start;
        arrange.setAttribute('aria-pressed', String(editing));
        hide.checked = state.hideUnavailable;
        tiles.forEach(function (tile) {
          var id = tile.dataset.id;
          tile.hidden = state.order.indexOf(id) < 0;
          var favorite = state.favorites.indexOf(id) >= 0;
          tile.querySelector('.card').disabled = editing;
          tile.querySelector('.favorite-mark').hidden = !favorite;
          var star = tile.querySelector('[data-action="favorite"]');
          star.textContent = favorite ? '★' : '☆';
          star.setAttribute('aria-pressed', String(favorite));
        });
        state.order.forEach(function (id) {
          var tile = tiles.find(function (item) { return item.dataset.id === id; });
          if (tile) grid.appendChild(tile);
        });
        var visible = state.order.map(function (id) {
          return tiles.find(function (tile) { return tile.dataset.id === id; });
        }).filter(Boolean);
        visible.forEach(function (tile, index) {
          var favorite = state.favorites.indexOf(tile.dataset.id) >= 0;
          var previous = visible[index - 1];
          var next = visible[index + 1];
          tile.querySelector('[data-action="left"]').disabled = !previous ||
            (state.favorites.indexOf(previous.dataset.id) >= 0) !== favorite;
          tile.querySelector('[data-action="right"]').disabled = !next ||
            (state.favorites.indexOf(next.dataset.id) >= 0) !== favorite;
        });
      }
      api.onState(update);
      update(${initialState});
      arrange.addEventListener('click', function () { api.change('edit'); });
      hide.addEventListener('change', function () { api.change('hide', hide.checked); });
      grid.addEventListener('click', function (event) {
        var button = event.target.closest('button');
        if (!button) return;
        var tile = button.closest('.tile');
        if (button.classList.contains('card')) api.select(tile.dataset.id, auto.checked);
        else api.change(button.dataset.action, tile.dataset.id);
      });
      var preferred = document.querySelector('.tile:not([hidden]) .card.last') ||
        document.querySelector('.tile:not([hidden]) .card');
      if (preferred) preferred.focus();
      document.addEventListener('keydown', function (event) {
        if (event.key === 'Escape') {
          if (editing) api.change('edit');
          else api.cancel();
          return;
        }
        if (editing) return;
        if (event.target.tagName === 'INPUT' || event.target.closest('.card-actions')) return;
        var list = Array.prototype.slice.call(document.querySelectorAll('.tile:not([hidden]) .card'));
        var at = list.indexOf(document.activeElement);
        if (/^[1-9]$/.test(event.key)) {
          var byNumber = list[Number(event.key) - 1];
          if (byNumber) api.select(byNumber.getAttribute('data-id'), auto.checked);
          return;
        }
        if (at < 0) return;
        var perRow = list.filter(function (card) { return card.parentElement.offsetTop === list[0].parentElement.offsetTop; }).length || 1;
        var step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: perRow, ArrowUp: -perRow }[event.key];
        if (!step) return;
        var target = list[at + step];
        if (target) { event.preventDefault(); target.focus(); }
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
function pickService({ services, lastServiceId, prefs, country, onChange, confirm, display, onClose }) {
  let currentPrefs = prefs;
  let draft = null;
  const html = buildHtml({ services, lastServiceId, prefs, country });

  return new Promise((resolve) => {
    // Initial size only: once the page has loaded, fitToContent() grows the
    // window to the rows the current service list needs (clamped to the
    // display), so no fixed size has to be kept in step with SERVICES.
    const win = new BrowserWindow({
      x: display.workArea.x + Math.max(0, Math.round((display.workArea.width - 700) / 2)),
      y: display.workArea.y + Math.max(0, Math.round((display.workArea.height - 480) / 2)),
      width: 700,
      height: 480,
      minWidth: 420,
      minHeight: 440,
      title: 'Veylo',
      icon: path.join(__dirname, '..', 'assets', 'icon.png'),
      backgroundColor: '#0b1220',
      frame: false,
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
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
    function saveDraft() {
      if (!draft) return;
      currentPrefs = onChange('save', {
        favorites: draft.favorites,
        serviceOrder: draft.serviceOrder,
      });
      draft = null;
    }

    const settle = (value) => {
      if (settled) return;
      settled = true;
      const displayId = screen.getDisplayMatching(win.getBounds()).id;
      onClose(displayId);
      saveDraft();
      ipcMain.removeListener('picker:select', onSelect);
      ipcMain.removeListener('picker:cancel', onCancel);
      ipcMain.removeListener('picker:change', onChangeRequest);
      win.removeAllListeners('closed');
      openWindow = null;
      if (!win.isDestroyed()) win.destroy();
      resolve(value ? { ...value, displayId } : null);
    };

    let confirming = false;
    async function onSelect(event, payload) {
      if (event.sender !== win.webContents || confirming || draft) return;
      const id = payload && payload.id;
      const service = services.find((entry) => entry.id === id);
      if (!service || !orderedServices(currentPrefs, country).some((entry) => entry.id === id)) {
        log.warn(`Picker sent an unknown service: ${id}`);
        return;
      }
      confirming = true;
      try {
        if (await confirm(service, win) && !win.isDestroyed()) {
          settle({ id, autoOpen: Boolean(payload.autoOpen) });
        }
      } catch (err) {
        log.error('Could not confirm service selection:', err.message);
      } finally {
        confirming = false;
      }
    }

    function onCancel(event) {
      if (event.sender !== win.webContents || confirming) return;
      settle(null);
    }

    function onChangeRequest(event, payload) {
      if (event.sender !== win.webContents || !payload || typeof payload !== 'object') return;
      const { action, id } = payload;
      if (action === 'edit') {
        if (draft) saveDraft();
        else draft = { ...currentPrefs, favorites: [...currentPrefs.favorites], serviceOrder: [...currentPrefs.serviceOrder] };
      } else if (action === 'hide') {
        if (typeof id !== 'boolean') {
          log.warn('Invalid picker visibility preference');
          return;
        }
        currentPrefs = onChange(action, id);
        if (draft) draft = { ...draft, hideUnavailable: currentPrefs.hideUnavailable };
      } else if (draft && services.some((service) => service.id === id) && action === 'favorite') {
        const favorites = new Set(draft.favorites);
        if (favorites.has(id)) favorites.delete(id);
        else favorites.add(id);
        draft = { ...draft, favorites: [...favorites] };
      } else if (draft && services.some((service) => service.id === id) && (action === 'left' || action === 'right')) {
        draft = moveService(draft, country, id, action === 'left' ? -1 : 1);
      } else {
        log.warn(`Invalid picker preference action: ${action}`);
      }
      win.webContents.send('picker:state', pickerState(draft || currentPrefs, country, Boolean(draft)));
    }

    ipcMain.on('picker:select', onSelect);
    ipcMain.on('picker:cancel', onCancel);
    ipcMain.on('picker:change', onChangeRequest);
    win.on('close', (event) => {
      event.preventDefault();
      settle(null);
    });

    openWindow = win;
    const file = writePage(html);
    const loaded = file
      ? win.loadFile(file)
      : win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    Promise.resolve(loaded)
      .then(() => fitToContent(win))
      .catch((err) => log.warn('Service picker failed to load:', err.message));
    log.info('Service picker shown');
  });
}

module.exports = { pickService, focusPicker };
