'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APPARMOR_USERNS_RESTRICTION = '/proc/sys/kernel/apparmor_restrict_unprivileged_userns';
const CLONE_USERNS_SWITCH = '/proc/sys/kernel/unprivileged_userns_clone';
const APPARMOR_CURRENT = '/proc/self/attr/current';
const FLATPAK_INFO = '/.flatpak-info';

function readInt(filePath) {
  try {
    return parseInt(fs.readFileSync(filePath, 'utf8').trim(), 10);
  } catch {
    return null;
  }
}

function inFlatpak() {
  return fs.existsSync(FLATPAK_INFO);
}

// The profile is diagnostic only: a successful unshare does not guarantee a working zygote.
function currentAppArmorProfile() {
  try {
    return fs.readFileSync(APPARMOR_CURRENT, 'utf8').trim().replace(/\s*\(.*\)$/, '');
  } catch {
    return null;
  }
}

// Chromium needs either user namespaces or a root-owned setuid sandbox helper.
function inspectSandbox({ electronBinary } = {}) {
  if (process.platform !== 'linux') {
    return { usable: true, reason: 'not-linux' };
  }

  if (process.env.VEYLO_FORCE_SANDBOX === '1') {
    return { usable: true, reason: 'forced-by-env' };
  }

  if (inFlatpak()) {
    // Zypak relies on Chromium's sandbox path; Flatpak supplies the isolation.
    return { usable: true, reason: 'flatpak' };
  }

  // The launcher runs under Node and must supply the Electron binary path.
  const binary = electronBinary || process.execPath;
  const helper = path.join(path.dirname(binary), 'chrome-sandbox');
  let helperSetuid;
  try {
    const stat = fs.statSync(helper);
    helperSetuid = (stat.mode & 0o4000) !== 0 && stat.uid === 0;
  } catch {
    helperSetuid = false;
  }

  if (helperSetuid) {
    return { usable: true, reason: 'setuid-helper' };
  }

  const apparmorRestricted = readInt(APPARMOR_USERNS_RESTRICTION) === 1;
  const cloneDisabled = readInt(CLONE_USERNS_SWITCH) === 0;

  // An unshare probe can succeed even when Chromium's zygote cannot start.
  if (apparmorRestricted || cloneDisabled) {
    return {
      usable: false,
      reason: apparmorRestricted
        ? `apparmor-userns-restricted (profile: ${currentAppArmorProfile() || 'unknown'})`
        : 'userns-disabled',
      helper,
    };
  }

  return { usable: true, reason: 'userns-available' };
}

function shouldDisableSandbox(options = {}) {
  if (process.env.VEYLO_DISABLE_SANDBOX === '1') {
    return { disable: true, reason: 'requested-by-env' };
  }
  const result = inspectSandbox(options);
  return { disable: !result.usable, reason: result.reason, helper: result.helper };
}

module.exports = { inspectSandbox, shouldDisableSandbox, inFlatpak };
