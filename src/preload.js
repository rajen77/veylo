'use strict';

const { ipcRenderer } = require('electron');

/**
 * The renderer is an official streaming service's web app (Disney+, Netflix,
 * …), which is untrusted code as far as this client is concerned. The preload
 * therefore exposes no API to the page and only forwards playback state
 * outward through IPC.
 *
 * Playback control in the opposite direction is done by driving the existing
 * <video> element and the player's own buttons, exactly as a user would.
 */

const POLL_INTERVAL_MS = 1000;
// The shift pass walks the whole DOM, so it is not run on the fast poll; see
// startTitlebar() for the events that drive it and this safety-net interval.
const OFFSET_POLL_MS = 5000;
// Coalesces bursts of DOM mutations into one video scan.
const SCAN_DEBOUNCE_MS = 250;
const VIDEO_EVENTS = [
  'play', 'pause', 'ended', 'timeupdate', 'durationchange',
  'loadedmetadata', 'volumechange', 'ratechange', 'seeking', 'seeked',
];

let currentVideo = null;
let pollTimer = null;
let scanTimer = null;
let pushTimer = null;
let lastPushedState = null;
let lastPushAt = 0;

function activeVideo() {
  const videos = Array.from(document.querySelectorAll('video'));
  if (videos.length === 0) return null;
  // The main feature is always the largest element on screen; trailers and
  // background previews are small.
  return videos.reduce((best, v) => {
    const area = (v.clientWidth || 0) * (v.clientHeight || 0);
    const bestArea = best ? (best.clientWidth || 0) * (best.clientHeight || 0) : -1;
    return area > bestArea ? v : best;
  }, null);
}

// The suffix pattern depends only on the service name, and readTitle() runs on
// every poll and title event; compiling it once per service instead of once per
// call keeps that path free of RegExp construction.
let titleSuffixFor = null;
let titleSuffixPattern = null;

