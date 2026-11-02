'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectCountry,
  regionCode,
  setRegion,
  countryFromTrace,
  countryFromText,
} = require('../src/region');

/** A fetch stand-in that answers each URL with the given body. */
function fetchReturning(body, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return { ok, status, text: async () => body };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

beforeEach(() => {
  // Every case starts from "nothing known": the module keeps its result for
  // the whole run, which is exactly what has to be reset between cases.
  setRegion(null);
});

describe('country parsing', () => {
  it('reads the loc line out of a Cloudflare trace', () => {
    assert.equal(countryFromTrace('ip=1.2.3.4\nloc=HU\nw=0\n'), 'HU');
    assert.equal(countryFromTrace('loc=us\r\n'), 'US');
  });

  it('reads a bare country code', () => {
    assert.equal(countryFromText('  de\n'), 'DE');
  });

  it('rejects anything that is not a country code', () => {
    assert.equal(countryFromTrace('no location here'), null);
    assert.equal(countryFromText(''), null);
    assert.equal(countryFromText('HUNGARY'), null);
    assert.equal(countryFromText('H1'), null);
  });
});

describe('region pin', () => {
  it('uses the pinned country without any lookup', async () => {
    setRegion('hu');
    const fetchImpl = fetchReturning('loc=US');
    assert.equal(await detectCountry({ fetchImpl }), 'HU');
    assert.equal(regionCode(), 'HU');
    assert.equal(fetchImpl.calls.length, 0);
  });

  it('ignores an invalid pin', async () => {
    setRegion('not-a-country');
    const fetchImpl = fetchReturning('loc=HU');
    assert.equal(await detectCountry({ fetchImpl }), 'HU');
    assert.equal(fetchImpl.calls.length, 1);
  });
});

describe('detectCountry', () => {
  it('returns the country from the first endpoint', async () => {
    const fetchImpl = fetchReturning('ip=1.2.3.4\nloc=HU\n');
    assert.equal(await detectCountry({ fetchImpl }), 'HU');
    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(regionCode(), 'HU');
  });

  it('falls back to the second endpoint when the first fails', async () => {
    let first = true;
    const fetchImpl = async (url) => {
      if (first) {
        first = false;
        throw new Error('offline');
      }
      assert.match(url, /ifconfig\.co/);
      return { ok: true, status: 200, text: async () => 'DE' };
    };
    assert.equal(await detectCountry({ fetchImpl }), 'DE');
  });

  it('falls back when the first endpoint answers without a country', async () => {
    let first = true;
    const fetchImpl = async () => {
      if (first) {
        first = false;
        return { ok: true, status: 200, text: async () => 'maintenance page' };
      }
      return { ok: true, status: 200, text: async () => 'FR' };
    };
    assert.equal(await detectCountry({ fetchImpl }), 'FR');
  });

  it('gives up with null when every endpoint fails', async () => {
    const fetchImpl = async () => {
      throw new Error('offline');
    };
    assert.equal(await detectCountry({ fetchImpl }), null);
    assert.equal(regionCode(), null);
  });

  it('does not retry a failed lookup within the same run', async () => {
    const fetchImpl = async () => {
      throw new Error('offline');
    };
    await detectCountry({ fetchImpl });
    const second = fetchReturning('loc=HU');
    assert.equal(await detectCountry({ fetchImpl: second }), null);
    assert.equal(second.calls.length, 0);
  });

  it('shares one request between concurrent callers', async () => {
    let calls = 0;
    let resolveFetch;
    const fetchImpl = () => {
      calls += 1;
      return new Promise((resolve) => {
        resolveFetch = () => resolve({ ok: true, status: 200, text: async () => 'loc=HU' });
      });
    };
    const first = detectCountry({ fetchImpl });
    const second = detectCountry({ fetchImpl });
    resolveFetch();
    assert.equal(await first, 'HU');
    assert.equal(await second, 'HU');
    assert.equal(calls, 1);
  });
});