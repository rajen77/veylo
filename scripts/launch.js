#!/usr/bin/env node
'use strict';

// Pass sandbox flags before Chromium starts its zygote.

const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const { shouldDisableSandbox } = require(path.join(projectRoot, 'src', 'sandbox.js'));

function resolveElectronBinary() {
  try {
    const binary = require('electron');
    if (typeof binary === 'string') return binary;
  } catch {
    /* fall through to the explicit path below */
  }
  return path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron');
}

function main() {
  const binary = resolveElectronBinary();
  const userArgs = process.argv.slice(2);
  const electronFlags = [];

  const sandbox = shouldDisableSandbox({ electronBinary: binary });
  if (sandbox.disable) {
    // The zygote also fails when the sandbox is unavailable.
    electronFlags.push('--no-sandbox', '--no-zygote');
    process.stderr.write(
      `[launcher] Chromium process sandbox is unavailable (${sandbox.reason}); starting without it.\n`,
    );
    if (sandbox.helper) {
      process.stderr.write(
        `[launcher] To re-enable it: sudo chown root:root ${sandbox.helper} && sudo chmod 4755 ${sandbox.helper}\n`,
      );
    }
  }

  const child = spawn(binary, [...electronFlags, projectRoot, ...userArgs], {
    stdio: 'inherit',
    env: process.env,
  });

  child.on('close', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => child.kill(signal));
  }
}

main();