function titleSuffixRe(service) {
  if (titleSuffixFor !== service) {
    titleSuffixFor = service;
    titleSuffixPattern = new RegExp(
      `\\s*(?:[|\\u2013\\u2014-]|\\bon)\\s*${service.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
      'i',
    );
  }
  return titleSuffixPattern;
}

function readTitle() {
  // The player renders the title in the document title while something plays,
  // e.g. "Title | Disney+" or "Title on Netflix". The service name is whatever
  // the main process reports for the active service (see src/services.js), so
  // this stays correct when the window is pointed at another service.
  const service = window.__veyloService || '';
  // The suffix the site appends varies: "Title | Disney+", "Title - Netflix",
  // "Title on Netflix". Anything left after stripping it is the real title.
  const fromDocument = service
    ? document.title.replace(titleSuffixRe(service), '').trim()
    : document.title.trim();
  if (fromDocument && fromDocument.toLowerCase() !== service.toLowerCase()) return fromDocument;
  const heading = document.querySelector('h1, [data-testid="title"]');
  return heading && heading.textContent ? heading.textContent.trim() : '';
}

function readArtwork() {
  const meta = document.querySelector('meta[property="og:image"]');
  if (meta && meta.content) return meta.content;
  const img = document.querySelector('img[data-testid="brand-logo"], .logo img');
  return img && img.src ? img.src : '';
}

function snapshot() {
  const video = activeVideo();
  if (!video) return { hasVideo: false };

  const paused = video.paused || video.ended;
  let status = paused ? 'Paused' : 'Playing';
  if (video.readyState < 2 || video.currentTime < 0.01) {
    status = paused ? 'Stopped' : 'Playing';
  }

  return {
    hasVideo: true,
    playing: !paused,
    status,
    positionSeconds: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    durationSeconds: Number.isFinite(video.duration) ? video.duration : 0,
    volume: typeof video.volume === 'number' ? video.volume : 1,
    muted: Boolean(video.muted),
    rate: typeof video.playbackRate === 'number' ? video.playbackRate : 1,
    title: readTitle(),
    artUrl: readArtwork(),
  };
}

/**
 * State changes that must reach the main process without waiting: they drive
 * the tray, the window title and MPRIS status. Position and duration are not
 * on the list — they move continuously during playback and are rate-limited
 * below instead.
 */
function isImmediateChange(next, prev) {
  if (!prev) return true;
  return next.hasVideo !== prev.hasVideo
    || next.playing !== prev.playing
    || next.muted !== prev.muted
    || next.volume !== prev.volume
    || next.title !== prev.title
    || next.artUrl !== prev.artUrl;
}

function sendState(state, now) {
  if (pushTimer) {
    window.clearTimeout(pushTimer);
    pushTimer = null;
  }
  lastPushedState = state;
  lastPushAt = now;
  ipcRenderer.send('media:state', state);
}

/**
 * Sends the playback state, at most once per second for pure position updates.
 *
 * `timeupdate` fires about four times a second and the one-second poll adds
 * more; without this every tick became an IPC round trip plus a metadata
 * rebuild in the main process even when nothing visible had changed. MPRIS
 * interpolates the position between updates (see src/mpris.js), so one sample
 * per second loses nothing, while play/pause/volume/title changes still go out
 * immediately.
 */
function push() {
  const state = snapshot();
  const now = Date.now();
  if (isImmediateChange(state, lastPushedState) || now - lastPushAt >= POLL_INTERVAL_MS) {
    sendState(state, now);
    return;
  }
  if (pushTimer) return;
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    sendState(snapshot(), Date.now());
  }, POLL_INTERVAL_MS - (now - lastPushAt));
}

function attach(video) {
  if (video === currentVideo) return;
  currentVideo = video;
  for (const name of VIDEO_EVENTS) video.addEventListener(name, push, { passive: true });
  push();
}

function scan() {
  const video = activeVideo();
  if (video) {
    // attach() pushes only when the video actually changed; an unchanged video
    // still needs the regular poll push, but not a second one right after one.
    const changed = video !== currentVideo;
    attach(video);
    if (!changed) push();
    return;
  }
  if (currentVideo) push();
}

/**
 * The page mutates constantly; scanning (and pushing) on every batch would
 * flood the main process. Coalesce the bursts into one pass.
 */
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_DEBOUNCE_MS);
}

/** Click a player button by its accessible name, e.g. "Next episode". */
function clickByLabel(patterns) {
  const candidates = document.querySelectorAll('button, [role="button"], a[role="button"]');
  for (const node of candidates) {
    if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
    const label = (
      node.getAttribute('aria-label') ||
      node.getAttribute('title') ||
      node.textContent ||
      ''
    ).trim().toLowerCase();
    if (!label) continue;
    if (patterns.some((p) => label.includes(p))) {
      node.click();
      return true;
    }
  }
  return false;
}

const COMMANDS = {
  play() {
    const video = activeVideo();
    if (video && video.paused) video.play().catch(() => clickByLabel(['play', 'lejátszás']));
  },
  pause() {
    const video = activeVideo();
    if (video && !video.paused) video.pause();
  },
  playpause() {
    const video = activeVideo();
    if (!video) {
      clickByLabel(['play', 'lejátszás']);
      return;
    }
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  },
  next() {
    clickByLabel(['next episode', 'next', 'következő']);
  },
  previous() {
    clickByLabel(['previous episode', 'previous', 'előző']);
  },
  stop() {
    const video = activeVideo();
    if (video) {
      video.pause();
      try {
        video.currentTime = 0;
      } catch {
        /* seeking may be refused before metadata is available */
      }
    }
  },
  seek(payload) {
    const video = activeVideo();
    if (!video || !Number.isFinite(video.duration)) return;
    const offset = Number(payload);
    if (!Number.isFinite(offset)) return;
    // MPRIS "Seek" carries a relative offset in microseconds.
    const target = Math.min(Math.max(video.currentTime + offset / 1_000_000, 0), video.duration);
    video.currentTime = target;
    push();
  },
  setposition(payload) {
    const video = activeVideo();
    if (!video) return;
    const seconds = Number(payload);
    if (!Number.isFinite(seconds)) return;
    const limit = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.min(Math.max(seconds, 0), limit);
    push();
  },
  setvolume(payload) {
    const video = activeVideo();
    if (!video) return;
    const level = Number(payload);
    if (!Number.isFinite(level)) return;
    video.volume = Math.min(Math.max(level, 0), 1);
    if (video.volume > 0) video.muted = false;
    push();
  },
  setmute(payload) {
    const video = activeVideo();
    if (!video) return;
    video.muted = Boolean(payload);
    push();
  },
  fullscreen() {
    clickByLabel(['full screen', 'fullscreen', 'teljes képernyő']);
  },
};

/* ------------------------------------------------------------------ *
 * Window controls
 *
 * The window is frameless, so these are its title bar. They are built as
 * ordinary DOM in the page because that is the only layer that receives input
 * here; see src/titlebar.js for the two native alternatives that were measured
 * and rejected.
 *
 * This code has to stay in this file: a sandboxed preload cannot `require` a
 * relative path, so a helper module would not load.
 * ------------------------------------------------------------------ */

const TITLEBAR_ID = 'veylo-titlebar';
const TITLEBAR_HEIGHT = 36;

const TITLEBAR_BUTTONS = [
  { id: 'menu', channel: 'window:titlebar:menu' },
  { id: 'fullscreen', channel: 'window:titlebar:fullscreen' },
  { id: 'minimize', channel: 'window:titlebar:minimize' },
  { id: 'maximize', channel: 'window:titlebar:maximize' },
  { id: 'close', channel: 'window:titlebar:close', danger: true },
];

// The control labels in English. The main process replaces the whole set
// through 'veylo:titlebar-labels' before the first load: the translations live
// in locales/*.json and this preload is sandboxed, so it cannot read them.
let titlebarLabels = {
  menu: 'Menu',
  fullscreen: 'Fullscreen',
  exitFullscreen: 'Exit fullscreen',
  minimize: 'Minimize',
  maximize: 'Maximize',
  restore: 'Restore',
  close: 'Close',
};

const TITLEBAR_ICONS = {
  menu: '<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  fullscreen:
    '<path d="M2.5 6V3.6a1.1 1.1 0 0 1 1.1-1.1H6M10 2.5h2.4a1.1 1.1 0 0 1 1.1 1.1V6M13.5 10v2.4a1.1 1.1 0 0 1-1.1 1.1H10M6 13.5H3.6a1.1 1.1 0 0 1-1.1-1.1V10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  exitFullscreen:
    '<path d="M6 2.5V5.4a.6.6 0 0 1-.6.6H2.5M10 2.5v2.9a.6.6 0 0 0 .6.6h2.9M6 13.5v-2.9a.6.6 0 0 0-.6-.6H2.5M10 13.5v-2.9a.6.6 0 0 1 .6-.6h2.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  minimize: '<path d="M3 8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  maximize: '<rect x="3.3" y="3.3" width="9.4" height="9.4" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.4"/>',
  restore:
    '<rect x="2.6" y="5.2" width="8.2" height="8.2" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.4 5.2V4.1A1.5 1.5 0 0 1 6.9 2.6h5.1a1.4 1.4 0 0 1 1.4 1.4v5.1a1.5 1.5 0 0 1-1.5 1.5h-1.1" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
};

const TITLEBAR_STYLES = `
#${TITLEBAR_ID} {
  position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR_HEIGHT}px;
  display: flex; align-items: center; background: #0b1220;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07); color: #e6ecf5;
  font: 12px/1 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  z-index: 2147483647; user-select: none; -webkit-user-select: none;
}
#${TITLEBAR_ID} .veylo-titlebar-drag {
  flex: 1; height: 100%; display: flex; align-items: center; padding-left: 10px;
  -webkit-app-region: drag; overflow: hidden; white-space: nowrap;
}
#${TITLEBAR_ID} .veylo-titlebar-text { overflow: hidden; text-overflow: ellipsis; opacity: 0.92; }
#${TITLEBAR_ID} .veylo-titlebar-button {
  -webkit-app-region: no-drag; appearance: none; border: 0; margin: 0; padding: 0;
  width: 40px; height: ${TITLEBAR_HEIGHT}px; display: flex; align-items: center;
  justify-content: center; background: transparent; color: inherit; cursor: pointer;
}
#${TITLEBAR_ID} .veylo-titlebar-button:hover { background: rgba(255, 255, 255, 0.11); }
#${TITLEBAR_ID} .veylo-titlebar-button:active { background: rgba(255, 255, 255, 0.2); }
#${TITLEBAR_ID} .veylo-titlebar-button:focus-visible { outline: 2px solid #4ea1ff; outline-offset: -2px; }
#${TITLEBAR_ID} .veylo-titlebar-button[data-danger="true"]:hover { background: #c0392b; }
/* The strip is fixed, so it is out of the flow and would sit on top of the
   page's own header. The page is pushed down by the strip's height instead.
   Only the root element is padded: the body's box already starts below the
   root's padding, so padding it too would double the offset.

   That padding only reaches static content. Headers the page pins to the
   viewport (fixed, or sticky once it sticks) ignore it and stay at the top
   edge, behind the strip; applyTitlebarOffset() shifts those separately. */
