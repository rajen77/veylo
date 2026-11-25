'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');

const i18n = require('../src/i18n');

// Avoid leaking the module's active language into other cases.
after(() => i18n.setLanguage('en'));

function withEnv(values, fn) {
  const saved = new Map();
  for (const [key, value] of Object.entries(values)) {
    saved.set(key, process.env[key]);
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('i18n', () => {
  it('lists the shipped languages, base language first', () => {
    const available = i18n.available();
    assert.deepEqual(available.map((entry) => entry.code), ['en', 'de', 'hu']);
    for (const entry of available) assert.ok(entry.name);
  });

  it('resolves an explicit preference when the locale file exists', () => {
    assert.equal(i18n.resolve('de', 'en_US.UTF-8'), 'de');
    assert.equal(i18n.resolve('hu', 'en_US.UTF-8'), 'hu');
  });

  it('falls back to English for an unknown preference', () => {
    // Exclude the host's locale from the fallback.
    withEnv({ LANGUAGE: null, LC_ALL: null, LC_MESSAGES: null, LANG: null }, () => {
      assert.equal(i18n.resolve('fr', 'en_US.UTF-8'), 'en');
    });
  });

  it('follows the system locale in POSIX precedence order', () => {
    withEnv({ LANGUAGE: 'de:hu', LC_ALL: 'hu_HU.UTF-8', LC_MESSAGES: null, LANG: 'hu_HU.UTF-8' }, () => {
      assert.equal(i18n.resolve('auto', 'en_US.UTF-8'), 'de');
    });
    withEnv({ LANGUAGE: null, LC_ALL: 'hu_HU.UTF-8', LC_MESSAGES: null, LANG: 'de_DE.UTF-8' }, () => {
      assert.equal(i18n.resolve('auto', 'en_US.UTF-8'), 'hu');
    });
    withEnv({ LANGUAGE: null, LC_ALL: null, LC_MESSAGES: null, LANG: 'C.UTF-8' }, () => {
      assert.equal(i18n.resolve('auto', 'de_DE.UTF-8'), 'de');
      assert.equal(i18n.resolve('auto', 'fr_FR.UTF-8'), 'en');
    });
  });

  it('builds the Accept-Language list from the locale metadata', () => {
    i18n.setLanguage('en');
    assert.deepEqual(i18n.acceptLanguages(), ['en-US', 'en']);
    i18n.setLanguage('hu');
    assert.deepEqual(i18n.acceptLanguages(), ['hu-HU', 'hu']);
    i18n.setLanguage('en');
  });

  it('translates dotted keys with placeholders', () => {
    i18n.setLanguage('en');
    assert.equal(i18n.t('menu.playback.title'), 'Playback');
    assert.equal(
      i18n.t('dialogs.updates.upToDate', { version: '1.2.3' }),
      'You are running the latest version (1.2.3).',
    );
    i18n.setLanguage('hu');
    assert.equal(i18n.t('menu.playback.title'), 'Lejátszás');
    i18n.setLanguage('en');
  });

  it('falls back to the key itself when no language has the string', () => {
    i18n.setLanguage('en');
    assert.equal(i18n.t('no.such.key.at.all'), 'no.such.key.at.all');
  });

  it('keeps the titlebar label set complete', () => {
    i18n.setLanguage('en');
    const labels = i18n.titlebarLabels();
    assert.deepEqual(
      Object.keys(labels),
      ['menu', 'fullscreen', 'exitFullscreen', 'minimize', 'maximize', 'restore', 'close'],
    );
    for (const value of Object.values(labels)) assert.ok(value);
  });
});