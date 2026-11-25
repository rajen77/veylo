'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const log = require('./logger');
const { DEFAULT_SERVICE_ID, getService } = require('./services');

const FILE_NAME = 'prefs.json';

function prefsFile() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function load(file = prefsFile()) {
  let raw;
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
    language: typeof raw.language === 'string' && raw.language ? raw.language : 'auto',
    favorites: serviceIds(raw.favorites),
    serviceOrder: serviceIds(raw.serviceOrder),
    hideUnavailable: raw.hideUnavailable === true,
  };
}

function serviceIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id) => typeof id === 'string' && getService(id)))];
}

function save(prefs, file = prefsFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
    log.debug(`Prefs saved: last=${prefs.lastServiceId} autoOpen=${prefs.autoOpen} language=${prefs.language}`);
  } catch (err) {
    log.warn(`Prefs could not be saved to ${file}: ${err.message}`);
  }
}

module.exports = { load, save, prefsFile };
