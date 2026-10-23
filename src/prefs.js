'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const log = require('./logger');
const { DEFAULT_SERVICE_ID, getService } = require('./services');

/**
 * The choices that are not window geometry: which service was used last, and
 * whether it should open without asking. Window state has its own file (see
 * src/window-state.js); keeping these apart means neither can corrupt the
 * other, and this file stays small enough to edit by hand.
 *
 * An unknown or removed service id falls back to the default rather than
 * being passed on: a stale id must not produce a window with no page.
 */

const FILE_NAME = 'prefs.json';

function prefsFile() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function load(file = prefsFile()) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      log.warn(`Prefs could not be read from ${file}: ${err.message}`);
    }
    raw = {};
  }

  return {
    lastServiceId: getService(raw.lastServiceId) ? raw.lastServiceId : DEFAULT_SERVICE_ID,
    autoOpen: raw.autoOpen === true,
  };
}

function save(prefs, file = prefsFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
    log.debug(`Prefs saved: last=${prefs.lastServiceId} autoOpen=${prefs.autoOpen}`);
  } catch (err) {
    log.warn(`Prefs could not be saved to ${file}: ${err.message}`);
  }
}

module.exports = { load, save, prefsFile };
