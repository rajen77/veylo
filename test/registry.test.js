'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const {
  SERVICES,
  allowedHostSuffixes,
  getService,
  availableInRegion,
  visibleServices,
} = require('../src/services');
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

describe('regional availability', () => {
  it('gives restricted services a list of valid country codes', () => {
    for (const service of SERVICES.filter((entry) => entry.availableIn)) {
      assert.ok(service.availableIn.length > 0, service.id);
      for (const code of service.availableIn) {
        assert.match(code, /^[A-Z]{2}$/, `${service.id}: ${code}`);
      }
      assert.equal(new Set(service.availableIn).size, service.availableIn.length, service.id);
    }
  });

  it('offers an unrestricted service everywhere, including an unknown region', () => {
    const netflix = getService('netflix');
    assert.equal(netflix.availableIn, undefined);
    assert.equal(availableInRegion(netflix, 'HU'), true);
    assert.equal(availableInRegion(netflix, null), true);
  });

  it('offers a restricted service only in its own countries', () => {
    const skyshowtime = getService('skyshowtime');
    assert.equal(availableInRegion(skyshowtime, 'HU'), true);
    assert.equal(availableInRegion(skyshowtime, 'US'), false);
    assert.equal(availableInRegion(skyshowtime, null), false);
  });

  it('hides the geo-restricted services when the region is unknown', () => {
    const ids = visibleServices(null).map((service) => service.id);
    assert.ok(ids.includes('netflix'));
    assert.ok(!ids.includes('skyshowtime'));
    assert.ok(!ids.includes('plutotv'));
    assert.ok(!ids.includes('tubi'));
    assert.ok(!ids.includes('peacock'));
    assert.ok(!ids.includes('paramountplus'));
  });

  it('keeps the registry order and filters per country', () => {
    const restricted = SERVICES.filter((s) => s.availableIn).map((s) => s.id);

    // The US gets every service: Peacock and the free services are US-first,
    // SkyShowtime is the only one that is not offered there.
    const us = visibleServices('US').map((service) => service.id);
    assert.deepEqual(
      us,
      SERVICES.filter((s) => s.id !== 'skyshowtime').map((s) => s.id),
    );
    assert.ok(us.includes('peacock'));
    assert.ok(us.includes('plutotv'));

    // Hungary: Paramount+ and SkyShowtime are offered, the US-only and
    // EU-excluded ones are not.
    const hu = visibleServices('HU').map((service) => service.id);
    assert.ok(hu.includes('paramountplus'));
    assert.ok(hu.includes('skyshowtime'));
    assert.ok(!hu.includes('peacock'));
    assert.ok(!hu.includes('plutotv'));
    assert.ok(!hu.includes('tubi'));
    assert.ok(hu.length < SERVICES.length);

    // Every restricted service is hidden somewhere, so the lists are real.
    for (const id of restricted) {
      assert.ok(!visibleServices('ZZ').some((s) => s.id === id), id);
    }
  });
});
