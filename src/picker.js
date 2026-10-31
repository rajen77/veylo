'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, nativeImage, screen } = require('electron');
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

/**
 * Reads the layout constants the chooser's window size is computed from:
 * the body's horizontal padding, the card size, the grid gap, how many cards
 * there are, and the grid's max-width (NaN when uncapped).
 */
const READ_CONSTANTS_SOURCE = `(() => {
  const el = document.querySelector('.cards');
  if (!el || !el.firstElementChild) return null;
  const bodyStyle = getComputedStyle(document.body);
  const gridStyle = getComputedStyle(el);
  return {
    padL: parseFloat(bodyStyle.paddingLeft) || 0,
    padR: parseFloat(bodyStyle.paddingRight) || 0,
    cardW: el.firstElementChild.offsetWidth,
    gap: parseFloat(gridStyle.columnGap) || 0,
    cardCount: el.children.length,
    cap: parseFloat(gridStyle.maxWidth),
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
 * its padding and is independent of the window. Scrollbars are suppressed
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
    try {
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

  // A row holds as many cards as the grid's max-width allows (four by
  // design), as fit on the display, and as there are services.
  const capCols = Number.isFinite(constants.cap)
    ? Math.floor((constants.cap + constants.gap) / (constants.cardW + constants.gap))
    : Infinity;
  const colsFit = Math.max(1, Math.floor(
    (workArea.width - constants.padL - constants.padR + constants.gap) /
      (constants.cardW + constants.gap),
  ));
  const cols = Math.max(1, Math.min(constants.cardCount, capCols, colsFit));
  const neededWidth = Math.ceil(
    constants.padL + cols * constants.cardW + (cols - 1) * constants.gap + constants.padR,
  );
  // BrowserWindow's minWidth/minHeight (420x440) also clamp from below.
  const width = Math.min(Math.max(neededWidth, 420), workArea.width);

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
     max-width caps a row at four cards (4 tracks + 3 gaps) however wide the
     window gets; narrower windows simply fit fewer per row. Rows and columns
     are centred so a partially filled last row stays balanced. The 'safe'
     keyword keeps the content reachable when the window is shrunk below one
     full screen. */
  .cards {
    display: grid; gap: var(--card-gap); flex: 1; min-height: 0;
    grid-template-columns: repeat(auto-fill, var(--card-w));
    justify-content: center; align-content: safe center;
    margin: 0 auto; width: 100%; overflow: auto;
    max-width: calc(4 * var(--card-w) + 3 * var(--card-gap));
  }
  .card {
    -webkit-app-region: no-drag;
    width: var(--card-w);
    display: flex; flex-direction: column; align-items: center;
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
    // Initial size only: once the page has loaded, fitToContent() grows the
    // window to the rows the current service list needs (clamped to the
    // display), so no fixed size has to be kept in step with SERVICES.
    const win = new BrowserWindow({
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
    Promise.resolve(loaded)
      .then(() => fitToContent(win))
      .catch((err) => log.warn('Service picker failed to load:', err.message));
    log.info('Service picker shown');
  });
}

// fitToContent is exported so it can be exercised against a real window in
// the verification harness; the app itself only uses pickService/focusPicker.
module.exports = { pickService, focusPicker, fitToContent };
