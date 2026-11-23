'use strict';

const { it, after } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-picker-test-'));
const ipcMain = new EventEmitter();
let window;
class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    window = this;
    this.destroyed = false;
    this.options = options;
    this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
    this.messages = [];
    this.webContents = {
      send: (_channel, state) => this.messages.push(state),
      executeJavaScript: async () => null,
    };
  }

  isDestroyed() { return this.destroyed; }
  getBounds() { return this.bounds; }
  destroy() { this.destroyed = true; }
  loadFile() { return Promise.resolve(); }
}

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getPath: () => dir },
    BrowserWindow: FakeWindow,
    ipcMain,
    nativeImage: {
      createFromPath: () => ({
        isEmpty: () => false,
        resize: () => ({ toDataURL: () => 'data:image/png;base64,AA==' }),
      }),
    },
    screen: { getDisplayMatching: (bounds) => ({ id: bounds.x >= 1920 ? 2 : 1 }) },
  },
};

const { pickService } = require('../src/picker');
const { SERVICES } = require('../src/services');

after(() => {
  fs.unlinkSync(path.join(dir, 'picker.html'));
  fs.rmdirSync(dir);
});

it('stages arrangement edits until Done and saves unfinished edits on close', async () => {
  let prefs = { favorites: [], serviceOrder: [], hideUnavailable: false, autoOpen: false };
  const changes = [];
  const result = pickService({
    services: SERVICES,
    lastServiceId: 'netflix',
    prefs,
    country: 'HU',
    display: { workArea: { x: 1920, y: 150, width: 1680, height: 1050 } },
    confirm: async () => true,
    onClose: () => {},
    onChange(action, value) {
      changes.push(action);
      if (action === 'hide') prefs = { ...prefs, hideUnavailable: value };
      if (action === 'save') prefs = { ...prefs, ...value };
      return prefs;
    },
  });

  assert.equal(window.options.x, 2410);
  assert.equal(window.options.y, 435);
  const event = { sender: window.webContents };
  const change = (action, id) => ipcMain.emit('picker:change', event, { action, id });

  change('favorite', 'plex');
  assert.deepEqual(prefs.favorites, []);
  change('edit');
  change('favorite', 'plex');
  change('left', 'netflix');
  assert.deepEqual(changes, []);
  assert.deepEqual(prefs.favorites, []);
  assert.deepEqual(window.messages.at(-1).order.slice(0, 2), ['plex', 'netflix']);
  ipcMain.emit('picker:select', event, { id: 'netflix', autoOpen: false });
  assert.equal(window.destroyed, false);

  change('hide', true);
  assert.deepEqual(changes, ['hide']);
  assert.deepEqual(prefs.favorites, []);
  assert.deepEqual(window.messages.at(-1).favorites, ['plex']);
  change('hide', false);
  change('hide', false);
  assert.equal(prefs.hideUnavailable, false);
  change('edit');
  assert.deepEqual(changes, ['hide', 'hide', 'hide', 'save']);
  assert.deepEqual(prefs.favorites, ['plex']);
  assert.ok(prefs.serviceOrder.indexOf('netflix') < prefs.serviceOrder.indexOf('disneyplus'));
  assert.equal(window.messages.at(-1).editing, false);

  change('edit');
  change('favorite', 'netflix');
  ipcMain.emit('picker:cancel', event);
  assert.equal(await result, null);
  assert.deepEqual(prefs.favorites, ['plex', 'netflix']);
  assert.deepEqual(changes, ['hide', 'hide', 'hide', 'save', 'save']);
});

it('returns and saves the display where the chooser was when a service was selected', async () => {
  const closed = [];
  const result = pickService({
    services: SERVICES,
    lastServiceId: 'netflix',
    prefs: { favorites: [], serviceOrder: [], hideUnavailable: false, autoOpen: false },
    country: 'HU',
    display: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
    confirm: async () => true,
    onChange: () => {},
    onClose: (displayId) => closed.push(displayId),
  });
  window.bounds.x = 2200;
  ipcMain.emit('picker:select', { sender: window.webContents }, { id: 'netflix', autoOpen: false });
  assert.deepEqual(await result, { id: 'netflix', autoOpen: false, displayId: 2 });
  assert.deepEqual(closed, [2]);
});

it('saves the current display when the chooser is cancelled or closed', async () => {
  for (const nativeClose of [false, true]) {
    const closed = [];
    const result = pickService({
      services: SERVICES,
      lastServiceId: 'netflix',
      prefs: { favorites: [], serviceOrder: [], hideUnavailable: false, autoOpen: false },
      country: 'HU',
      display: { workArea: { x: 0, y: 0, width: 1920, height: 1080 } },
      confirm: async () => true,
      onChange: () => {},
      onClose: (displayId) => closed.push(displayId),
    });
    window.bounds.x = 2200;
    if (nativeClose) {
      let prevented = false;
      window.emit('close', { preventDefault: () => { prevented = true; } });
      assert.equal(prevented, true);
    } else {
      ipcMain.emit('picker:cancel', { sender: window.webContents });
    }
    assert.equal(await result, null);
    assert.deepEqual(closed, [2]);
  }
});
