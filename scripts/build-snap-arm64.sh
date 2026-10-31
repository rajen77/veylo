#!/usr/bin/env bash
#
# Builds dist/snap/veylo_<version>_arm64.snap — the arm64 package of the local
# multi-arch snap batch, for manual upload to the Snap Store.
#
# Why this exists: electron-builder's snap target packs from a prebuilt
# template that only exists for amd64 (and armhf); for arm64 it shells out to
# `snapcraft`, which needs a build provider (LXD/multipass) that is not
# available here. So this script does what electron-builder would do, by hand:
#
#   1. download castLabs Electron for linux-arm64 (postinstall only fetches
#      the host architecture),
#   2. pack the application with `electron-builder --dir --arm64`,
#   3. seed every arch-independent file (launcher scripts, desktop entry,
#      icon, snap.yaml) byte-for-byte from the amd64 snap, so the arm64
#      package can only differ in architecture and library triplet,
#   4. fill the template's runtime libraries with their Ubuntu 20.04 (focal —
#      the same release as the snap's core20 base) arm64 builds from
#      ports.ubuntu.com, laid out exactly like the x64 template does,
#   5. pack with the same mksquashfs flags electron-builder uses.
#
# castLabs Electron ships only linux-x64 and linux-arm64 binaries, so arm64 is
# the only architecture besides amd64 that can carry Widevine at all — see the
# architecture table in docs/SNAP.md.
#
# Requires: curl, unzip, dpkg-deb, mksquashfs, unsquashfs (squashfs-tools),
# node. No root, no snapcraft, no build provider.

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
SEED="dist/veylo_${VERSION}_amd64.snap"
OUT="dist/snap/veylo_${VERSION}_arm64.snap"
WORK="dist/snap-build"

if [ ! -f "$SEED" ]; then
  echo "error: $SEED not found — build the amd64 snap first: npm run dist:snap" >&2
  exit 1
fi

# castLabs Electron reference, e.g. https://github.com/castlabs/electron-releases#v44.5.1+wvcus
REF=$(node -p "require('./package.json').devDependencies.electron")
TAG="${REF#*#}" # v44.5.1+wvcus
TAG_ENC=${TAG/+/%2B} # '+' is not allowed unescaped in the release asset path

mkdir -p "$WORK" dist/snap
# dist/snap/ is the upload batch: both architectures in one directory
cp -f "$SEED" "dist/snap/veylo_${VERSION}_amd64.snap"

# --- 1. castLabs Electron for linux-arm64 ----------------------------------
if [ ! -f "$WORK/electron-${TAG}-linux-arm64.zip" ]; then
  echo ">> downloading castLabs Electron ${TAG} (linux-arm64)"
  curl -fL --retry 3 -o "$WORK/electron-${TAG}-linux-arm64.zip" \
    "https://github.com/castlabs/electron-releases/releases/download/${TAG_ENC}/electron-${TAG}-linux-arm64.zip"
fi
EDIST="$WORK/electron-arm64"
if [ ! -d "$EDIST/locales" ]; then
  echo ">> unpacking Electron dist"
  rm -rf "$EDIST"
  mkdir -p "$EDIST"
  unzip -q "$WORK/electron-${TAG}-linux-arm64.zip" -d "$EDIST"
fi

# --- 2. pack the application for arm64 --------------------------------------
echo ">> packing application (electron-builder --dir --arm64)"
rm -rf dist/linux-arm64-unpacked
npx electron-builder --linux dir --arm64 --publish never \
  -c.electronDist="$EDIST" -c.npmRebuild=false
APP=dist/linux-arm64-unpacked
if [ ! -x "$APP/veylo" ]; then
  echo "error: $APP/veylo missing after pack" >&2
  exit 1
fi

# --- 3. runtime libraries ---------------------------------------------------
# The amd64 template tar ships only x86_64 libraries, so the arm64
# equivalents come from Ubuntu focal (20.04), pinned per release.
PORTS=http://ports.ubuntu.com/ubuntu-ports
DEBS=(
  pool/main/libb/libbsd/libbsd0_0.10.0-1_arm64.deb
  pool/main/e/e2fsprogs/libcom-err2_1.45.5-2ubuntu1_arm64.deb
  pool/main/d/dbus/libdbus-1-3_1.12.16-2ubuntu2_arm64.deb
  pool/main/e/expat/libexpat1_2.2.9-1build1_arm64.deb
  pool/main/k/keyutils/libkeyutils1_1.6-6ubuntu1_arm64.deb
  pool/main/libx/libxss/libxss1_1.2.3-1_arm64.deb
  pool/main/liba/libappindicator/libappindicator3-1_12.10.1+20.04.20200408.1-0ubuntu1_arm64.deb
  pool/main/libd/libdbusmenu/libdbusmenu-glib4_16.04.1+18.10.20180917-0ubuntu6_arm64.deb
  pool/main/libd/libdbusmenu/libdbusmenu-gtk3-4_16.04.1+18.10.20180917-0ubuntu6_arm64.deb
  pool/universe/libi/libindicator/libindicator3-7_16.10.0+18.04.20180321.1-0ubuntu4_arm64.deb
  pool/main/n/nspr/libnspr4_4.25-1_arm64.deb
  pool/main/n/nss/libnss3_3.49.1-1ubuntu1_arm64.deb
)
DEBROOT="$WORK/debs/x"
if [ ! -f "$WORK/debs/.extracted" ]; then
  echo ">> fetching arm64 runtime libraries (Ubuntu focal)"
  mkdir -p "$WORK/debs"
  for f in "${DEBS[@]}"; do
    b="$WORK/debs/$(basename "$f")"
    [ -f "$b" ] || curl -fL --retry 3 -o "$b" "$PORTS/$f"
    dpkg-deb -x "$b" "$DEBROOT"
  done
  touch "$WORK/debs/.extracted"
