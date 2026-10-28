'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// window-state only needs electron for the `app` binding used by stateFile(),
// which these cases bypass by calling clampToDisplay directly; stubbing keeps
// the test independent of an installed Electron binary (see test/updater.test.js).
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: {} },
};

const { clampToDisplay, MODES } = require('../src/window-state');

// A 1920x1080 display whose work area stops short of the bottom panel.
const display = {
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};

describe('clampToDisplay', () => {
  it('keeps bounds that are already inside the work area', () => {
    const bounds = { x: 100, y: 50, width: 1280, height: 800 };
    assert.deepEqual(clampToDisplay(bounds, display), bounds);
  });

  it('pulls a fully off-screen window back into the work area', () => {
    const clamped = clampToDisplay({ x: 5000, y: 5000, width: 800, height: 600 }, display);
    assert.equal(clamped.x, 1920 - 80); // right edge minus MIN_VISIBLE_PX
    assert.equal(clamped.y, 1040 - 80); // bottom edge minus MIN_VISIBLE_PX
  });

  it('leaves a strip of the window reachable when dragged off the left', () => {
    const clamped = clampToDisplay({ x: -5000, y: 100, width: 800, height: 600 }, display);
    assert.equal(clamped.x, -800 + 80); // MIN_VISIBLE_PX of the width stays visible
    assert.equal(clamped.y, 100);
  });

  it('enforces the minimum size and shrinks to the display', () => {
    const tiny = clampToDisplay({ x: 0, y: 0, width: 100, height: 50 }, display);
    assert.equal(tiny.width, 480);
    assert.equal(tiny.height, 360);

    const huge = clampToDisplay({ x: 0, y: 0, width: 4000, height: 3000 }, display);
    assert.equal(huge.width, 1920);
    assert.equal(huge.height, 1040);
  });

  it('honours a display arranged to the left of the primary (negative origin)', () => {
    const left = {
      x: -2560,
      y: 0,
      width: 2560,
      height: 1440,
      workArea: { x: -2560, y: 0, width: 2560, height: 1400 },
    };
    const bounds = { x: -2000, y: 100, width: 1280, height: 800 };
    assert.deepEqual(clampToDisplay(bounds, left), bounds);
  });
});

describe('MODES', () => {
  it('names the three window modes the state file can hold', () => {
    assert.deepEqual(MODES, ['normal', 'maximized', 'fullscreen']);
  });
});