html.veylo-titlebar-offset { padding-top: ${TITLEBAR_HEIGHT}px !important; }
`;

// Mirrors the main process; updated through window:titlebar-state.
const titlebarState = { title: 'Veylo', maximized: false, fullscreen: false };

// In fullscreen the strip is hidden, but it comes back when the pointer reaches
// the top edge so that the window controls are never unreachable.
let titlebarRevealed = false;
let titlebarRebuildTimer = null;
// The strip's elements, kept so that they can be updated in place.
let titlebarParts = null;

function titlebarIcon(name) {
  return `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">${TITLEBAR_ICONS[name] || ''}</svg>`;
}

/** The label a control shows right now; two of them follow the window state. */
function titlebarLabelFor(id) {
  if (id === 'fullscreen') {
    return titlebarState.fullscreen ? titlebarLabels.exitFullscreen : titlebarLabels.fullscreen;
  }
  if (id === 'maximize') {
    return titlebarState.maximized ? titlebarLabels.restore : titlebarLabels.maximize;
  }
  return titlebarLabels[id] || id;
}

/**
 * The application menu is a native popup, so it is placed in window coordinates
 * rather than by the page. The anchor is measured here, where the layout is
 * known, and handed to the main process: without it the popup opens at a fixed
 * offset from the window's left edge instead of next to the button that asked
 * for it.
 */
