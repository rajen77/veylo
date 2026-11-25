'use strict';

const { ipcRenderer } = require('electron');

// Service pages are untrusted; do not expose the IPC API to them.

const POLL_INTERVAL_MS = 1000;
// The offset pass walks the DOM, so it runs less often than media polling.
const OFFSET_POLL_MS = 5000;
// Coalesces bursts of DOM mutations into one media scan.
const SCAN_DEBOUNCE_MS = 250;
const MEDIA_EVENTS = [
  'play', 'pause', 'ended', 'timeupdate', 'durationchange',
  'loadedmetadata', 'volumechange', 'ratechange', 'seeking', 'seeked',
];

let currentMedia = null;
let pollTimer = null;
let scanTimer = null;
let pushTimer = null;
let lastPushedState = null;
let lastPushAt = 0;

function activeMedia() {
  const videos = Array.from(document.querySelectorAll('video'));
  // Prefer the main player over smaller trailers and previews.
  const video = videos.reduce((best, v) => {
    const area = (v.clientWidth || 0) * (v.clientHeight || 0);
    const bestArea = best ? (best.clientWidth || 0) * (best.clientHeight || 0) : -1;
    return area > bestArea ? v : best;
  }, null);
  const audio = Array.from(document.querySelectorAll('audio'));
  const playingAudio = audio.find((element) => !element.paused && !element.ended);
  if (playingAudio && (!video || video.paused || video.ended)) return playingAudio;
  return video || playingAudio || audio.find((element) => !element.ended) || audio[0] || null;
}

// Cache the suffix pattern because titles are read on every poll.
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
  const service = window.__veyloService || '';
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
  const video = activeMedia();
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

// Position updates can be throttled; visible state changes cannot.
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

// Limit frequent timeupdate IPC; MPRIS interpolates between samples.
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

function attach(media) {
  if (media === currentMedia) return;
  if (currentMedia) {
    for (const name of MEDIA_EVENTS) currentMedia.removeEventListener(name, push);
  }
  currentMedia = media;
  if (media) {
    for (const name of MEDIA_EVENTS) media.addEventListener(name, push, { passive: true });
  }
  push();
}

function scan() {
  const media = activeMedia();
  const changed = media !== currentMedia;
  attach(media);
  if (media && !changed) push();
}

// Coalesce frequent page mutations to avoid flooding IPC.
function scheduleScan() {
  if (scanTimer) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    scan();
  }, SCAN_DEBOUNCE_MS);
}

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

function playMedia(media) {
  media.play().catch((err) => {
    if (!clickByLabel(['play', 'lejátszás'])) {
      console.warn('[veylo] play failed', err && err.message);
    }
  });
}

const COMMANDS = {
  play() {
    const video = activeMedia();
    if (video && video.paused) playMedia(video);
  },
  pause() {
    const video = activeMedia();
    if (video && !video.paused) video.pause();
  },
  playpause() {
    const video = activeMedia();
    if (!video) {
      clickByLabel(['play', 'lejátszás']);
      return;
    }
    if (video.paused) playMedia(video);
    else video.pause();
  },
  next() {
    clickByLabel(['next episode', 'next', 'következő']);
  },
  previous() {
    clickByLabel(['previous episode', 'previous', 'előző']);
  },
  stop() {
    const video = activeMedia();
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
    const video = activeMedia();
    if (!video || !Number.isFinite(video.duration)) return;
    const offset = Number(payload);
    if (!Number.isFinite(offset)) return;
    // MPRIS "Seek" carries a relative offset in microseconds.
    const target = Math.min(Math.max(video.currentTime + offset / 1_000_000, 0), video.duration);
    video.currentTime = target;
    push();
  },
  setposition(payload) {
    const video = activeMedia();
    if (!video) return;
    const seconds = Number(payload);
    if (!Number.isFinite(seconds)) return;
    const limit = Number.isFinite(video.duration) ? video.duration : seconds;
    video.currentTime = Math.min(Math.max(seconds, 0), limit);
    push();
  },
  setvolume(payload) {
    const video = activeMedia();
    if (!video) return;
    const level = Number(payload);
    if (!Number.isFinite(level)) return;
    video.volume = Math.min(Math.max(level, 0), 1);
    if (video.volume > 0) video.muted = false;
    push();
  },
  setmute(payload) {
    const video = activeMedia();
    if (!video) return;
    video.muted = Boolean(payload);
    push();
  },
  fullscreen() {
    clickByLabel(['full screen', 'fullscreen', 'teljes képernyő']);
  },
};

// A sandboxed preload cannot require local modules; the title bar must stay here.

const TITLEBAR_ID = 'veylo-titlebar';
const TITLEBAR_HEIGHT = 36;

const TITLEBAR_BUTTONS = [
  { id: 'menu', channel: 'window:titlebar:menu' },
  { id: 'fullscreen', channel: 'window:titlebar:fullscreen' },
  { id: 'minimize', channel: 'window:titlebar:minimize' },
  { id: 'maximize', channel: 'window:titlebar:maximize' },
  { id: 'close', channel: 'window:titlebar:close', danger: true },
];

