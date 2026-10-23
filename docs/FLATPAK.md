# Flatpak packaging

The client ships as a Flatpak so it can be installed without root and so its
Widevine Content Decryption Module runs inside a predictable environment. This
document records the non-obvious decisions in the manifest; they are all
consequences of how zypak and the Electron2 BaseApp interact with the castLabs
Electron build.

## Building

```bash
npm run flatpak
```

No root privileges are required. The script installs `org.flatpak.Builder` into
the user installation if `flatpak-builder` is not available on the host, then
builds and installs the app to the user installation.

Build and repository directories are project-relative on purpose. Inside the
Builder sandbox `/tmp` is private to the sandbox, so a build that writes there
cannot be exported.

## Architectures

The manifest lists one Electron archive per architecture and lets Flatpak select
between them with `only-arches`, so the same file builds on `x86_64` and
`aarch64` with no edits. castLabs publishes both:

```text
electron-v44.5.1+wvcus-linux-x64.zip    only-arches: [x86_64]
electron-v44.5.1+wvcus-linux-arm64.zip  only-arches: [aarch64]
```

Every dependency is available for aarch64 as well: `org.freedesktop.Platform`,
`org.freedesktop.Sdk`, `org.electronjs.Electron2.BaseApp`,
`org.freedesktop.Sdk.Extension.node24` and
`org.freedesktop.Platform.VAAPI.nvidia` all publish `26.08` branches for it.

Flatpak builds natively, so an aarch64 package is produced on an aarch64 host.
Cross-building is possible with `--arch=aarch64` plus QEMU binfmt
registration, but it is slow and not part of the normal workflow.

## zypak: the spawn strategy deadlocks

Flatpak does not allow Chromium's own sandbox to create user namespaces, so the
Electron2 BaseApp replaces it with zypak, which forwards namespace setup to
`flatpak-spawn`.

zypak has two zygote strategies and picks one at startup:

- **spawn** — used when the Flatpak portal advertises `expose-pids`.
- **mimic** — the fallback.

With this Electron build the spawn strategy never completes. `zypak-sandbox`
starts, negotiates its file descriptors, and then `zypak-helper` blocks forever:

```text
[zypak-helper] Waiting for chroot request
```

No JavaScript runs at all and no window appears. The same hangs also left the
renderer children as zombies. Running the binary with `ELECTRON_RUN_AS_NODE=1`
under zypak works, so the environment and file descriptors are fine; only the
zygote handshake is broken.

`run.sh` therefore pins the working strategy:

```sh
export ZYPAK_ZYGOTE_STRATEGY_SPAWN=0
```

Measured inside the sandbox, with the app log line count as the signal:

| Configuration | Result |
| --- | --- |
| spawn strategy (default) | hangs before any JavaScript; 0 log lines |
| mimic strategy | starts normally |
| mimic + `--no-sandbox` | starts, Widevine available, but the renderer sandbox is gone |
| mimic + `--disable-gpu-sandbox` | starts normally, renderer sandbox kept |

## Why `--disable-gpu-sandbox`

With the mimic strategy the renderer starts, but every GPU process launch failed:

```text
ERROR:content/browser/gpu/gpu_process_host.cc:1029] GPU process launch failed: error_code=1002
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
```

zypak is asked to set up the sandbox for the GPU process too, and that fails
underneath bubblewrap. Chromium treats an unusable GPU process as fatal and
aborts, which is the `exit=133` seen in the table above.

Passing `--disable-gpu-sandbox` is the smallest change that works. It affects
only the GPU process; the renderer stays sandboxed through zypak, so Widevine's
software-secure path and the L3 robustness level are unaffected. The validated
configuration is recorded in `run.sh`.

Verified inside the sandbox with the resulting build:

- Widevine CDM `4.10.3112.0`
- `requestMediaKeySystemAccess('com.widevine.alpha', …)` resolves with
  `SW_SECURE_DECODE`
- A real Widevine-protected stream plays: 299 frames decoded, ~12 s of
  playback, 0 dropped frames
- MPRIS registered, tray icon created, the selected service loads

Note that `--no-sandbox` is *not* used. Disabling the whole Chromium sandbox
would remove the renderer isolation that Widevine relies on.

## Build dependencies

`org.freedesktop.Sdk.Extension.node24` is pulled in as an SDK extension so the
Node modules can be compiled during the build. npm runs with `--ignore-scripts`
against the vendored `flatpak/node-sources.json`, which contains the full
dependency closure for offline builds.

`flatpak/node-sources.json` must be regenerated with the current
`flatpak-node-generator` from `flatpak-builder-tools`. The published PyPI
release is stale and emits an incomplete file; install the generator from git:

```bash
python -m venv .venv
.venv/bin/pip install "git+https://github.com/flatpak/flatpak-builder-tools.git#subdirectory=node"
```

## Known limitation

As on the host, Chromium will not use NVIDIA's DRM render node for VA-API:

```text
WARNING:media/gpu/vaapi/vaapi_wrapper.cc:130] Should skip nVidia device named: nvidia-drm
```

So the client may still composite in software even though the VA-API extension
is installed. Decoding and Widevine are unaffected. Installing
`org.freedesktop.Platform.VAAPI.nvidia` is still worthwhile, since the shim is
what makes the decode path available at all:

```bash
flatpak install flathub org.freedesktop.Platform.VAAPI.nvidia
```
