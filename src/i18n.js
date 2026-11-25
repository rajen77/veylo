'use strict';

const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');

const BASE = 'en';
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

/** code -> parsed file (or null when unreadable); `undefined` = not tried yet. */
const dicts = new Map();
let fileNames = null;

let active = BASE;
let activeDict = null;

function fileNamesOf() {
  if (fileNames) return fileNames;
  try {
    fileNames = fs.readdirSync(LOCALES_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
  } catch (err) {
    log.warn(`Locale directory could not be read (${LOCALES_DIR}): ${err.message}`);
    fileNames = [];
  }
  return fileNames;
}

function has(code) {
  return fileNamesOf().includes(code);
}

function dictFor(code) {
  if (dicts.has(code)) return dicts.get(code);
  let parsed = null;
  if (has(code)) {
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, `${code}.json`), 'utf8'));
    } catch (err) {
      log.warn(`Locale file ${code}.json could not be read: ${err.message}`);
    }
  }
  dicts.set(code, parsed);
  return parsed;
}

function baseCode(locale) {
  return String(locale || '').toLowerCase().split(/[-_]/)[0];
}

function resolve(preference, systemLocale) {
  if (preference && preference !== 'auto' && has(preference)) return preference;
  for (const candidate of localeCandidates(systemLocale)) {
    const code = baseCode(candidate);
    if (code && has(code)) return code;
  }
  return BASE;
}

// Electron can report an empty locale in a sandbox; prefer desktop environment settings.
function localeCandidates(detected) {
  const language = (process.env.LANGUAGE || '').split(':')[0];
  return [language, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, detected]
    .filter(Boolean);
}

function setLanguage(code) {
  if (code && code !== BASE && !has(code)) {
    log.warn(`Locale "${code}" is not available; using ${BASE}.`);
  }
  active = has(code) ? code : BASE;
  activeDict = dictFor(active);
  return active;
}

// Keep request headers and page-side language consistent.
function acceptLanguages() {
  const meta = (dictFor(active) || {})._meta || {};
  const primary = String(meta.acceptLocale || active);
  return primary === active ? [active] : [primary, active];
}

function language() {
  return active;
}

function available() {
  return fileNamesOf()
    .map((code) => {
      const meta = (dictFor(code) || {})._meta || {};
      return { code, name: String(meta.name || code) };
    })
    .sort((a, b) => {
      if (a.code === BASE) return -1;
      if (b.code === BASE) return 1;
      return a.name.localeCompare(b.name);
    });
}

function lookup(dict, key) {
  if (!dict || typeof dict !== 'object') return undefined;
  let node = dict;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part];
  }
  return node;
}

function format(text, params) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match
  ));
}

const reportedMissing = new Set();

// Fall back to the key rather than rendering an empty control.
function t(key, params) {
  let value = lookup(activeDict, key);
  if (typeof value !== 'string') value = lookup(dictFor(BASE), key);
  if (typeof value !== 'string') {
    if (!reportedMissing.has(key)) {
      reportedMissing.add(key);
      log.warn(`Missing translation for "${key}" (language: ${active})`);
    }
    return key;
  }
  return format(value, params);
}

function titlebarLabels() {
  return {
    menu: t('titlebar.menu'),
    fullscreen: t('titlebar.fullscreen'),
    exitFullscreen: t('titlebar.exitFullscreen'),
    minimize: t('titlebar.minimize'),
    maximize: t('titlebar.maximize'),
    restore: t('titlebar.restore'),
    close: t('titlebar.close'),
  };
}

activeDict = dictFor(active);

module.exports = {
  BASE,
  acceptLanguages,
  available,
  has,
  language,
  resolve,
  setLanguage,
  t,
  titlebarLabels,
};
