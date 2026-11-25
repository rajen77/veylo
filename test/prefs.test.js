'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// These tests pass paths explicitly and do not need Electron's app API.
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: {} },
};

const { load, save } = require('../src/prefs');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veylo-prefs-test-'));
});

after(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writePrefs(name, value) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe('prefs', () => {
  it('returns the defaults when the file does not exist', () => {
    const prefs = load(path.join(tmpDir, 'missing.json'));
    assert.deepEqual(prefs, { lastServiceId: 'disneyplus', autoOpen: false, language: 'auto', favorites: [], serviceOrder: [], hideUnavailable: false });
  });

  it('rejects an unknown service id and an empty language', () => {
    const file = writePrefs('unknown.json', {
      lastServiceId: 'service-that-was-removed',
      autoOpen: true,
      language: '',
    });
    const prefs = load(file);
    assert.equal(prefs.lastServiceId, 'disneyplus');
    assert.equal(prefs.autoOpen, true);
    assert.equal(prefs.language, 'auto');
  });

  it('falls back to the defaults for a corrupt file', () => {
    const file = path.join(tmpDir, 'corrupt.json');
    fs.writeFileSync(file, '{not json');
    const prefs = load(file);
    assert.deepEqual(prefs, { lastServiceId: 'disneyplus', autoOpen: false, language: 'auto', favorites: [], serviceOrder: [], hideUnavailable: false });
  });

  it('round-trips valid values', () => {
    const file = path.join(tmpDir, 'roundtrip.json');
    const prefs = { lastServiceId: 'netflix', autoOpen: true, language: 'hu', favorites: ['plex'], serviceOrder: ['plex', 'netflix'], hideUnavailable: true };
    save(prefs, file);
    assert.deepEqual(load(file), prefs);
  });

  it('ignores removed and duplicate services in saved arrangements', () => {
    const file = writePrefs('arrangement.json', {
      favorites: ['plex', 'removed', 'plex', 1],
      serviceOrder: ['netflix', 'removed', 'netflix', 'plex'],
    });
    const prefs = load(file);
    assert.deepEqual(prefs.favorites, ['plex']);
    assert.deepEqual(prefs.serviceOrder, ['netflix', 'plex']);
    assert.equal(prefs.hideUnavailable, false);
  });
});