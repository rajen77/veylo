'use strict';

const log = require('./logger');
const { availableInRegion } = require('./services');

// The service-specific user agent does not identify the user's actual country.
const ENDPOINTS = [
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: countryFromTrace },
  { url: 'https://ifconfig.co/country-iso', parse: countryFromText },
];

const TIMEOUT_MS = 3_000;

function normalise(value) {
  const code = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function countryFromTrace(text) {
  const line = String(text).split(/\r?\n/).find((entry) => entry.startsWith('loc='));
  return line ? normalise(line.slice('loc='.length)) : null;
}

function countryFromText(text) {
  return normalise(text);
}

let pinned = normalise(process.env.VEYLO_REGION);
let resolved = null;
let done = false;
let inflight = null;

function regionCode() {
  return pinned || resolved;
}

function setRegion(code) {
  pinned = normalise(code);
  resolved = null;
  done = false;
  inflight = null;
}

async function lookup({ fetchImpl, timeoutMs }) {
  for (const endpoint of ENDPOINTS) {
    try {
      const response = await fetchImpl(endpoint.url, {
        headers: { 'User-Agent': 'veylo' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const code = endpoint.parse(await response.text());
      if (code) {
        log.debug(`Region ${code} from ${endpoint.url}`);
        return code;
      }
      throw new Error('no country in the response');
    } catch (err) {
      log.debug(`Region lookup failed for ${endpoint.url}: ${err.message}`);
    }
  }
  log.warn('Region could not be determined; availability of restricted services is unknown.');
  return null;
}

/**
 * Concurrent callers share the request; failures are not retried in the same run.
 *
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl] injected by the tests
 * @param {number} [options.timeoutMs] per-endpoint timeout
 * @returns {Promise<string|null>} the country code, or null when unknown
 */
async function detectCountry({ fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (pinned) return pinned;
  if (done) return resolved;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      resolved = await lookup({ fetchImpl, timeoutMs });
    } finally {
      done = true;
      inflight = null;
    }
    return resolved;
  })();
  return inflight;
}

async function confirmRegionalAccess(service, country, parent, { dialog, t }) {
  if (availableInRegion(service, country)) return true;
  const options = {
    type: 'warning',
    title: t('dialogs.region.title'),
    message: t(country ? 'dialogs.region.unavailable' : 'dialogs.region.unknown', { service: service.name }),
    detail: t('dialogs.region.detail'),
    buttons: [t('dialogs.region.cancel'), t('dialogs.region.open')],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const result = parent && !parent.isDestroyed()
    ? await dialog.showMessageBox(parent, options)
    : await dialog.showMessageBox(options);
  return result.response === 1;
}

module.exports = {
  detectCountry,
  confirmRegionalAccess,
  regionCode,
  setRegion,
  countryFromTrace,
  countryFromText,
};