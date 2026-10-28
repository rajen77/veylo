'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// electron must be stubbed before updater.js is required: the real module
// resolves to the path of the Electron binary (and throws when the binary is
// not downloaded, as in CI), while the updater only needs a handful of APIs.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getVersion: () => '0.3.0' },
    // Out-of-range index: dismisses any prompt without taking an action.
    dialog: { showMessageBox: async () => ({ response: 99 }) },
    shell: {},
  },
};

const { Updater } = require('../src/updater');
const log = require('../src/logger');

const updater = new Updater();

describe('Updater.compareVersions', () => {
  it('orders plain and v-prefixed versions', () => {
    assert.equal(updater.compareVersions('0.3.0', '0.2.0'), 1);
    assert.equal(updater.compareVersions('v0.2.0', '0.3.0'), -1);
    assert.equal(updater.compareVersions('v0.3.0', '0.3.0'), 0);
  });

  it('compares numerically, not lexically', () => {
    assert.equal(updater.compareVersions('0.10.0', '0.9.0'), 1);
    assert.equal(updater.compareVersions('10.0.0', '9.0.0'), 1);
  });

  it('treats missing segments as zero', () => {
    assert.equal(updater.compareVersions('1.0', '1.0.1'), -1);
    assert.equal(updater.compareVersions('1.0.1', '1.0'), 1);
  });

  it('handles prerelease-style suffixes', () => {
    assert.equal(updater.compareVersions('1.0.0-beta.2', '1.0.0-beta.1'), 1);
    assert.equal(updater.compareVersions('1.0.0-rc.1', '1.0.1'), -1);
  });
});

describe('Updater.check', () => {
  const savedFeed = process.env.VEYLO_UPDATE_FEED;

  before(() => {
    process.env.VEYLO_UPDATE_FEED = 'https://example.test/releases.json';
  });

  after(() => {
    if (savedFeed === undefined) delete process.env.VEYLO_UPDATE_FEED;
    else process.env.VEYLO_UPDATE_FEED = savedFeed;
  });

  it('reports not-configured without a feed', async () => {
    const saved = process.env.VEYLO_UPDATE_FEED;
    delete process.env.VEYLO_UPDATE_FEED;
    try {
      const result = await new Updater().check();
      assert.equal(result.status, 'not-configured');
    } finally {
      process.env.VEYLO_UPDATE_FEED = saved;
    }
  });

  it('reports current when the feed is not newer', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(
      JSON.stringify({ tag_name: 'v0.3.0' }),
    ));
    const result = await new Updater().check();
    assert.equal(result.status, 'current');
    assert.equal(result.current, '0.3.0');
  });

  it('reports available when the feed is newer', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      tag_name: 'v9.9.9',
      html_url: 'https://example.test/release',
    })));
    const result = await new Updater().check();
    assert.equal(result.status, 'available');
    assert.equal(result.latest, '9.9.9');
  });

  it('reports error when the feed fails', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new Error('offline');
    });
    const warn = t.mock.method(log, 'warn', () => {});
    const result = await new Updater().check();
    assert.equal(result.status, 'error');
    assert.match(result.error, /offline/);
    assert.equal(warn.mock.callCount(), 1);
  });
});