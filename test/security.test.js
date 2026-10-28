'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isAllowed, isExternal, hostMatches } = require('../src/security');
const {
  SERVICES,
  DEFAULT_SERVICE_ID,
  allowedHostSuffixes,
  getService,
  resolveService,
} = require('../src/services');

const disney = getService('disneyplus');
const netflix = getService('netflix');

describe('hostMatches', () => {
  it('matches the suffix itself and its subdomains only', () => {
    assert.equal(hostMatches('netflix.com', ['netflix.com']), true);
    assert.equal(hostMatches('www.netflix.com', ['netflix.com']), true);
    assert.equal(hostMatches('NETFLIX.COM', ['netflix.com']), true);
    assert.equal(hostMatches('evilnetflix.com', ['netflix.com']), false);
    assert.equal(hostMatches('netflix.com.evil.example', ['netflix.com']), false);
  });
});

describe('isAllowed', () => {
  it('allows the service hosts and the shared CDN suffixes', () => {
    assert.equal(isAllowed('https://www.disneyplus.com/browse', disney), true);
    assert.equal(isAllowed('https://vod-ak.akamaized.net/video.mp4', disney), true);
    assert.equal(isAllowed('https://www.netflix.com/watch', netflix), true);
  });

  it('refuses other hosts, plain http and unparseable urls', () => {
    assert.equal(isAllowed('https://example.com/', disney), false);
    assert.equal(isAllowed('http://www.disneyplus.com/', disney), false);
    assert.equal(isAllowed('not a url', disney), false);
  });

  it('allows internal schemes used by the player itself', () => {
    assert.equal(isAllowed('about:blank', disney), true);
    assert.equal(isAllowed('blob:https://www.disneyplus.com/some-uuid', disney), true);
    assert.equal(isAllowed('data:text/html,<h1>preview</h1>', disney), true);
  });
});

describe('isExternal', () => {
  it('flags service help pages and anything not allowlisted', () => {
    assert.equal(isExternal('https://help.disneyplus.com/', disney), true);
    assert.equal(isExternal('https://example.com/', disney), true);
  });

  it('does not flag the service itself', () => {
    assert.equal(isExternal('https://www.disneyplus.com/', disney), false);
  });
});

describe('services registry', () => {
  it('gives every service the shared DRM and CDN hosts', () => {
    for (const service of SERVICES) {
      const suffixes = allowedHostSuffixes(service);
      assert.ok(suffixes.includes('widevine.com'));
      assert.ok(suffixes.length > service.allowedHostSuffixes.length);
    }
  });

  it('falls back to the default service for unknown ids', () => {
    assert.equal(resolveService('does-not-exist').id, DEFAULT_SERVICE_ID);
    assert.equal(resolveService(undefined).id, DEFAULT_SERVICE_ID);
    assert.equal(getService('nope'), null);
  });

  it('keeps one partition and one identity per service', () => {
    const partitions = new Set(SERVICES.map((service) => service.partition));
    assert.equal(partitions.size, SERVICES.length);
    for (const service of SERVICES) {
      assert.ok(['linux', 'windows'].includes(service.identity));
      assert.ok(service.startUrl.startsWith('https://'));
    }
  });
});