function menuAnchor(element, point) {
  if (point) return { x: Math.round(point.x), y: Math.round(point.y) };
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) };
}

/**
 * Creates the strip once. The elements are then updated in place rather than
 * rebuilt, because replacing a button between mousedown and mouseup means the
 * click never completes: the page mutates constantly, so a rebuild triggered by
 * the observer would otherwise swallow clicks at random.
 */
function createTitlebar() {
  const bar = document.createElement('div');
  bar.id = TITLEBAR_ID;

  const drag = document.createElement('div');
  drag.className = 'veylo-titlebar-drag';
  const caption = document.createElement('span');
  caption.className = 'veylo-titlebar-text';
  drag.appendChild(caption);
  bar.appendChild(drag);

  const buttons = new Map();
  for (const spec of TITLEBAR_BUTTONS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'veylo-titlebar-button';
    button.dataset.action = spec.id;
    button.dataset.danger = spec.danger ? 'true' : 'false';
    const label = titlebarLabelFor(spec.id);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.innerHTML = titlebarIcon(spec.id);
    bar.appendChild(button);
    buttons.set(spec.id, button);
  }

  bar.addEventListener('click', (event) => {
    const button = event.target instanceof Element
      ? event.target.closest('.veylo-titlebar-button')
      : null;
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();
    const spec = TITLEBAR_BUTTONS.find((item) => item.id === button.dataset.action);
    if (!spec) return;
    // The menu is a native popup, so it needs the button's position; the other
    // commands are position-independent.
    if (spec.id === 'menu') {
      ipcRenderer.send(spec.channel, menuAnchor(button, event));
      return;
    }
    ipcRenderer.send(spec.channel);
  });
  // Right-clicking the strip shows the application menu, which is where the
  // accelerators, the update check and the About box already live.
  bar.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    ipcRenderer.send('window:titlebar:menu', menuAnchor(bar, event));
  });

  return { bar, caption, buttons };
}

// Viewport-anchored elements the strip would otherwise cover, mapped to the
// inline declaration that was written to shift them.
const shiftedElements = new Map();

// Elements whose computed position is fixed or sticky — the only ones the
// shift pass can act on. Finding them walks the whole body with
// getComputedStyle, so the list is cached and only invalidated when the DOM
// changes (the title-bar observer below) or on the slow safety-net poll, which
// also picks up a position the page changed through a class toggle alone.
let offsetCandidates = null;

