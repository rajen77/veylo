'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: { app: {} },
};

const { findNvidiaVaapiDriver } = require('../src/flags');

it('honours the exact libva search path without reporting inaccessible drivers', (t) => {
  const previous = process.env.LIBVA_DRIVERS_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.LIBVA_DRIVERS_PATH;
    else process.env.LIBVA_DRIVERS_PATH = previous;
  });
  process.env.LIBVA_DRIVERS_PATH = '/custom/dri';
  const nested = path.join('/custom/dri', 'nvidia-vaapi-driver', 'nvidia_drv_video.so');
  const direct = path.join('/custom/dri', 'nvidia_drv_video.so');
  let directAvailable = false;
  t.mock.method(fs, 'existsSync', (file) => file === nested || (directAvailable && file === direct));

  assert.equal(findNvidiaVaapiDriver(), null);
  directAvailable = true;
  assert.equal(findNvidiaVaapiDriver(), direct);
  process.env.LIBVA_DRIVERS_PATH = '/custom/dri/nvidia-vaapi-driver';
  assert.equal(findNvidiaVaapiDriver(), nested);
  process.env.LIBVA_DRIVERS_PATH = '/missing';
  assert.equal(findNvidiaVaapiDriver(), null);
});

it('publishes the discovered shim and its parent when no path is configured', (t) => {
  const previous = process.env.LIBVA_DRIVERS_PATH;
  t.after(() => {
    if (previous === undefined) delete process.env.LIBVA_DRIVERS_PATH;
    else process.env.LIBVA_DRIVERS_PATH = previous;
  });
  delete process.env.LIBVA_DRIVERS_PATH;
  const nested = '/usr/local/lib/dri/nvidia-vaapi-driver/nvidia_drv_video.so';
  t.mock.method(fs, 'existsSync', (file) => file === nested);
  assert.equal(findNvidiaVaapiDriver(), nested);
  assert.equal(process.env.LIBVA_DRIVERS_PATH, '/usr/local/lib/dri/nvidia-vaapi-driver:/usr/local/lib/dri');
});
