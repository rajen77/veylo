# Snap packaging

The snap is what Ubuntu Software (the Snap Store) shows and installs on
Ubuntu. It is produced by electron-builder's snap target and packs exactly the
same application as every other format.

## Building

```bash
npm run dist:snap            # → dist/veylo_<version>_amd64.snap
npm run dist:all             # every format at once, snap included
```

No `snapcraft` and no root are required: electron-builder's *template* path
downloads a prebuilt snap template and packs everything with `mksquashfs`.

## The template is unpacked by a hook (and why)

electron-builder v26.15.3 downloads its snap template as a **tar archive** and
passes the archive itself to `mksquashfs` instead of unpacking it. The archive
is where `desktop-init.sh` and its siblings **and** the runtime libraries
(`usr/lib/x86_64-linux-gnu/libnspr4.so`, `libnss3.so`, …) live, yet the
generated `command.sh` executes `$SNAP/desktop-init.sh` and the Electron binary
links against those libraries — so the snap as produced by the builder dies
with `error while loading shared libraries: libnspr4.so`.

`scripts/after-pack.js` therefore downloads the same template the snap target
uses (through the builder's own toolset downloader, so the cache and the
checksum check are shared) and unpacks the tar into the packed application
directory. The snap target merges the top level of that directory into the snap
root, which is exactly where `command.sh` and the dynamic linker look for these
files. The hook only runs when a snap is among the build targets, so the native
packages stay clean.

## Testing locally

```bash
sudo snap install --dangerous dist/veylo_<version>_amd64.snap
veylo
```

`--dangerous` is how an unsigned local package is installed; the store signs
its uploads instead. On the first run the Widevine CDM is downloaded into the
snap's private data directory (`~/snap/veylo/current/.config/veylo`), exactly
like in every other packaging of the client.

## Publishing to the Snap Store

1. Create a store account at <https://snapcraft.io> (email plus the publisher
   agreement).
2. Register the name once: `snapcraft register veylo`. If the name is taken,
   choose another and set it in `package.json` (`name` drives the snap name).
3. Upload: `snapcraft upload --release=stable dist/veylo_<version>_amd64.snap`.
   `snapcraft` itself installs with `sudo snap install snapcraft --classic`.

The first upload of a new name may wait in manual review for a few days.
Afterwards the releases appear in Ubuntu Software.

## Confinement notes

- **MPRIS / media keys**: the snap declares no session-bus slot, so the desktop
  cannot drive playback through MPRIS while the snap runs; the client logs its
  usual warning and everything else works. A future improvement is a `dbus`
  slot for `org.mpris.MediaPlayer2.veylo`.
- **Hardware video decoding**: VA-API drivers live outside the sandbox, so
  decoding can fall back to software. The client logs which path it chose (see
  [NVIDIA.md](./NVIDIA.md)).
- **Widevine**: no CDM ships in the package; the component updater downloads it
  on first launch into the snap's own data directory.
- **Sandbox**: `command.sh` starts Electron with `--no-sandbox` — the snap's
  confinement replaces Chromium's sandbox, the same trade the Flatpak makes
  (see [FLATPAK.md](./FLATPAK.md)).
