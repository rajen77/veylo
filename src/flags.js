'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const log = require('./logger');

/**
 * Chromium switches must be applied before the `ready` event, otherwise most of
 * them are silently ignored. This module therefore performs all of its work at
 * require-time and is the very first thing src/main.js loads.
 */

// The VA-API shim's filename is fixed by libva's loader convention.
const NVIDIA_VAAPI_DRIVER_FILE = 'nvidia_drv_video.so';

// The Flatpak VA-API extension merges the shim into a private subdirectory
// rather than next to the Mesa drivers.
const NVIDIA_SHIM_SUBDIR = 'nvidia-vaapi-driver';

// libva loads `<dir>/<driver>_drv_video.so` from each directory in this list,
// and treats a colon-separated value as a complete replacement for its own
// built-in directory. Publishing it is what lets libva find the shim.
const LIBVA_DRIVERS_PATH = 'LIBVA_DRIVERS_PATH';

// Where distros install the DRI/VA-API drivers. The Debian-style multiarch
// tuple is only one of several layouts:
//
//   Debian/Ubuntu amd64   /usr/lib/x86_64-linux-gnu/dri
//   Debian/Ubuntu arm64   /usr/lib/aarch64-linux-gnu/dri
//   Fedora/openSUSE       /usr/lib64/dri
//   Arch, Gentoo          /usr/lib/dri
//
// The tuple is derived from process.arch rather than hardcoded, so the same
// build works on every architecture castLabs publishes.
const MULTIARCH_TUPLES = {
  x64: ['x86_64-linux-gnu'],
  arm64: ['aarch64-linux-gnu'],
  arm: ['arm-linux-gnueabihf'],
  ia32: ['i386-linux-gnu'],
};

/** Candidate full paths for the NVIDIA VA-API shim, most specific first. */
function nvidiaVaapiDriverCandidates() {
  const dirs = [];

  // An explicit user setting wins and is searched first.
  const override = process.env[LIBVA_DRIVERS_PATH];
  if (override) {
    for (const dir of override.split(':')) {
      if (dir) dirs.push(dir);
    }
  }

  for (const tuple of MULTIARCH_TUPLES[process.arch] || []) {
    dirs.push(`/usr/lib/${tuple}/dri`);
  }

  dirs.push('/usr/lib64/dri', '/usr/lib/dri', '/usr/local/lib/dri');

  const candidates = [];
  for (const dir of dirs) {
    candidates.push(path.join(dir, NVIDIA_VAAPI_DRIVER_FILE));
    candidates.push(path.join(dir, NVIDIA_SHIM_SUBDIR, NVIDIA_VAAPI_DRIVER_FILE));
  }

  return [...new Set(candidates)];
}

const isLinux = process.platform === 'linux';

function isNvidiaGpu() {
  if (!isLinux) return false;
  // The discrete GPU is exposed by the driver module, so look for it rather
  // than shelling out to lspci (which may not be installed). Inside Flatpak the
  // kernel module node is still visible because --device=dri is granted.
  return fs.existsSync('/proc/driver/nvidia/version') || fs.existsSync('/dev/nvidiactl');
}

function findNvidiaVaapiDriver() {
  const found = nvidiaVaapiDriverCandidates().find((p) => fs.existsSync(p)) || null;
  if (!found) return null;

  // libva replaces its built-in directory list with LIBVA_DRIVERS_PATH, so once
  // the shim is located, the directory holding it has to be published;
  // otherwise libva keeps looking only in the distro default and never finds it.
  const dirname = path.dirname(found);
  const shimDir = dirname.endsWith(`/${NVIDIA_SHIM_SUBDIR}`) ? dirname : null;

  if (!process.env[LIBVA_DRIVERS_PATH]) {
    // When the shim sits in a subdirectory, keep the parent on the path as well
    // so the Mesa drivers Chromium also relies on stay reachable.
    process.env[LIBVA_DRIVERS_PATH] = shimDir
      ? `${shimDir}:${path.dirname(shimDir)}`
      : dirname;
  }

  return found;
}

function hasNvidiaVaapiDriver() {
  return findNvidiaVaapiDriver() !== null;
}

/** Switches that are safe and beneficial on every Linux setup. */
const commonSwitches = [
  // One renderer process per site instead of per window. The client only ever
  // loads Disney+ and its same-origin sign-in popups, so the extra processes
  // Chromium spawns by default only duplicate the same V8 heap for no benefit.
  ['process-per-site', true],

  // Keep the GPU path for compositing; software compositing wastes a full core
  // during playback and defeats the point of a lightweight client.
  ['ignore-gpu-blocklist', true],
  ['enable-gpu-rasterization', true],
  ['enable-zero-copy', true],
  // Chromium 152 dropped the standalone "egl" GL implementation; the only one
  // it still accepts is ANGLE's EGL backend. Requesting "egl" made the GPU
  // process abort with "Requested GL implementation (gl=egl-gles2,angle=none)
  // not found", which silently downgraded the whole client to software
  // compositing and disabled VA-API. ANGLE's default backend is the one that
  // maps onto the driver's EGL implementation.
  ['use-gl', 'angle'],
  ['use-angle', 'default'],
  ['enable-accelerated-video-decode', true],

  // H.264 is the codec Disney+ actually ships. Without this the bundled
  // Chromium may refuse proprietary codecs and fall back to a black frame.
  ['enable-features', [
    'VaapiVideoDecoder',
    'VaapiVideoEncoder',
    'VaapiIgnoreDriverChecks',
    'UseOzonePlatform',
    'AcceleratedVideoDecodeLinuxGL',
    'CanvasOopRasterization',
  ].join(',')],

  // Drop the features that only make sense for a general purpose browser; each
  // one costs memory or background CPU that a single-site client does not need.
  ['disable-features', [
    'AudioServiceOutOfProcess',
    'HardwareMediaKeyHandling',
    'MediaSessionService',
    'DialMediaRouteProvider',
    'GlobalMediaControls',
    'OptimizationHints',
    'CalculateNativeWinOcclusion',
    'AutofillServerCommunication',
    'InterestFeedContentSuggestions',
    'Translate',
  ].join(',')],

  // Background throttling is deliberately left at Chromium's default. The three
  // switches that used to be set here (disable-background-timer-throttling,
  // disable-renderer-backgrounding, disable-backgrounding-occluded-windows)
  // kept the renderer running at full speed while the window was minimized or
  // covered, which cost CPU whenever the client sat in the tray. Playback and
  // media events are not throttled for a hidden page, and the MPRIS layer
  // interpolates the position between updates, so nothing visible changes when
  // the window is in the background.
];

