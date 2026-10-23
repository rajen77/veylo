'use strict';

/**
 * Puts the snap launcher scripts into the packed application directory.
 *
 * Why this exists: electron-builder's snap target (v26.15.3, template path)
 * downloads its snap template as a tar archive and passes the *archive* to
 * mksquashfs instead of unpacking it. The template is where
 * `desktop-init.sh`, `desktop-common.sh` and `desktop-gnome-specific.sh`
 * live, yet the generated `command.sh` execs `$SNAP/desktop-init.sh` — so the
 * resulting snap never starts. The three scripts are vendored in
 * `snap-launchers/` (verbatim from electron-userland/electron-builder-binaries,
 * release snap-template-4.0-2, MIT) and copied in here; the snap target merges
 * the top level of the app directory into the snap root, which is exactly
 * where command.sh looks for them.
 *
 * The copy only happens when a snap is among the targets, so the native
 * packages stay clean. A build that produces every format at once
 * (`npm run dist:all`) does include them in each package — three small shell
 * scripts, accepted for the simpler, predictable rule.
 */

const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const { appOutDir, targets } = context;
  const names = (targets || []).map((target) => (typeof target === 'string' ? target : target.name));
  // `targets` missing → be safe and copy; otherwise only when snap is included.
  if (Array.isArray(targets) && !names.includes('snap')) return;

  const source = path.join(__dirname, '..', 'snap-launchers');
  for (const file of fs.readdirSync(source)) {
    if (!file.endsWith('.sh')) continue;
    const destination = path.join(appOutDir, file);
    fs.copyFileSync(path.join(source, file), destination);
    fs.chmodSync(destination, 0o755);
  }

  // Mount point for the gnome-3-28-1804 content plug. snapd creates it when
  // connecting the plug, but an empty directory makes the snap self-describing.
  fs.mkdirSync(path.join(appOutDir, 'gnome-platform'), { recursive: true });
};
