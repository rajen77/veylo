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

## Architectures

| Architecture | Package | How |
| --- | --- | --- |
| amd64 | `dist/veylo_<version>_amd64.snap` | `npm run dist:snap` |
| arm64 | `dist/snap/veylo_<version>_arm64.snap` | `scripts/build-snap-arm64.sh` |
| armhf, riscv64, ppc64el, s390x | — | not possible, see below |

The remaining architectures cannot be built *at all*:

- **castLabs Electron** — the Widevine build this client is based on — ships
  only `linux-x64` and `linux-arm64` binaries. `scripts/postinstall.js`
  downloads the platform binary without a fallback, so `npm ci` fails outright
  on every other architecture; and stock Electron, which does ship some of
  them, has no Widevine, so DRM playback would not work anyway.
- The `gnome-3-28-1804` content snap the package plugs for its GTK runtime is
  published for `amd64`, `arm64`, `armhf` and `i386` only, so `riscv64`,
  `ppc64el` and `s390x` would have no runtime to run against even if the
  application could be built.

## Building the arm64 snap locally

electron-builder packs from its prebuilt template only for `amd64` (and
`armhf`); for `arm64` it shells out to `snapcraft`, which needs a build
provider (LXD or multipass). The script instead does the same job with plain
`mksquashfs` — no root, no snapcraft, no build provider:

```bash
npm run dist:snap            # amd64 first: it seeds every arch-independent file
scripts/build-snap-arm64.sh
# → dist/snap/veylo_<version>_arm64.snap  (and dist/snap/…_amd64.snap copied alongside)
```

The script downloads the castLabs `linux-arm64` Electron (postinstall only
fetches the host architecture), packs the app with
`electron-builder --dir --arm64`, copies the launcher scripts, desktop entry,
icon and `snap.yaml` byte-for-byte from the amd64 snap — changing only
`architectures` and the library triplet (`x86_64-linux-gnu` →
`aarch64-linux-gnu`) — fills the template's runtime libraries with their
Ubuntu 20.04 arm64 builds from `ports.ubuntu.com` (focal, the same release as
the `core20` base), and packs with electron-builder's exact `mksquashfs`
flags. It verifies the result (aarch64 binary, `arm64` declared, root-owned
image) before printing the upload command.

One module is intentionally dropped: `abstract-socket` ships an x86_64 binary
and has no arm64 build in the dependency tree. It is loaded exclusively for
`unix:abstract=` D-Bus addresses, which the strictly confined snap cannot use
anyway (no `dbus` plug — see the confinement notes below).

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
   For each additional architecture, upload its package the same way —
   `dist/snap/` holds the complete upload batch (`veylo_<version>_amd64.snap`
   and `veylo_<version>_arm64.snap`).

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
