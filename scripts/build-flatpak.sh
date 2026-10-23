#!/usr/bin/env bash
# Builds and installs the Flatpak package.
#
# No root privileges are required: the manifest targets a user installation.
# The only prerequisite is flatpak itself plus the Flathub remote.
set -euo pipefail

MANIFEST="flatpak/io.github.veylo.Client.yml"
BUILD_DIR="flatpak/build"
REPO_DIR="flatpak/repo"
APP_ID="io.github.veylo.Client"
REMOTE="flathub"

cd "$(dirname "$0")/.."

if ! command -v flatpak >/dev/null 2>&1; then
  echo "error: flatpak is not installed." >&2
  echo "       Debian/Ubuntu:  sudo apt install flatpak" >&2
  echo "       Fedora:         sudo dnf install flatpak" >&2
  echo "       Arch:           sudo pacman -S flatpak" >&2
  echo "       openSUSE:       sudo zypper install flatpak" >&2
  exit 1
fi

# The manifest selects the Electron archive per architecture, so a build on
# aarch64 works without editing it. Report which one is in use.
case "$(uname -m)" in
  x86_64)  ARCH_NOTE="x86_64" ;;
  aarch64) ARCH_NOTE="aarch64" ;;
  *)       ARCH_NOTE="$(uname -m) (no prebuilt Electron for this architecture)" ;;
esac
echo "==> Architecture: $ARCH_NOTE"

# flatpak-builder is shipped inside the org.flatpak.Builder Flathub app, which
# can be installed per-user, so no system package is needed.
if flatpak info --user org.flatpak.Builder >/dev/null 2>&1; then
  RUNNER=(flatpak run --user)
elif command -v flatpak-builder >/dev/null 2>&1; then
  RUNNER=()
else
  echo "Installing flatpak-builder (per-user, no root required)..."
  flatpak install --user -y "$REMOTE" org.flatpak.Builder
  RUNNER=(flatpak run --user)
fi

BUILD_CMD=("${RUNNER[@]}")
if [ "${#RUNNER[@]}" -gt 0 ]; then
  # Inside the Builder sandbox XDG_DATA_HOME is redirected to the app's own
  # private data directory, so the SDK and runtime that were installed for the
  # user are not found and flatpak-builder aborts with
  # "org.freedesktop.Sdk/<arch>/26.08 not installed". Pointing FLATPAK_USER_DIR
  # at the real location makes the lookup succeed.
  BUILD_CMD+=(--env="FLATPAK_USER_DIR=$HOME/.local/share/flatpak")
  BUILD_CMD+=(--command=flatpak-builder org.flatpak.Builder)
fi

# The build runs from the Flatpak sandbox, so it needs read access to this
# checkout and to the Flathub remote. --filesystem is granted through the
# Builder app's own permissions, which already include the working directory.
echo "==> Refreshing vendored Node sources"
if command -v flatpak-node-generator >/dev/null 2>&1; then
  flatpak-node-generator npm package-lock.json --no-devel -o flatpak/node-sources.json
elif [ -x .venv/bin/flatpak-node-generator ]; then
  .venv/bin/flatpak-node-generator npm package-lock.json --no-devel -o flatpak/node-sources.json
else
  echo "    flatpak-node-generator not found, keeping the existing flatpak/node-sources.json"
  echo "    (regenerate it only when package-lock.json changes)"
fi

echo "==> Building $APP_ID"
"${BUILD_CMD[@]}" \
  --user \
  --force-clean \
  --disable-rofiles-fuse \
  --repo="$REPO_DIR" \
  --state-dir="flatpak/.flatpak-builder" \
  "$BUILD_DIR" \
  "$MANIFEST"

echo "==> Installing $APP_ID"
# A local repository has to be registered as a remote first; flatpak rejects a
# bare path as a remote name ("Names must contain at least 2 periods").
LOCAL_REMOTE="veylo-local"
flatpak --user remote-add --if-not-exists --no-gpg-verify "$LOCAL_REMOTE" "$(pwd)/$REPO_DIR"
# --if-not-exists keeps an existing remote untouched, so a stale URL (e.g. from
# a checkout that moved or another project reusing the name) would survive and
# the install would fail with "server has no summary file". Always sync the URL.
# The scheme is required: a bare path makes flatpak reject the remote with
# "URL using bad/illegal format or missing URL".
flatpak --user remote-modify --url="file://$(pwd)/$REPO_DIR" "$LOCAL_REMOTE"
if flatpak --user info "$APP_ID" >/dev/null 2>&1; then
  # A rebuild keeps the same version string, so a plain install would be a
  # no-op and leave the previous build in place. Update pulls the new commit.
  flatpak --user update -y --noninteractive "$APP_ID"
else
  flatpak --user install -y --noninteractive "$LOCAL_REMOTE" "$APP_ID"
fi

echo
echo "Done. Start it with:"
echo "  flatpak run $APP_ID"
echo
echo "For hardware video decoding on NVIDIA, install the VA-API extension:"
echo "  flatpak install $REMOTE org.freedesktop.Platform.VAAPI.nvidia"