/** Undoes every shift left behind by the previous pass. */
function restoreShiftedElements() {
  for (const [element, shift] of shiftedElements) {
    // Only undo the declaration while it is still ours. When the page has
    // rewritten it in the meantime its value wins, and the next pass shifts
    // whatever it wrote instead of resurrecting a stale value.
    if (element.style.getPropertyValue(shift.property) !== shift.applied) continue;
    if (shift.original === '') element.style.removeProperty(shift.property);
    else element.style.setProperty(shift.property, shift.original, shift.originalPriority);
  }
  shiftedElements.clear();
}

/** Moves one element down, remembering exactly how to undo it. */
function shiftElement(element, property, value) {
  const original = element.style.getPropertyValue(property);
  const originalPriority = element.style.getPropertyPriority(property);
  element.style.setProperty(property, value, 'important');
  shiftedElements.set(element, {
    property,
    // Read back rather than trusting `value`: the browser may normalise it,
    // and the restore above compares against what is actually stored.
    applied: element.style.getPropertyValue(property),
    original,
    originalPriority,
  });
}

/**
 * Shifts viewport-anchored content clear of the strip.
 *
 * The root padding moves static content only: `position: fixed`, and a
 * `sticky` element once it sticks, are laid out against the viewport, so the
 * page's own navigation stays at the top edge and disappears behind the strip.
 * Those elements are moved down by the strip's height instead.
 *
 * Stacked headers are handled as a cascade. Moving the primary navigation
 * down pushes it into the sub-navigation below, which then has to move as
 * well; pulling elements in until nothing collides keeps their spacing.
 *
 * Runs after every rebuild: it first restores the previous pass, so the
 * selection always sees the page's own layout rather than last pass's result.
 */
function applyTitlebarOffset() {
  restoreShiftedElements();

  // In fullscreen the strip is out of the layout, so nothing needs shifting.
  if (!document.documentElement.classList.contains('veylo-titlebar-offset')) return;
  const strip = document.getElementById(TITLEBAR_ID);
  if (!strip) return;

  const stripRect = strip.getBoundingClientRect();
  if (stripRect.height === 0) return;
  const stripBottom = stripRect.top + stripRect.height;
  const viewportHeight = window.innerHeight;

  if (!offsetCandidates) {
    offsetCandidates = [];
    for (const element of document.body.querySelectorAll('*')) {
      if (element === strip || strip.contains(element)) continue;
      const position = getComputedStyle(element).position;
      if (position === 'fixed' || position === 'sticky') offsetCandidates.push(element);
    }
  }

  const candidates = [];
  for (const element of offsetCandidates) {
    if (!element.isConnected) continue;
    if (element === strip || strip.contains(element)) continue;
    const style = getComputedStyle(element);
    const position = style.position;
    if (position !== 'fixed' && position !== 'sticky') continue;
    if (style.display === 'none' || style.visibility === 'hidden'
      || Number.parseFloat(style.opacity) < 0.01) continue;
    const zIndex = Number.parseFloat(style.zIndex);
    if (Number.isFinite(zIndex) && zIndex < 0) continue; // page backdrops
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Layers spanning the viewport (video backdrop, load curtain) are meant to
    // sit behind the strip; shifting them would tear the layout apart.
    if (rect.height >= viewportHeight * 0.9) continue;

    // A sticky element reports its flow position until it sticks, so judge it
    // by `top` as well: that is where it lands once scrolled to the edge.
    let top = rect.top;
    if (position === 'sticky') {
      const stickyTop = Number.parseFloat(style.top);
      if (Number.isFinite(stickyTop)) top = Math.min(top, stickyTop);
    }
    candidates.push({ element, position, style, rect, top });
  }

  const selected = candidates.filter((candidate) => candidate.top < stripBottom);
  for (let changed = true; changed;) {
    changed = false;
    const lowest = selected.reduce(
      (bottom, candidate) => Math.max(
        bottom,
        candidate.top + stripRect.height + candidate.rect.height,
      ),
      0,
    );
    for (const candidate of candidates) {
      if (selected.includes(candidate) || candidate.top >= lowest) continue;
      selected.push(candidate);
      changed = true;
    }
  }

  for (const candidate of selected) {
    const { element, style } = candidate;
    if (candidate.position === 'sticky') {
      const stickyTop = Number.parseFloat(style.top);
      if (Number.isFinite(stickyTop)) {
        // `top` is ignored while the element is in flow and only decides where
        // it sticks, so this moves it out from under the strip exactly when it
        // would collide, without disturbing the layout as it scrolls past.
        shiftElement(element, 'top', `${stickyTop + stripRect.height}px`);
        continue;
      }
    }
    // A margin shifts a fixed element without touching `top`, which the page
    // may be animating inline, and it keeps the height even when the page pins
    // `bottom` as well. `calc` carries percentage margins through unchanged.
    const margin = style.marginTop === 'auto' ? '0px' : style.marginTop || '0px';
    shiftElement(element, 'margin-top', `calc(${margin} + ${stripRect.height}px)`);
  }
}

