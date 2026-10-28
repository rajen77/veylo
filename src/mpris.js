'use strict';

const log = require('./logger');

const DESKTOP_ENTRY = 'io.github.veylo.Client';

/**
 * Publishes the client on the session bus as an MPRIS player. Desktop
 * environments (GNOME, KDE, MATE with the media keys plugin) route hardware
 * media keys and the sound-applet controls to whichever MPRIS player is marked
 * as playing, so this is what makes the keyboard keys work.
 *
 * Chromium's own MediaSessionService is disabled in src/flags.js on purpose:
 * it would publish a second, competing MPRIS entry for the same playback.
 */
class MediaController {
  constructor({ window, onCommand }) {
    this.window = window;
    this.onCommand = onCommand;
    this.player = null;
    this.lastState = { hasVideo: false, playing: false, title: '', durationSeconds: 0, positionSeconds: 0 };
    this.startedAt = null;
    this.unavailable = false;
  }

  start() {
    let Player;
    try {
      Player = require('mpris-service');
    } catch (err) {
      log.warn('mpris-service is not installed; media keys and the sound applet will not control playback.');
      log.debug(err.message);
      this.unavailable = true;
      return false;
    }

    try {
      this.player = Player({
        name: 'veylo',
        identity: 'Veylo',
        desktopEntry: DESKTOP_ENTRY,
        supportedUriSchemes: [],
        supportedMimeTypes: [],
        supportedInterfaces: ['player'],
      });
    } catch (err) {
      // Happens in sandboxes without a session bus, e.g. inside a bare
      // container. The app must still play video in that case.
      log.warn('Could not register the MPRIS player:', err.message);
      this.unavailable = true;
      return false;
    }

    const player = this.player;
    player.canPlay = true;
    player.canPause = true;
    player.canSeek = true;
    player.canControl = true;
    player.canGoNext = true;
    player.canGoPrevious = true;
    player.playbackStatus = 'Stopped';
    player.metadata = { 'mpris:trackid': player.objectPath('track/0') };
    player.getPosition = () => this.currentPositionMicros();

    const relay = (command) => () => this.onCommand(command);
    for (const event of ['play', 'pause', 'playpause', 'stop', 'next', 'previous']) {
      player.on(event, relay(event));
    }
    player.on('seek', (offset) => this.onCommand('seek', offset));
    player.on('position', (event) => {
      const trackId = event && event.trackId;
      const position = event && event.position;
      if (trackId && position != null) this.onCommand('setposition', position / 1_000_000);
    });
    player.on('volume', (level) => this.onCommand('setvolume', level));

    // Desktop integration: clicking the player in the sound applet or choosing
    // "Quit" from the player's context menu.
    player.on('raise', () => this.window.show());
    player.on('fullscreen', () => this.window.toggleFullscreen());

    log.info('MPRIS player registered as "Veylo"');
    return true;
  }

  currentPositionMicros() {
    const state = this.lastState;
    if (!state.hasVideo) return 0;
    if (!state.playing) return Math.round((state.positionSeconds || 0) * 1_000_000);
    if (this.startedAt == null) return Math.round((state.positionSeconds || 0) * 1_000_000);
    const driftSeconds = (Date.now() - this.startedAt) / 1000;
    const projected = (state.positionSeconds || 0) + driftSeconds;
    const capped = state.durationSeconds ? Math.min(projected, state.durationSeconds) : projected;
    return Math.round(capped * 1_000_000);
  }

  update(state) {
    this.lastState = state;

    // Keep the interpolated position anchored to every fresh sample so that
    // MPRIS position queries stay accurate between the one-second updates.
    this.startedAt = Date.now();

    if (!this.player) return;

    if (!state.hasVideo) {
      this.player.playbackStatus = 'Stopped';
      this.startedAt = null;
      return;
    }

    this.player.playbackStatus = state.playing ? 'Playing' : 'Paused';

    const metadata = {
      'mpris:trackid': this.player.objectPath('track/0'),
      'xesam:title': state.title || 'Veylo',
      'xesam:artist': ['Veylo'],
      'xesam:album': 'Veylo',
    };
    if (state.durationSeconds > 0) metadata['mpris:length'] = Math.round(state.durationSeconds * 1_000_000);
    if (state.artUrl) metadata['mpris:artUrl'] = state.artUrl;

    // Reassigning metadata on every tick makes panels flicker, so only publish
    // it when something visible actually changed.
    const signature = JSON.stringify(metadata);
    if (signature !== this.metadataSignature) {
      this.player.metadata = metadata;
      this.metadataSignature = signature;
    }

    if (typeof state.volume === 'number') this.player.volume = state.volume;
  }

  stop() {
    if (!this.player) return;
    try {
      this.player.playbackStatus = 'Stopped';
    } catch {
      /* the bus may already be gone during shutdown */
    }
  }
}

module.exports = { MediaController, DESKTOP_ENTRY };
