#!/usr/bin/env node
'use strict';

// castLabs Electron has no postinstall hook to download the runtime.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const electronDir = path.join(projectRoot, 'node_modules', 'electron');
const installer = path.join(electronDir, 'install.js');

if (!fs.existsSync(electronDir)) {
  process.exit(0);
}

if (!fs.existsSync(installer)) {
  console.log('[postinstall] castLabs Electron installer not found, skipping.');
  process.exit(0);
}

const result = spawnSync(process.execPath, [installer], { stdio: 'inherit', cwd: projectRoot });

if (result.status !== 0) {
  console.error('[postinstall] Failed to download the Electron binary.');
  console.error('[postinstall] Run "node node_modules/electron/install.js" manually and check your network.');
  process.exit(result.status ?? 1);
}

console.log('[postinstall] castLabs Electron (Widevine enabled) is ready.');