// The sandboxed preload receives translated labels from the main process.
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
  menu: [{ d: 'M2.5 4.5h11M2.5 8h11M2.5 11.5h11' }],
  fullscreen: [{ d: 'M2.5 6V3.6a1.1 1.1 0 0 1 1.1-1.1H6M10 2.5h2.4a1.1 1.1 0 0 1 1.1 1.1V6M13.5 10v2.4a1.1 1.1 0 0 1-1.1 1.1H10M6 13.5H3.6a1.1 1.1 0 0 1-1.1-1.1V10' }],
  exitFullscreen: [{ d: 'M6 2.5V5.4a.6.6 0 0 1-.6.6H2.5M10 2.5v2.9a.6.6 0 0 0 .6.6h2.9M6 13.5v-2.9a.6.6 0 0 0-.6-.6H2.5M10 13.5v-2.9a.6.6 0 0 1 .6-.6h2.9' }],
  minimize: [{ d: 'M3 8h10' }],
  maximize: [{ tag: 'rect', x: '3.3', y: '3.3', width: '9.4', height: '9.4', rx: '1.3' }],
  restore: [
    { tag: 'rect', x: '2.6', y: '5.2', width: '8.2', height: '8.2', rx: '1.3' },
    { d: 'M5.4 5.2V4.1A1.5 1.5 0 0 1 6.9 2.6h5.1a1.4 1.4 0 0 1 1.4 1.4v5.1a1.5 1.5 0 0 1-1.5 1.5h-1.1' },
  ],
  close: [{ d: 'M4 4l8 8M12 4l-8 8' }],
};

const TITLEBAR_STYLES = `
#${TITLEBAR_ID} {
  position: fixed; top: 0; left: 0; right: 0; height: ${TITLEBAR_HEIGHT}px;
  box-sizing: border-box; display: flex; align-items: center; background: #0b1220;
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
/* Root padding avoids overlap without doubling the body's offset.
   Fixed and sticky headers need a separate shift. */
html.veylo-titlebar-offset { padding-top: ${TITLEBAR_HEIGHT}px !important; }
`;

// Plex positions its app against the viewport, ignoring the root padding.
const PLEX_TITLEBAR_STYLES = `
html.veylo-titlebar-offset body > #plex {
  top: ${TITLEBAR_HEIGHT}px !important;
  height: calc(100% - ${TITLEBAR_HEIGHT}px) !important;
}
`;

// Mirrors the main process; updated through window:titlebar-state.
const titlebarState = { title: 'Veylo', maximized: false, fullscreen: false };

// Reveal fullscreen controls at the top edge to keep them reachable.
let titlebarRevealed = false;
let titlebarRebuildTimer = null;
let titlebarParts = null;

function titlebarIcon(name) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 16 16', width: '16', height: '16', 'aria-hidden': 'true',
    fill: 'none', stroke: 'currentColor', 'stroke-width': name === 'restore' ? '1.3' : '1.4',
    'stroke-linecap': 'round',
  })) svg.setAttribute(key, value);
  for (const shape of TITLEBAR_ICONS[name] || []) {
    const element = document.createElementNS(namespace, shape.tag || 'path');
    for (const [key, value] of Object.entries(shape)) {
      if (key !== 'tag') element.setAttribute(key, value);
    }
    svg.appendChild(element);
  }
  return svg;
}

function setTitlebarIcon(button, name) {
  if (button.dataset.icon === name) return;
  button.replaceChildren(titlebarIcon(name));
  button.dataset.icon = name;
}

function titlebarLabelFor(id) {
  if (id === 'fullscreen') {
    return titlebarState.fullscreen ? titlebarLabels.exitFullscreen : titlebarLabels.fullscreen;
  }
  if (id === 'maximize') {
    return titlebarState.maximized ? titlebarLabels.restore : titlebarLabels.maximize;
  }
  return titlebarLabels[id] || id;
}

// Native menus need an anchor in window coordinates.
function menuAnchor(element, point) {
  if (point) return { x: Math.round(point.x), y: Math.round(point.y) };
  const rect = element.getBoundingClientRect();
  return { x: Math.round(rect.left), y: Math.round(rect.bottom) };
}

// Updating buttons in place prevents mutations from swallowing clicks.
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
    setTitlebarIcon(button, spec.id);
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
    if (spec.id === 'menu') {
      ipcRenderer.send(spec.channel, menuAnchor(button, event));
      return;
    }
    ipcRenderer.send(spec.channel);
  });
  bar.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    ipcRenderer.send('window:titlebar:menu', menuAnchor(bar, event));
  });

  return { bar, caption, buttons };
}

const shiftedElements = new Map();

// Cache fixed/sticky candidates to avoid repeated whole-DOM style scans.
let offsetCandidates = null;

function restoreShiftedElements() {
  for (const [element, shift] of shiftedElements) {
    // Preserve changes made by the page since the last shift.
    if (element.style.getPropertyValue(shift.property) !== shift.applied) continue;
    if (shift.original === '') element.style.removeProperty(shift.property);
    else element.style.setProperty(shift.property, shift.original, shift.originalPriority);
  }
  shiftedElements.clear();
}