fi

# --- 4. assemble the snap root ----------------------------------------------
echo ">> assembling snap root"
STAGE="$WORK/root"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# application files
cp -a "$APP/." "$STAGE/"
# not shipped in snaps: the Chromium setuid sandbox (snap confinement replaces
# it) and the flattened license texts electron-builder drops as well
rm -f "$STAGE/chrome-sandbox" "$STAGE/LICENSES.chromium.html" "$STAGE/LICENSE.electron.txt"
# abstract-socket only ships an x86_64 binary and has no arm64 build in the
# dependency tree; it is loaded exclusively for `unix:abstract=` D-Bus
# addresses, which the strictly confined snap cannot use anyway (no dbus
# plug — see "Confinement notes" in docs/SNAP.md), so it is dropped rather
# than shipped with a wrong-architecture ELF.
rm -f "$STAGE/resources/app.asar.unpacked/node_modules/abstract-socket/build/Release/bindings.node"

# arch-independent files, byte-identical to the amd64 snap
unsquashfs -quiet -f -d "$STAGE" "$SEED" \
  command.sh desktop-init.sh desktop-common.sh desktop-gnome-specific.sh \
  data-dir gnome-platform meta >/dev/null
sed -i \
  -e 's/x86_64-linux-gnu/aarch64-linux-gnu/g' \
  -e 's/^  - amd64$/  - arm64/' \
  "$STAGE/meta/snap.yaml"

# runtime libraries, mirroring the x64 template layout (lib/ vs usr/lib)
X="$DEBROOT"
mkdir -p "$STAGE/lib/aarch64-linux-gnu" "$STAGE/usr/lib/aarch64-linux-gnu"
cp -a \
  "$X"/lib/aarch64-linux-gnu/libdbus-1.so.3* \
  "$X"/lib/aarch64-linux-gnu/libexpat.so.1* \
  "$X"/lib/aarch64-linux-gnu/libkeyutils.so.1* \
  "$X"/lib/aarch64-linux-gnu/libcom_err.so.2* \
  "$X"/usr/lib/aarch64-linux-gnu/libbsd.so.0* \
  "$STAGE/lib/aarch64-linux-gnu/"
cp -a \
  "$X"/usr/lib/aarch64-linux-gnu/libXss.so* \
  "$X"/usr/lib/aarch64-linux-gnu/libappindicator3.so* \
  "$X"/usr/lib/aarch64-linux-gnu/libdbusmenu-glib.so* \
  "$X"/usr/lib/aarch64-linux-gnu/libdbusmenu-gtk3.so* \
  "$X"/usr/lib/aarch64-linux-gnu/libindicator3.so* \
  "$X"/usr/lib/aarch64-linux-gnu/libfreebl3.so \
  "$X"/usr/lib/aarch64-linux-gnu/libfreeblpriv3.so \
  "$X"/usr/lib/aarch64-linux-gnu/libnspr4.so \
  "$X"/usr/lib/aarch64-linux-gnu/libnss3.so \
  "$X"/usr/lib/aarch64-linux-gnu/libnssutil3.so \
  "$X"/usr/lib/aarch64-linux-gnu/libplc4.so \
  "$X"/usr/lib/aarch64-linux-gnu/libplds4.so \
  "$X"/usr/lib/aarch64-linux-gnu/libsmime3.so \
  "$X"/usr/lib/aarch64-linux-gnu/libssl3.so \
  "$STAGE/usr/lib/aarch64-linux-gnu/"
cp -a "$X/usr/lib/aarch64-linux-gnu/nss" "$STAGE/usr/lib/aarch64-linux-gnu/"

chmod -R g-s "$STAGE" # no setgid bits in the image (same as electron-builder)

# --- 5. pack ----------------------------------------------------------------
echo ">> packing $OUT (mksquashfs, xz)"
mksquashfs "$STAGE" "$OUT" -no-progress -quiet -noappend \
  -comp xz -no-xattrs -no-fragments -all-root

# --- 6. verify --------------------------------------------------------------
echo ">> verifying"
rm -rf "$WORK/check"
mkdir -p "$WORK/check"
unsquashfs -quiet -f -d "$WORK/check" "$OUT" veylo meta/snap.yaml >/dev/null
file -b "$WORK/check/veylo" | grep -q "aarch64" || {
  echo "error: veylo inside the snap is not aarch64" >&2
  exit 1
}
grep -q "  - arm64" "$WORK/check/meta/snap.yaml" || {
  echo "error: snap.yaml does not declare arm64" >&2
  exit 1
}
if unsquashfs -ll "$OUT" | grep -v "root/root" | grep -q .; then
  echo "error: image contains non-root owned entries" >&2
  exit 1
fi
rm -rf "$WORK/check"

echo ">> done: $OUT"
ls -la dist/snap/
echo ">> upload with: snapcraft upload --release=stable $OUT"
