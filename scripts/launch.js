#!/usr/bin/env node
'use strict';

/**
 * Launcher for Veylo.
 *
 * Chromium creates its zygote process before any application JavaScript runs,
 * so switches appended from src/main.js are too late for sandbox-related flags:
 * the process would already have died. The sandbox decision therefore has to be
 * made by the parent process, which is what this launcher does.
 *
 * It re-executes the same detection used at runtime (src/sandbox.js) and passes
 * the resulting flags on the command line. Everything else stays in main.js.
 */

const path = require('node:path');
const { spawn } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const { shouldDisableSandbox } = require(path.join(projectRoot, 'src', 'sandbox.js'));

function resolveElectronBinary() {
  // `require('electron')` from outside an Electron process resolves to the path
  // of the downloaded binary.
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
    // --no-zygote is required in addition to --no-sandbox: without it Chromium
    // still forks a zygote, which fails under the same restriction.
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
