'use strict';

const log = require('./logger');

/**
 * Which country the client is streaming from.
 *
 * A few services only license their catalogue to certain countries and answer
 * anything else with an interstitial — Tubi shows its GDPR page, Pluto TV a
 * location screen, Peacock an "Unavailable In Your Region" page. Opening such a
 * service here would only produce that screen, so the chooser, the Service menu
 * and `--service` offer the services that actually stream in this country
 * (see `availableIn` in src/services.js).
 *
 * The country follows the caller's IP address, so it has to come from a
 * geolocation endpoint: the user agent is already spoofed per service (see
 * src/user-agent.js) and says nothing about where the machine is. One request
 * is made at startup; a failure is not retried within the same run, because a
 * missing country only has to hide the restricted services, never block
 * startup.
 *
 * `VEYLO_REGION=<ISO 3166-1 alpha-2>` pins the country without any lookup.
 * That is also the escape hatch when the endpoint is unreachable or wrong.
 */

// Cloudflare's debug endpoint answers with plain `key=value` lines (`loc=HU`)
// and is reachable from the same network that reaches the services themselves.
// ifconfig.co returns the bare country code and is only used as a fallback.
const ENDPOINTS = [
  { url: 'https://www.cloudflare.com/cdn-cgi/trace', parse: countryFromTrace },
  { url: 'https://ifconfig.co/country-iso', parse: countryFromText },
];

const TIMEOUT_MS = 3_000;

/** A two-letter ISO 3166-1 alpha-2 code in upper case, or null. */
function normalise(value) {
  const code = String(value == null ? '' : value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/** Reads the `loc=HU` line out of a Cloudflare trace body. */
function countryFromTrace(text) {
  const line = String(text).split(/\r?\n/).find((entry) => entry.startsWith('loc='));
  return line ? normalise(line.slice('loc='.length)) : null;
}

/** Reads a body that is nothing but the country code. */
function countryFromText(text) {
  return normalise(text);
}

// The pin from the environment is read once, like the other VEYLO_* settings.
let pinned = normalise(process.env.VEYLO_REGION);
let resolved = null;
let done = false;
let inflight = null;

/** The country known so far, or null when it could not be determined. */
function regionCode() {
  return pinned || resolved;
}

/**
 * Pins the country, replacing both the environment value and any earlier
 * lookup. Passing null clears the pin, which is what the tests use to get a
 * known state back.
 */
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
  log.warn('Region could not be determined; geo-restricted services stay hidden.');
  return null;
}

/**
 * Resolves the country, at most once per run. Concurrent callers share the
 * same request, and a failed lookup is remembered rather than repeated.
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

module.exports = {
  detectCountry,
  regionCode,
  setRegion,
  countryFromTrace,
  countryFromText,
};