/** Extra switches that force Chromium onto the CPU. Applied only on request. */
const softwareSwitches = [
  ['disable-gpu', true],
  ['disable-gpu-compositing', true],
];

function parseArgs() {
  const args = new Set(process.argv.slice(1));
  const valueOf = (name) => {
    const withEquals = [...args].find((a) => a.startsWith(`--${name}=`));
    return withEquals ? withEquals.slice(name.length + 3) : null;
  };
  return {
    disableHwAccel: args.has('--disable-hardware-acceleration'),
    forceHwAccel: valueOf('force-hardware-acceleration') !== null,
    diagnostics: args.has('--veylo-diagnostics'),
  };
}

function applySwitches() {
  const opts = parseArgs();
  const nvidia = isNvidiaGpu();
  const nvidiaVaapi = hasNvidiaVaapiDriver();

  const switches = [...commonSwitches];

  if (nvidia) {
    // Chromium's VA-API path is written against Mesa. On NVIDIA it only works
    // through the nvidia-vaapi-driver shim, and only if libva is pointed at it.
    // See docs/NVIDIA.md for the reasoning and the package names.
    const nvidiaDriver = findNvidiaVaapiDriver();
    if (nvidiaDriver) {
      process.env.LIBVA_DRIVER_NAME = process.env.LIBVA_DRIVER_NAME || 'nvidia';
      process.env.NVD_BACKEND = process.env.NVD_BACKEND || 'direct';
      process.env.NVD_DISABLE_DMABUF_FALLBACK_SOFTWARE = '0';
      log.info(`NVIDIA VA-API driver detected at ${nvidiaDriver} - enabling hardware decoding via nvidia-vaapi-driver`);
    } else {
      // Without the shim, asking Chromium for VA-API only produces errors and a
      // stalled first frame. Do NOT disable the GPU process here: compositing
      // still benefits from it, and killing it makes Chromium exit outright.
      // Videos are simply decoded on the CPU, which is what a browser without
      // the shim would do as well.
      log.warn('NVIDIA GPU detected but nvidia-vaapi-driver is missing.');
      log.warn('Install it (sudo apt install nvidia-vaapi-driver libva2 vainfo) then restart for hardware decoding.');
    }
  } else if (opts.disableHwAccel) {
    log.info('Hardware acceleration disabled on request');
    switches.push(...softwareSwitches);
  }

  if (opts.disableHwAccel && nvidia) {
    // An explicit opt-out always wins over the automatic NVIDIA handling.
    for (const extra of softwareSwitches) {
      if (!switches.some(([k]) => k === extra[0])) switches.push(extra);
    }
  }

  // Note: sandbox-related switches are deliberately NOT set here. Chromium
  // forks its zygote before this module runs, so appending them would be too
  // late; scripts/launch.js puts them on the command line instead, using the
  // shared detection in src/sandbox.js.

  for (const [key, value] of switches) {
    if (value === true) app.commandLine.appendSwitch(key);
    else if (typeof value === 'string') app.commandLine.appendSwitch(key, value);
  }

  // Force-enable the hardware decode path even when Chromium's internal
  // blocklist would reject the driver we just configured.
  if (opts.forceHwAccel) {
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    log.info('Forcing hardware acceleration regardless of the driver blocklist');
  }

  log.debug(`Applied ${switches.length} Chromium switches (platform=${process.platform}, nvidia=${nvidia})`);
  return { nvidia, nvidiaVaapi, diagnostics: opts.diagnostics };
}

/**
 * Chromium reports hardware acceleration problems only in the GPU process,
 * whose stderr is discarded inside Flatpak, and a rejected GL implementation
 * otherwise degrades playback to software silently. Under --veylo-diagnostics
 * the resulting feature status is therefore logged in the main process, where
 * the logger can actually record it.
 */
async function reportGpuStatus() {
  try {
    const status = app.getGPUFeatureStatus();
    const accel = ['gpu_compositing', 'video_decode', 'rasterization']
      .map((key) => `${key}=${status[key]}`)
      .join(' ');
    log.debug(`GPU feature status: ${accel}`);
    if (status.video_decode && !String(status.video_decode).startsWith('enabled')) {
      log.warn(`Hardware video decoding is not active (video_decode=${status.video_decode}).`);
      log.warn('Playback will work but use more CPU; run --veylo-diagnostics for details.');
    }
    if (app.getGPUInfo) log.debug('GPU info:', JSON.stringify(await app.getGPUInfo('basic')));
  } catch (err) {
    log.debug('GPU status unavailable:', err.message);
  }
}

module.exports = {
  applySwitches,
  reportGpuStatus,
  isNvidiaGpu,
  hasNvidiaVaapiDriver,
  findNvidiaVaapiDriver,
  nvidiaVaapiDriverCandidates,
};
