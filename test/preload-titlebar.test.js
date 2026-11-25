'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

it('builds and updates usable title-bar icons when HTML assignments are forbidden', () => {
  class Element {
    constructor(tag) {
      this.tag = tag;
      this.dataset = {};
      this.attributes = {};
      this.children = [];
      this.handlers = {};
    }

    set innerHTML(_value) { throw new Error('TrustedHTML required'); }
    setAttribute(name, value) { this.attributes[name] = value; }
    appendChild(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
    closest() { return this; }
  }

  const sent = [];
  const context = {
    Element,
    document: {
      readyState: 'loading',
      addEventListener() {},
      createElement: (tag) => new Element(tag),
      createElementNS: (_namespace, tag) => new Element(tag),
    },
    require: () => ({ ipcRenderer: { send(channel) { sent.push(channel); } } }),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  const { createTitlebar, setTitlebarIcon } = vm.runInNewContext(
    `${source}\n;({ createTitlebar, setTitlebarIcon })`, context,
  );
  const { bar, buttons } = createTitlebar();
  const fullscreen = buttons.get('fullscreen');
  assert.equal(fullscreen.children[0].tag, 'svg');
  assert.equal(fullscreen.children[0].children[0].tag, 'path');
  const originalIcon = fullscreen.children[0];
  setTitlebarIcon(fullscreen, 'fullscreen');
  assert.equal(fullscreen.children[0], originalIcon);
  setTitlebarIcon(fullscreen, 'exitFullscreen');
  assert.notEqual(fullscreen.children[0], originalIcon);
  assert.equal(fullscreen.dataset.icon, 'exitFullscreen');
  bar.handlers.click({
    target: buttons.get('close'),
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(sent, ['window:titlebar:close']);
});

it('ignores its own insertion without missing other mutations in the same batch', () => {
  class Element {
    constructor(id) { this.id = id; }
  }
  let callback;
  let scheduled = 0;
  const context = {
    Element,
    document: {
      readyState: 'loading',
      documentElement: null,
      body: null,
      addEventListener() {},
    },
    window: {
      setTimeout() { scheduled += 1; return 1; },
      setInterval() {},
      addEventListener() {},
    },
    MutationObserver: class {
      constructor(fn) { callback = fn; }
      observe() {}
    },
    require: () => ({ ipcRenderer: { on() {} } }),
  };
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
  vm.runInNewContext(`${source}\nstartTitlebar();`, context);
  const titlebar = new Element('veylo-titlebar');
  callback([{ addedNodes: [titlebar], removedNodes: [] }]);
  assert.equal(scheduled, 0);
  callback([
    { addedNodes: [titlebar], removedNodes: [] },
    { addedNodes: [new Element('site-header')], removedNodes: [] },
  ]);
  assert.equal(scheduled, 1);
});
