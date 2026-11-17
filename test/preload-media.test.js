'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function media({ paused = true, width = 0, height = 0 } = {}) {
  const listeners = new Set();
  return {
    paused,
    ended: false,
    clientWidth: width,
    clientHeight: height,
    readyState: 4,
    currentTime: 10,
    duration: 100,
    volume: 0.5,
    muted: false,
    playbackRate: 1,
    addEventListener(name) { listeners.add(name); },
    removeEventListener(name) { listeners.delete(name); },
    pause() { this.paused = true; },
    play() { this.paused = false; return Promise.resolve(); },
    listeners,
  };
}

function loadPreload() {
  const elements = { video: [], audio: [] };
  const states = [];
  const document = {
    readyState: 'loading',
    title: 'Track',
    addEventListener() {},
    querySelectorAll(selector) { return elements[selector] || []; },
    querySelector() { return null; },
  };
  const context = {
    document,
    window: { clearTimeout() {}, setTimeout() { return 1; } },
    require: () => ({ ipcRenderer: { send(_channel, state) { states.push(state); } } }),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const api = vm.runInNewContext(`${source}\n;({ activeMedia, scan, snapshot, COMMANDS })`, context);
  return { ...api, elements, states };
}

describe('preload media controls', () => {
  it('selects and controls an audio element when there is no video', () => {
    const app = loadPreload();
    const audio = media();
    app.elements.audio.push(audio);
    app.scan();
    assert.equal(app.snapshot().hasVideo, true);
    app.COMMANDS.play();
    assert.equal(audio.paused, false);
    app.COMMANDS.seek(5_000_000);
    assert.equal(audio.currentTime, 15);
    app.COMMANDS.setvolume(0.75);
    assert.equal(audio.volume, 0.75);
    app.COMMANDS.pause();
    assert.equal(audio.paused, true);
  });

  it('prefers playing audio over a paused video and keeps playing video preferred', () => {
    const app = loadPreload();
    const video = media({ width: 800, height: 600 });
    const audio = media({ paused: false });
    app.elements.video.push(video);
    app.elements.audio.push(audio);
    assert.equal(app.activeMedia(), audio);
    video.paused = false;
    assert.equal(app.activeMedia(), video);
  });

  it('detaches old listeners and reports stopped when media disappears', () => {
    const app = loadPreload();
    const audio = media({ paused: false });
    const video = media({ paused: false, width: 800, height: 600 });
    app.elements.audio.push(audio);
    app.scan();
    assert.ok(audio.listeners.has('play'));
    app.elements.video.push(video);
    app.scan();
    assert.equal(audio.listeners.size, 0);
    assert.ok(video.listeners.has('play'));
    app.elements.audio.length = 0;
    app.elements.video.length = 0;
    app.scan();
    assert.equal(video.listeners.size, 0);
    assert.equal(app.states.at(-1).hasVideo, false);
  });
});
