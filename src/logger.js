'use strict';

const util = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const DEBUG_ENABLED =
  process.env.VEYLO_DEBUG === '1' ||
  process.env.VEYLO_DEBUG === 'true' ||
  process.argv.includes('--veylo-diagnostics');

const threshold = DEBUG_ENABLED ? LEVELS.debug : LEVELS.info;

/**
 * Inside a Flatpak the process is started through zypak, which re-executes the
 * binary and does not preserve stdout. Console output would therefore be lost,
 * so an explicit log file is written as well when VEYLO_LOG_FILE is set. The
 * write is synchronous because the process may be terminated at any point, and
 * a buffered stream would lose the last lines written before that.
 */
const logFile = process.env.VEYLO_LOG_FILE || null;
let logFileReady = false;

if (logFile) {
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, '');
    logFileReady = true;
  } catch {
    logFileReady = false;
  }
}

function write(level, args) {
  if (LEVELS[level] > threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `[${stamp}] ${level.toUpperCase().padEnd(5)} ${util.format(...args)}`;
  if (level === 'error') process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
  if (logFileReady) {
    try {
      fs.appendFileSync(logFile, `${line}\n`);
    } catch {
      // Logging must never take the app down.
      logFileReady = false;
    }
  }
}

module.exports = {
  isDebug: DEBUG_ENABLED,
  error: (...args) => write('error', args),
  warn: (...args) => write('warn', args),
  info: (...args) => write('info', args),
  debug: (...args) => write('debug', args),
};
