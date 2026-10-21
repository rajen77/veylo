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

/**
 * The AppArmor profile attached to this process, e.g. "vscode" or "unconfined".
 * Reported for diagnostics only. A profile that grants `userns,` does NOT make
 * Chromium's sandbox work: empirically a successful `unshare -Ur true` probe from
 * such a profile still leaves the zygote failing with exit 133, so probing for
 * namespaces gives a false positive and the global sysctl below is the reliable
 * signal. (Ubuntu 24.04+ ships `userns,` profiles for chrome, code, brave, ...,
 * which is why a plain terminal can unshare while Electron still cannot start.)
 */
function currentAppArmorProfile() {
  try {
    return fs.readFileSync(APPARMOR_CURRENT, 'utf8').trim().replace(/\s*\(.*\)$/, '');
  } catch {
    return null;
  }
}

/**
 * Chromium's process sandbox needs either user namespaces or a setuid root
 * chrome-sandbox helper. Both can be unavailable:
 *
 *  - Ubuntu 24.04+ sets apparmor_restrict_unprivileged_userns=1, which denies
 *    namespace creation to unconfined processes, and
 *  - a locally unpacked Electron binary ships chrome-sandbox without the setuid
 *    bit, so the fallback helper cannot be used either.
 *
 * When neither route exists the zygote cannot start and the whole browser
 * process dies, so the sandbox has to be turned off for the app to run at all.
 * This is detected here and reported loudly, together with the proper fix,
 * rather than silently degrading security on machines where the sandbox works.
 */
function inspectSandbox({ electronBinary } = {}) {
  if (process.platform !== 'linux') {
    return { usable: true, reason: 'not-linux' };
  }

  if (process.env.VEYLO_FORCE_SANDBOX === '1') {
    return { usable: true, reason: 'forced-by-env' };
  }

  if (inFlatpak()) {
    // Flatpak supplies its own bubblewrap sandbox and, through the Electron2
    // BaseApp, zypak redirects Chromium's own sandbox to it. The inner sandbox
    // is therefore expected to work, and the app must NOT pass --no-sandbox:
    // zypak relies on the sandbox path being taken. Only the GPU process needs
    // its private sandbox turned off, and run.sh already passes
    // --disable-gpu-sandbox for that; see docs/FLATPAK.md.
    return { usable: true, reason: 'flatpak' };
  }

  // process.execPath points at the Electron binary inside Electron, but at Node
  // in the launcher, so the caller supplies the real binary when it knows it.
  const binary = electronBinary || process.execPath;
  const helper = path.join(path.dirname(binary), 'chrome-sandbox');
  let helperSetuid = false;
  try {
    const stat = fs.statSync(helper);
    // setuid bit set and owned by root -> the SUID sandbox path is available.
    helperSetuid = (stat.mode & 0o4000) !== 0 && stat.uid === 0;
  } catch {
    helperSetuid = false;
  }

  if (helperSetuid) {
    return { usable: true, reason: 'setuid-helper' };
  }

  const apparmorRestricted = readInt(APPARMOR_USERNS_RESTRICTION) === 1;
  const cloneDisabled = readInt(CLONE_USERNS_SWITCH) === 0;

  // These sysctls describe the restriction that actually applies to Chromium's
  // zygote. Do not replace them with a `unshare -Ur` probe: a profile granting
  // `userns,` lets the probe succeed while the zygote still dies.
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
