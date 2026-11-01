'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { SERVICES, allowedHostSuffixes } = require('../src/services');
const { isAllowed, isExternal, isPermissionAllowed } = require('../src/security');
const { computeLayout } = require('../src/picker-layout');
const { serviceFromArgv } = require('../src/cli');

describe('services registry invariants', () => {
  it('has unique ids and partitions', () => {
    assert.equal(new Set(SERVICES.map((s) => s.id)).size, SERVICES.length);
    assert.equal(new Set(SERVICES.map((s) => s.partition)).size, SERVICES.length);
  });

  for (const service of SERVICES) {
    describe(service.id, () => {
      it('has an icon file that exists', () => {
        assert.ok(fs.existsSync(service.icon), service.icon);
      });

      it('allows its own start URL and does not treat it as external', () => {
        assert.equal(isAllowed(service.startUrl, service), true);
        assert.equal(isExternal(service.startUrl, service), false);
      });

      it('refuses an unrelated host', () => {
        assert.equal(isAllowed('https://example.invalid/', service), false);
      });

      it('has a valid identity and a colour', () => {
        assert.ok(['linux', 'windows'].includes(service.identity));
        assert.match(service.backgroundColor, /^#[0-9a-f]{6}$/i);
        assert.ok(allowedHostSuffixes(service).length > 0);
      });
    });
  }
});

describe('permission policy', () => {
  it('allows playback permissions and refuses the rest', () => {
    assert.equal(isPermissionAllowed('fullscreen'), true);
    assert.equal(isPermissionAllowed('protected-media-identifier'), true);
    for (const denied of ['media', 'geolocation', 'notifications', 'midi', 'openExternal']) {
      assert.equal(isPermissionAllowed(denied), false, denied);
    }
  });
});

describe('computeLayout', () => {
  const base = { padL: 24, padR: 24, cardW: 150, gap: 12, cap: 636 };
  const work = { width: 1920, height: 1080 };

  it('caps a row at the grid max-width', () => {
    const layout = computeLayout({ ...base, cardCount: 7 }, work);
    assert.equal(layout.cols, 4);
    assert.equal(layout.rows, 2);
  });

  it('shrinks to the card count for few services', () => {
    const layout = computeLayout({ ...base, cardCount: 2 }, work);
    assert.equal(layout.cols, 2);
    assert.equal(layout.rows, 1);
    assert.equal(layout.width, 420);
  });

  it('never exceeds the work area', () => {
    const layout = computeLayout({ ...base, cap: NaN, cardCount: 30 }, { width: 500, height: 600 });
    assert.ok(layout.width <= 500);
    assert.ok(layout.cols >= 1);
  });
});

describe('serviceFromArgv', () => {
  it('reads --service=<id> and --service <id>', () => {
    assert.equal(serviceFromArgv(['--service=netflix']).id, 'netflix');
    assert.equal(serviceFromArgv(['--no-sandbox', '--service', 'HBOMAX']).id, 'hbomax');
  });

  it('ignores unknown or missing services', () => {
    assert.equal(serviceFromArgv(['--service=nope']), null);
    assert.equal(serviceFromArgv([]), null);
  });
});