/** Creates or refreshes the strip. Safe to call repeatedly. */
function buildTitlebar() {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;

  if (!document.getElementById(TITLEBAR_ID + '-style')) {
    const style = document.createElement('style');
    style.id = TITLEBAR_ID + '-style';
    style.textContent = TITLEBAR_STYLES;
    root.appendChild(style);
  }

  let bar = document.getElementById(TITLEBAR_ID);
  if (!bar || !bar.isConnected) {
    const created = createTitlebar();
    bar = created.bar;
    titlebarParts = created;
    body.appendChild(bar);
  } else if (!titlebarParts || titlebarParts.bar !== bar) {
    // The page replaced the strip with its own node of the same id; take it over
    // rather than leaving a dead element behind.
    bar.remove();
    const created = createTitlebar();
    bar = created.bar;
    titlebarParts = created;
    body.appendChild(bar);
  }

  const { caption, buttons } = titlebarParts;
  const text = titlebarState.title || 'Veylo';
  if (caption.textContent !== text) caption.textContent = text;

  // The labels follow the active language and the window state, so they are
  // re-applied on every refresh — including after a language change.
  for (const spec of TITLEBAR_BUTTONS) {
    const button = buttons.get(spec.id);
    if (!button) continue;
    const label = titlebarLabelFor(spec.id);
    if (button.title !== label) {
      button.title = label;
      button.setAttribute('aria-label', label);
    }
  }

  const fullscreenButton = buttons.get('fullscreen');
  const fullscreenIcon = titlebarIcon(titlebarState.fullscreen ? 'exitFullscreen' : 'fullscreen');
  if (fullscreenButton && fullscreenButton.innerHTML !== fullscreenIcon) {
    fullscreenButton.innerHTML = fullscreenIcon;
  }

  const maximizeButton = buttons.get('maximize');
  const maximizeIcon = titlebarIcon(titlebarState.maximized ? 'restore' : 'maximize');
  if (maximizeButton && maximizeButton.innerHTML !== maximizeIcon) {
    maximizeButton.innerHTML = maximizeIcon;
  }

  // In fullscreen the strip is hidden so the video fills the screen, and it is
  // revealed again when the pointer reaches the top edge. Without that the
  // fullscreen button would be the only control that could not be undone.
  const hidden = titlebarState.fullscreen && !titlebarRevealed;
  const display = hidden ? 'none' : 'flex';
  if (bar.style.display !== display) bar.style.display = display;
  bar.style.background = titlebarRevealed && titlebarState.fullscreen
    ? 'rgba(11, 18, 32, 0.92)'
    : '#0b1220';

  // The page is given back the strip's height in fullscreen, and the strip is
  // taken out of the layout there so it cannot cover the video.
  root.classList.toggle('veylo-titlebar-offset', !titlebarState.fullscreen);
  root.style.setProperty('--veylo-titlebar-height', `${TITLEBAR_HEIGHT}px`);

  // Runs last so it sees the final class and the strip's final geometry; it
  // restores the previous pass's shifts before measuring, as the page may have
  // relaid everything out since.
  applyTitlebarOffset();
}

/** Coalesces the bursts of mutations a single page transition produces. */
function scheduleTitlebarRebuild() {
  if (titlebarRebuildTimer) return;
  titlebarRebuildTimer = window.setTimeout(() => {
    titlebarRebuildTimer = null;
    // The DOM changed, so the cached fixed/sticky candidates may have too.
    offsetCandidates = null;
    buildTitlebar();
  }, 250);
}