function shiftElement(element, property, value) {
  const original = element.style.getPropertyValue(property);
  const originalPriority = element.style.getPropertyPriority(property);
  element.style.setProperty(property, value, 'important');
  shiftedElements.set(element, {
    property,
    // The browser may normalize the value used by the restore comparison.
    applied: element.style.getPropertyValue(property),
    original,
    originalPriority,
  });
}

// Fixed/sticky headers ignore root padding; cascading shifts preserve stacked headers.
function applyTitlebarOffset() {
  restoreShiftedElements();

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
    // Viewport-sized backdrops belong behind the strip.
    if (rect.height >= viewportHeight * 0.9) continue;

    // Sticky elements can later stick above their current flow position.
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
        // Changing top affects the sticky position without moving the flow box.
        shiftElement(element, 'top', `${stickyTop + stripRect.height}px`);
        continue;
      }
    }
    // Margin preserves animated top, bottom constraints and percentage margins.
    const margin = style.marginTop === 'auto' ? '0px' : style.marginTop || '0px';
    shiftElement(element, 'margin-top', `calc(${margin} + ${stripRect.height}px)`);
  }
}

function buildTitlebar() {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;

  if (!document.getElementById(TITLEBAR_ID + '-style')) {
    const style = document.createElement('style');
    style.id = TITLEBAR_ID + '-style';
    style.textContent = TITLEBAR_STYLES + (window.location.hostname === 'app.plex.tv' ? PLEX_TITLEBAR_STYLES : '');
    root.appendChild(style);
  }

  let bar = document.getElementById(TITLEBAR_ID);
  if (!bar || !bar.isConnected) {
    const created = createTitlebar();
    bar = created.bar;
    titlebarParts = created;
    body.appendChild(bar);
  } else if (!titlebarParts || titlebarParts.bar !== bar) {
    // Replace a conflicting page node rather than leaving dead controls.
    bar.remove();
    const created = createTitlebar();
    bar = created.bar;
    titlebarParts = created;
    body.appendChild(bar);
  }

  const { caption, buttons } = titlebarParts;
  const text = titlebarState.title || 'Veylo';
  if (caption.textContent !== text) caption.textContent = text;

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
  if (fullscreenButton) setTitlebarIcon(fullscreenButton, titlebarState.fullscreen ? 'exitFullscreen' : 'fullscreen');

  const maximizeButton = buttons.get('maximize');
  if (maximizeButton) setTitlebarIcon(maximizeButton, titlebarState.maximized ? 'restore' : 'maximize');

  const hidden = titlebarState.fullscreen && !titlebarRevealed;
  const display = hidden ? 'none' : 'flex';
  if (bar.style.display !== display) bar.style.display = display;
  bar.style.background = titlebarRevealed && titlebarState.fullscreen
    ? 'rgba(11, 18, 32, 0.92)'
    : '#0b1220';

  root.classList.toggle('veylo-titlebar-offset', !titlebarState.fullscreen);
  root.style.setProperty('--veylo-titlebar-height', `${TITLEBAR_HEIGHT}px`);

  // Measure only after the final strip geometry and offset class are applied.
  applyTitlebarOffset();
}

function scheduleTitlebarRebuild() {
  if (titlebarRebuildTimer) return;
  titlebarRebuildTimer = window.setTimeout(() => {
    titlebarRebuildTimer = null;
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

  // Restore controls removed by single-page navigation without observing our own insertion.
  const observer = new MutationObserver((records) => {
    const onlyTitlebar = records.every((record) =>
      record.removedNodes.length === 0 && record.addedNodes.length > 0 &&
      Array.from(record.addedNodes).every((node) => node instanceof Element && node.id === TITLEBAR_ID));
    if (onlyTitlebar) return;
    scheduleTitlebarRebuild();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  // Hysteresis prevents the strip from hiding while a button is being clicked.
  document.addEventListener('mousemove', (event) => {
    if (!titlebarState.fullscreen) return;
    const y = event.clientY;
    const next = titlebarRevealed ? y <= TITLEBAR_HEIGHT + 60 : y <= TITLEBAR_HEIGHT;
    if (next === titlebarRevealed) return;
    titlebarRevealed = next;
    buildTitlebar();
  }, { passive: true });

  const syncTitle = () => {
    const title = readTitle();
    if (title && title !== titlebarState.title) {
      titlebarState.title = title;
      buildTitlebar();
    }
  };
  // Capture scroll because it does not bubble; style scans use a slower poll.
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
  // Class-only position changes do not trigger the child-list observer.
  window.setInterval(() => {
    offsetCandidates = null;
    applyTitlebarOffset();
  }, OFFSET_POLL_MS);
}

function start() {
  scan();
  startTitlebar();
  pollTimer = window.setInterval(scan, POLL_INTERVAL_MS);
  // Single-page navigation can add media without a document navigation.
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

  ipcRenderer.on('service:name', (_event, name) => {
    if (typeof name === 'string' && name) window.__veyloService = name;
  });

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
