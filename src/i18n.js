'use strict';

const fs = require('node:fs');
const path = require('node:path');
const log = require('./logger');

/**
 * Interface translations.
 *
 * The strings live in `locales/<code>.json` (see locales/README.md); this
 * module resolves which language to use, looks keys up with a fallback to the
 * base language, and fills `{placeholders}` in at call time.
 *
 * The lookup is a dotted path (`menu.playback.title`), so a file can group its
 * keys the way the interface is grouped. Files are discovered by listing the
 * directory: dropping in `fr.json` is all it takes to add French.
 *
 * Nothing here imports Electron, so the resolution inputs (the stored
 * preference and the system locale) are passed in by the caller — the module
 * can be exercised from a plain Node process, which is how it is checked
 * outside the app.
 */

const BASE = 'en';
const LOCALES_DIR = path.join(__dirname, '..', 'locales');

/** code -> parsed file (or null when unreadable); `undefined` = not tried yet. */
const dicts = new Map();
let fileNames = null;

let active = BASE;
let activeDict = null;

/** The language codes present in the locales directory. */
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

/** The language part of a locale such as `hu-HU` or `de_DE`. */
function baseCode(locale) {
  return String(locale || '').toLowerCase().split(/[-_]/)[0];
}

/**
 * The language to run in: an explicit choice when it exists, otherwise the
 * first locale source that names a language with a file here, otherwise the
 * base language.
 */
function resolve(preference, systemLocale) {
  if (preference && preference !== 'auto' && has(preference)) return preference;
  for (const candidate of localeCandidates(systemLocale)) {
    const code = baseCode(candidate);
    if (code && has(code)) return code;
  }
  return BASE;
}

/**
 * The locale sources in POSIX order — LANGUAGE (an explicit user choice), then
 * LC_ALL, LC_MESSAGES and LANG — followed by whatever the caller detected.
 *
 * The environment leads because that is what the desktop sets and it is always
 * present: Electron's own detection can come back empty (seen under Flatpak,
 * where app.getLocale() returns '' despite LANG=hu_HU.UTF-8), and without this
 * chain that would fall back to English on a Hungarian system. A candidate with
 * no matching locale file (C.UTF-8, say) simply falls through to the next.
 */
function localeCandidates(detected) {
  const language = (process.env.LANGUAGE || '').split(':')[0];
  return [language, process.env.LC_ALL, process.env.LC_MESSAGES, process.env.LANG, detected]
    .filter(Boolean);
}

/** Switches the active language; unknown codes fall back to the base one. */
function setLanguage(code) {
  if (code && code !== BASE && !has(code)) {
    log.warn(`Locale "${code}" is not available; using ${BASE}.`);
  }
  active = has(code) ? code : BASE;
  activeDict = dictFor(active);
  return active;
}

/** The active language code. */
function language() {
  return active;
}

/** Every language with a file here, base language first, `_meta.name` shown. */
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

/**
 * The translated string for a dotted key, with `{placeholders}` substituted.
 * Falls back to the base language, then to the key itself, so a partial or
 * broken translation can never render an empty control.
 */
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

/** The title-bar control labels, packaged for the sandboxed preload. */
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
  available,
  has,
  language,
  resolve,
  setLanguage,
  t,
  titlebarLabels,
};