function startTitlebar() {
  buildTitlebar();

  ipcRenderer.on('window:titlebar-state', (_event, state) => {
    if (!state || typeof state !== 'object') return;
    Object.assign(titlebarState, state);
    titlebarRevealed = false;
    buildTitlebar();
  });

  // A single page app replaces large parts of the DOM without navigating, which
  // can drop the strip; the observer restores it. Its own insertions are ignored
  // so that it cannot feed itself.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof Element && node.id === TITLEBAR_ID) return;
      }
    }
    scheduleTitlebarRebuild();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Reveal the strip when the pointer reaches the top edge while fullscreen.
  // The zone has hysteresis: it opens as soon as the pointer is over the strip
  // and only closes once the pointer has moved well clear of it, otherwise
  // moving down onto a button would hide the strip before the click landed.
  document.addEventListener('mousemove', (event) => {
    if (!titlebarState.fullscreen) return;
    const y = event.clientY;
    const next = titlebarRevealed ? y <= TITLEBAR_HEIGHT + 60 : y <= TITLEBAR_HEIGHT;
    if (next === titlebarRevealed) return;
    titlebarRevealed = next;
    buildTitlebar();
  }, { passive: true });

  // Navigating back to the signed-out marketing pages also clears the window
  // title; keep the strip's caption in step with it.
  const syncTitle = () => {
    const title = readTitle();
    if (title && title !== titlebarState.title) {
      titlebarState.title = title;
      buildTitlebar();
    }
  };
  // The title is cheap to read (document.title plus one lookup), so it stays on
  // the fast poll. The shift pass is not: it walks every element in the DOM
  // with getComputedStyle, so it is driven by the events that can actually
  // invalidate it — scrolling (captured, since scroll does not bubble) and
  // resizing — plus a slow safety net for late-loading views that pin a header
  // without any mutation for the observer to see.
  window.setInterval(syncTitle, POLL_INTERVAL_MS);

  let offsetTimer = null;
  const scheduleOffset = () => {
    if (offsetTimer) return;
    offsetTimer = window.setTimeout(() => {
      offsetTimer = null;
      applyTitlebarOffset();
    }, 100);
  };
  window.addEventListener('scroll', scheduleOffset, { passive: true, capture: true });
  window.addEventListener('resize', scheduleOffset, { passive: true });
  // Safety net for late-loading views that pin a header without any mutation
  // for the observer to see; it also refreshes the cached candidate list so a
  // position changed through a class toggle alone is picked up.
  window.setInterval(() => {
    offsetCandidates = null;
    applyTitlebarOffset();
  }, OFFSET_POLL_MS);
}

function start() {
  scan();
  startTitlebar();
  pollTimer = window.setInterval(scan, POLL_INTERVAL_MS);
  // The app is a single page that swaps views; a light observer catches videos
  // that appear without a navigation event. Debounced: the page mutates
  // constantly and an unthrottled scan would run several times a second.
  const observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement, { childList: true, subtree: true });

  document.addEventListener('visibilitychange', scan, { passive: true });

  ipcRenderer.on('media:command', (_event, command, payload) => {
    const handler = COMMANDS[command];
    if (handler) {
      try {
        handler(payload);
      } catch (err) {
        // Never let a player-specific failure break the page.
        console.warn('[veylo] command failed', command, err && err.message);
      }
    }
  });

  ipcRenderer.on('media:request-state', push);

  // The active service's display name, used by readTitle() to strip the site's
  // own suffix from the document title. Sent before the first load.
  ipcRenderer.on('service:name', (_event, name) => {
    if (typeof name === 'string' && name) window.__veyloService = name;
  });

  // The title-bar labels of the active language. Sent before the first load and
  // again whenever the language is switched at runtime.
  ipcRenderer.on('veylo:titlebar-labels', (_event, labels) => {
    if (!labels || typeof labels !== 'object') return;
    titlebarLabels = { ...titlebarLabels, ...labels };
    if (titlebarParts && titlebarParts.bar && titlebarParts.bar.isConnected) buildTitlebar();
  });

  window.addEventListener('beforeunload', () => {
    if (pollTimer) window.clearInterval(pollTimer);
    if (scanTimer) window.clearTimeout(scanTimer);
    if (pushTimer) window.clearTimeout(pushTimer);
    if (titlebarRebuildTimer) window.clearTimeout(titlebarRebuildTimer);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start, { once: true });
} else {
  start();
}
