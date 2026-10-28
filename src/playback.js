'use strict';

const log = require('./logger');
const { MediaController } = require('./mpris');

const VOLUME_STEP = 0.05;

/**
 * Connects three parties that must not know about each other directly:
 *   - the renderer, which reports and receives playback state (src/preload.js)
 *   - MPRIS, which represents the client to the desktop (src/mpris.js)
 *   - the tray and menu, which issue user commands
 */
class Playback {
  constructor({ window, onTitleChange }) {
    this.window = window;
    this.onTitleChange = onTitleChange || (() => {});
    this.mpris = new MediaController({
      window,
      onCommand: (command, payload) => this.emit(command, payload),
    });
    this.state = { hasVideo: false, playing: false, volume: 1, muted: false };
    this.pinned = false;
  }

  start() {
    this.mpris.start();
  }

  updateState(state) {
    this.state = { ...this.state, ...state };
    this.mpris.update(state);
    this.onTitleChange(state.hasVideo ? state.title : '');
  }

  /** Send a playback command down into the page. */
  emit(command, payload) {
    if (!this.window.isAlive) return;
    this.window.send('media:command', command, payload);
  }

  requestRefresh() {
    if (!this.window.isAlive) return;
    this.window.send('media:request-state');
  }

  get volume() {
    return typeof this.state.volume === 'number' ? this.state.volume : 1;
  }

  adjustVolume(delta) {
    const target = Math.min(Math.max(this.volume + delta, 0), 1);
    this.emit('setvolume', target);
    log.debug(`Volume set to ${Math.round(target * 100)}%`);
  }

  toggleMute() {
    const muted = !this.state.muted;
    this.emit('setmute', muted);
    log.debug(`Mute ${muted ? 'on' : 'off'}`);
  }

  /**
   * Picture-in-picture is implemented as a compact always-on-top window rather
   * than the browser PiP API, because the streaming services do not expose PiP
   * controls for all titles and the native route keeps the DRM session intact.
   */
  togglePinned() {
    this.pinned = !this.pinned;
    this.window.setPinned(this.pinned);
    log.info(`Picture-in-picture ${this.pinned ? 'enabled' : 'disabled'}`);
    return this.pinned;
  }

  stop() {
    this.mpris.stop();
  }
}

module.exports = { Playback, VOLUME_STEP };
