'use strict';

/**
 * Unpacks the snap template into the packed application directory.
 *
 * Why this exists: electron-builder's snap target (v26.15.3, template path)
 * downloads its snap template as a `.tar.7z`, unpacks the 7z into its cache —
 * and then passes the *inner tar archive itself* to mksquashfs instead of
 * unpacking it. The archive is where the launcher scripts (`desktop-init.sh`
 * and siblings) and the runtime libraries (`usr/lib/.../libnspr4.so`,
 * `libnss3.so`, …) live, yet the generated `command.sh` execs
 * `$SNAP/desktop-init.sh` and the Electron binary links against those
 * libraries — so the snap as produced by the builder dies with
 * "error while loading shared libraries: libnspr4.so".
 *
 * This hook downloads the same template the snap target uses (through the
 * builder's own toolset downloader, so it reuses the cache and the checksum
 * verification) and unpacks the tar into the app directory. The snap target
 * merges the top level of that directory into the snap root, which is exactly
 * where command.sh and the dynamic linker look for these files.
 *
 * The template coordinates (release name, file name, sha256) are duplicated
 * from `app-builder-lib/out/targets/snap/coreLegacy.js` (`SNAP_TEMPLATES`)
 * because that constant is not exported; if the builder ever bumps the
 * template release, update them here too.
 *
 * The copy only happens when a snap is among the targets, so the native
 * packages stay clean.
 */

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');

const run = promisify(execFile);

// Must match SNAP_TEMPLATES.amd64 in app-builder-lib/out/targets/snap/coreLegacy.js.
const TEMPLATE = {
  releaseName: 'snap-template-4.0-2',
  filenameWithExt: 'snap-template-electron-4.0-2-amd64.tar.7z',
  checksums: {
    'snap-template-electron-4.0-2-amd64.tar.7z':
      '5e3ab4e09364ac06f0072b1c2dab9138318c933f6b2c7374f893b5ec44d19e6f',
  },
  githubOrgRepo: 'electron-userland/electron-builder-binaries',
};

exports.default = async function afterPack(context) {
  const { appOutDir, targets } = context;
  const names = (targets || []).map((target) => (typeof target === 'string' ? target : target.name));
  // `targets` missing → be safe and unpack; otherwise only when snap is included.
  if (Array.isArray(targets) && !names.includes('snap')) return;

  // The builder's own downloader: same cache, same checksum check as the snap
  // target itself, so this cannot fetch a different archive than it would.
  const { downloadBuilderToolset } = require('app-builder-lib/out/util/electronGet');
  const templateDir = await downloadBuilderToolset(TEMPLATE);

  // The 7z is unpacked into the cache by the builder; what remains is the tar.
  const tarName = TEMPLATE.filenameWithExt.replace(/\.7z$/, '');
  const tarPath = path.join(templateDir, tarName);
  if (!fs.existsSync(tarPath)) {
    throw new Error(`Snap template tar not found at ${tarPath}`);
  }

  // `tar` is part of every Linux system this target builds on; the archive
  // uses ./-prefixed paths, which land directly in the app directory.
  await run('tar', ['-xf', tarPath, '-C', appOutDir]);
};
