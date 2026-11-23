'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const primary = {
  id: 1,
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const secondary = {
  id: 2,
  bounds: { x: 1920, y: 100, width: 1680, height: 1050 },
  workArea: { x: 1920, y: 100, width: 1680, height: 1010 },
};
let displays = [primary, secondary];
const screen = {
  getAllDisplays: () => displays,
  getPrimaryDisplay: () => primary,
  getDisplayMatching: (rect) => displays.reduce((best, display) => {
    const area = display.bounds;
    const width = Math.max(0, Math.min(rect.x + rect.width, area.x + area.width) - Math.max(rect.x, area.x));
    const height = Math.max(0, Math.min(rect.y + rect.height, area.y + area.height) - Math.max(rect.y, area.y));
    const overlap = width * height;
    return overlap > best.overlap ? { display, overlap } : best;
  }, { display: primary, overlap: -1 }).display,
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: {}, screen },
};

const { clampToDisplay, load, saveDisplay, WindowStateKeeper, MODES } = require('../src/window-state');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-window-state-test-'));
const file = path.join(dir, 'state.json');
after(() => {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(dir);
});

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

  describe('window state persistence', () => {
    const normalBounds = { x: 200, y: 100, width: 900, height: 650 };

    for (const mode of MODES) {
      it(`restores ${mode} on the saved display when normal bounds belong to another display`, () => {
        fs.writeFileSync(file, JSON.stringify({ mode, displayId: secondary.id, bounds: normalBounds }));
        const state = load(file);
        assert.equal(state.mode, mode);
        assert.equal(state.displayId, secondary.id);
        assert.equal(screen.getDisplayMatching(state.bounds).id, secondary.id);
        assert.deepEqual(state.bounds, { x: 2310, y: 280, width: 900, height: 650 });
      });
    }

    it('preserves normal bounds that already belong to the saved display', () => {
      const bounds = { x: 2200, y: 200, width: 900, height: 650 };
      fs.writeFileSync(file, JSON.stringify({ mode: 'normal', displayId: secondary.id, bounds }));
      assert.deepEqual(load(file).bounds, bounds);
    });

    it('saves the chooser display without losing the player mode or size', () => {
      fs.writeFileSync(file, JSON.stringify({ mode: 'fullscreen', displayId: primary.id, bounds: normalBounds }));
      saveDisplay(secondary.id, file);
      const state = load(file);
      assert.equal(state.displayId, secondary.id);
      assert.equal(state.mode, 'fullscreen');
      assert.equal(state.bounds.width, normalBounds.width);
      assert.equal(state.bounds.height, normalBounds.height);
      assert.equal(screen.getDisplayMatching(state.bounds).id, secondary.id);
    });

    it('restores on the selected display even if an old player saved another display afterwards', () => {
      fs.writeFileSync(file, JSON.stringify({ mode: 'maximized', displayId: primary.id, bounds: normalBounds }));
      const state = load(file, secondary.id);
      assert.equal(state.displayId, secondary.id);
      assert.equal(state.mode, 'maximized');
      assert.equal(screen.getDisplayMatching(state.bounds).id, secondary.id);
    });

    it('uses the chooser display when there is no previous state', () => {
      fs.unlinkSync(file);
      const state = load(file, secondary.id);
      assert.equal(state.displayId, secondary.id);
      assert.equal(screen.getDisplayMatching(state.bounds).id, secondary.id);
    });

    it('centres oversized bounds after clamping them to the destination', () => {
      fs.writeFileSync(file, JSON.stringify({
        mode: 'maximized', displayId: secondary.id,
        bounds: { x: -6000, y: -3000, width: 4000, height: 3000 },
      }));
      assert.deepEqual(load(file).bounds, secondary.workArea);
    });

    it('falls back to the primary display when the saved display is disconnected', () => {
      fs.writeFileSync(file, JSON.stringify({
        mode: 'maximized', displayId: secondary.id,
        bounds: { x: 2200, y: 200, width: 900, height: 650 },
      }));
      displays = [primary];
      try {
        const state = load(file);
        assert.equal(state.displayId, primary.id);
        assert.deepEqual(state.bounds, { x: 510, y: 195, width: 900, height: 650 });
      } finally {
        displays = [primary, secondary];
      }
    });

    class FakeWindow extends EventEmitter {
      constructor() {
        super();
        this.bounds = normalBounds;
        this.mode = 'normal';
      }

      isDestroyed() { return false; }
      isMinimized() { return this.mode === 'minimized'; }
      isMaximized() { return this.mode === 'maximized'; }
      isFullScreen() { return this.mode === 'fullscreen'; }
      getBounds() { return this.bounds; }
      getNormalBounds() { return this.bounds; }
    }

    it('captures an immediate move before flushing the pending debounce', () => {
      const win = new FakeWindow();
      const keeper = new WindowStateKeeper(win, { mode: 'normal', displayId: primary.id, bounds: normalBounds }, file);
      win.bounds = { x: 2200, y: 200, width: 900, height: 650 };
      win.emit('move');
      keeper.flush();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.displayId, secondary.id);
      assert.deepEqual(saved.bounds, win.bounds);
    });

    it('does not replace windowed geometry when closing while minimized', () => {
      const win = new FakeWindow();
      const keeper = new WindowStateKeeper(win, { mode: 'normal', displayId: primary.id, bounds: normalBounds }, file);
      win.mode = 'minimized';
      win.bounds = { x: -32000, y: -32000, width: 900, height: 650 };
      keeper.flush();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.displayId, primary.id);
      assert.deepEqual(saved.bounds, normalBounds);
    });

    it('does not save intermediate windowed geometry during an unmaximize transition', () => {
      const win = new FakeWindow();
      const keeper = new WindowStateKeeper(win, { mode: 'normal', displayId: primary.id, bounds: normalBounds }, file);
      win.bounds = { x: 2200, y: 200, width: 902, height: 900 };
      win.emit('unmaximize');
      keeper.flush();
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(saved.displayId, secondary.id);
      assert.deepEqual(saved.bounds, normalBounds);
    });

    for (const mode of ['maximized', 'fullscreen']) {
      it(`saves the current display but retains windowed geometry in ${mode} mode`, () => {
        const win = new FakeWindow();
        const keeper = new WindowStateKeeper(win, { mode: 'normal', displayId: primary.id, bounds: normalBounds }, file);
        win.mode = mode;
        win.bounds = secondary.bounds;
        win.emit('move');
        keeper.flush();
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(saved.mode, mode);
        assert.equal(saved.displayId, secondary.id);
        assert.deepEqual(saved.bounds, normalBounds);
        assert.equal(screen.getDisplayMatching(load(file).bounds).id, secondary.id);
      });
    }
  });
});