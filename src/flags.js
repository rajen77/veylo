'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const log = require('./logger');

// Chromium ignores most switches applied after app readiness.
const NVIDIA_VAAPI_DRIVER_FILE = 'nvidia_drv_video.so';

// Flatpak installs the shim below the Mesa driver directory.
const NVIDIA_SHIM_SUBDIR = 'nvidia-vaapi-driver';

const LIBVA_DRIVERS_PATH = 'LIBVA_DRIVERS_PATH';

// Debian multiarch paths vary by architecture.
const MULTIARCH_TUPLES = {
  x64: ['x86_64-linux-gnu'],
  arm64: ['aarch64-linux-gnu'],
  arm: ['arm-linux-gnueabihf'],
  ia32: ['i386-linux-gnu'],
};

function nvidiaVaapiDriverCandidates() {
  const override = process.env[LIBVA_DRIVERS_PATH];
  if (override) {
    // libva searches only the explicitly configured directories, not subdirectories.
    return [...new Set(override.split(':').filter(Boolean)
      .map((dir) => path.join(dir, NVIDIA_VAAPI_DRIVER_FILE)))];
  }

  const dirs = [];
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
  // Driver nodes avoid depending on an installed lspci utility.
  return fs.existsSync('/proc/driver/nvidia/version') || fs.existsSync('/dev/nvidiactl');
}

function findNvidiaVaapiDriver() {
  const found = nvidiaVaapiDriverCandidates().find((p) => fs.existsSync(p)) || null;
  if (!found) return null;

  // libva replaces its built-in paths when LIBVA_DRIVERS_PATH is set.
  const dirname = path.dirname(found);
  const shimDir = dirname.endsWith(`/${NVIDIA_SHIM_SUBDIR}`) ? dirname : null;

  if (!process.env[LIBVA_DRIVERS_PATH]) {
    // Keep Mesa drivers reachable when the shim is in a subdirectory.
    process.env[LIBVA_DRIVERS_PATH] = shimDir
      ? `${shimDir}:${path.dirname(shimDir)}`
      : dirname;
  }

  return found;
}

function hasNvidiaVaapiDriver() {
  return findNvidiaVaapiDriver() !== null;
}

const commonSwitches = [
  // Avoid duplicating renderer heaps for same-site windows.
  ['process-per-site', true],

  // Software compositing consumes substantial CPU during playback.
  ['ignore-gpu-blocklist', true],
  ['enable-gpu-rasterization', true],
  ['enable-zero-copy', true],
  // Chromium 152 removed standalone EGL; ANGLE's default uses the driver's EGL.
  ['use-gl', 'angle'],
  ['use-angle', 'default'],
  ['enable-accelerated-video-decode', true],

  ['enable-features', [
    'VaapiVideoDecoder',
    'VaapiVideoEncoder',
    'VaapiIgnoreDriverChecks',
    'UseOzonePlatform',
    'AcceleratedVideoDecodeLinuxGL',
    'CanvasOopRasterization',
  ].join(',')],

  // Disable unused browser features and Chromium's competing MPRIS service.
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

  // Keep background throttling enabled to avoid wasting CPU when minimized.
];

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
    // NVIDIA decoding requires the VA-API shim; see docs/NVIDIA.md.
    const nvidiaDriver = findNvidiaVaapiDriver();
    if (nvidiaDriver) {
      process.env.LIBVA_DRIVER_NAME = process.env.LIBVA_DRIVER_NAME || 'nvidia';
      process.env.NVD_BACKEND = process.env.NVD_BACKEND || 'direct';
      process.env.NVD_DISABLE_DMABUF_FALLBACK_SOFTWARE = '0';
      log.info(`NVIDIA VA-API driver detected at ${nvidiaDriver} - enabling hardware decoding via nvidia-vaapi-driver`);
    } else {
      // Keep GPU compositing even when video decoding falls back to CPU.
      log.warn('NVIDIA GPU detected but nvidia-vaapi-driver is missing.');
      log.warn('Install it (sudo apt install nvidia-vaapi-driver libva2 vainfo) then restart for hardware decoding.');
    }
  } else if (opts.disableHwAccel) {
    log.info('Hardware acceleration disabled on request');
    switches.push(...softwareSwitches);
  }

  if (opts.disableHwAccel && nvidia) {
    // Explicit opt-out takes precedence over NVIDIA detection.
    for (const extra of softwareSwitches) {
      if (!switches.some(([k]) => k === extra[0])) switches.push(extra);
    }
  }

  for (const [key, value] of switches) {
    if (value === true) app.commandLine.appendSwitch(key);
    else if (typeof value === 'string') app.commandLine.appendSwitch(key, value);
  }

  if (opts.forceHwAccel) {
    app.commandLine.appendSwitch('ignore-gpu-blocklist');
    log.info('Forcing hardware acceleration regardless of the driver blocklist');
  }

  log.debug(`Applied ${switches.length} Chromium switches (platform=${process.platform}, nvidia=${nvidia})`);
  return { nvidia, nvidiaVaapi, diagnostics: opts.diagnostics };
}

// GPU-process stderr can be lost in Flatpak; log feature status in the main process.
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
