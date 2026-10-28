'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// prefs only needs electron for app.getPath('userData'), which these cases
// bypass by passing the file path explicitly (see test/updater.test.js).
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
    assert.deepEqual(prefs, { lastServiceId: 'disneyplus', autoOpen: false, language: 'auto' });
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
    assert.deepEqual(prefs, { lastServiceId: 'disneyplus', autoOpen: false, language: 'auto' });
  });

  it('round-trips valid values', () => {
    const file = path.join(tmpDir, 'roundtrip.json');
    const prefs = { lastServiceId: 'netflix', autoOpen: true, language: 'hu' };
    save(prefs, file);
    assert.deepEqual(load(file), prefs);
  });
});