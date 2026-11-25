#!/usr/bin/env bash
# Uses the user installation; no root privileges are required.
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

case "$(uname -m)" in
  x86_64)  ARCH_NOTE="x86_64" ;;
  aarch64) ARCH_NOTE="aarch64" ;;
  *)       ARCH_NOTE="$(uname -m) (no prebuilt Electron for this architecture)" ;;
esac
echo "==> Architecture: $ARCH_NOTE"

# The Flathub Builder app avoids requiring a system package.
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
  # The Builder sandbox otherwise cannot find user-installed SDKs and runtimes.
  BUILD_CMD+=(--env="FLATPAK_USER_DIR=$HOME/.local/share/flatpak")
  BUILD_CMD+=(--command=flatpak-builder org.flatpak.Builder)
fi

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
# Flatpak requires a registered remote rather than a bare repository path.
LOCAL_REMOTE="veylo-local"
flatpak --user remote-add --if-not-exists --no-gpg-verify "$LOCAL_REMOTE" "$(pwd)/$REPO_DIR"
# Refresh a potentially stale remote URL; Flatpak requires the file scheme.
flatpak --user remote-modify --url="file://$(pwd)/$REPO_DIR" "$LOCAL_REMOTE"
if flatpak --user info "$APP_ID" >/dev/null 2>&1; then
  # Install is a no-op for a rebuild with the same version.
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