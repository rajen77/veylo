# Veylo
[![veylo](https://snapcraft.io/veylo/badge.svg)](https://snapcraft.io/veylo)
[![veylo](https://snapcraft.io/veylo/trending.svg?name=0)](https://snapcraft.io/veylo)

A lightweight desktop client for streaming services on Linux — Disney+,
Netflix, Max and Apple TV+ — built on
[Electron for Content Security](https://github.com/castlabs/electron-releases)
(castLabs' Electron fork) so that protected playback works through Widevine.

> **Unofficial.** This client is not endorsed by, sponsored by, or connected to
> Disney, Netflix, Warner Bros. Discovery, Apple, or their parent companies.
> "Disney+", "Netflix", "Max" and "Apple TV+" are trademarks of their
> respective owners. The client renders each service's own web player; it does
> not bypass DRM or reverse engineer any streaming service.

## Why a dedicated client

Browsers keep a full multi-process engine, extension machinery, and history
service alive around a single site. This client loads only the streaming
service you pick, which cuts the resident memory and background CPU that a
browser spends on everything else.

## Features

- A startup chooser for the streaming service, a menu entry to switch between
  them, and an option to open the last used one automatically
- Each service keeps its own session, so sign-ins stay separate
- Interface in English, Hungarian and German: it follows the system language,
  and the Language menu overrides it — for the interface and for the browser's
  own language (`Accept-Language`, `navigator.language`), so the services offer
  their content in that language too (see [Translations](#translations))
- Widevine playback through castLabs Electron (`SW_SECURE_DECODE`)
- VA-API hardware video decoding, including the NVIDIA shim path
- MPRIS integration, so media keys and desktop widgets control playback
- Tray icon with a show/hide toggle
- Fullscreen and picture-in-picture
- A built-in title bar with window controls, including a fullscreen button
- Window state is remembered: windowed, maximized or fullscreen, the position
  and size, and which monitor it was on
- Single-instance lock, so a second launch focuses the running window
- Flatpak packaging and an auto-updater

## Supported services

| Service | Presented as | Notes |
| --- | --- | --- |
| Disney+ | Windows Chrome | Rejects Electron/Linux clients and serves them low resolutions |
| Netflix | Linux Chrome | Verifies the user agent's platform against the Widevine CDM's claim; a Windows spoof breaks playback (E100) |
| Max (HBO) | Linux Chrome | Plays on Linux as-is |
| Apple TV+ | Windows Chrome | Refuses to play on a Linux identity; hardware-secure Widevine requests are downgraded to software-secure (see `src/eme.js`) |

Each service keeps its own session partition, so sign-ins never mix. The
per-service platform identity is documented in `src/services.js` and
`src/user-agent.js`.

## Requirements

- Linux, x86_64 or aarch64 — castLabs publishes Electron builds for both
- A desktop session, X11 or Wayland (Chromium selects the backend itself)
- Node.js 20 or newer when building from source
- A Widevine CDM — supplied by the castLabs build and fetched on first run

The services stream DRM-protected content. Expect 720p through the
software-secure L3 path; higher resolutions require a hardware-secure path
that this configuration does not provide.

## Distribution support

The client is not tied to any one distribution. Nothing in the application code
reads a distribution-specific path; the only per-distribution knowledge is where
VA-API drivers live, and that list is discovered at runtime rather than
hardcoded (see [docs/NVIDIA.md](./docs/NVIDIA.md)).

| Way to install | Fedora / openSUSE | Debian / Ubuntu | Arch | Anything else |
| --- | --- | --- | --- | --- |
| Flatpak | yes | yes | yes | yes — the most portable option |
| Snap | yes | yes | yes | yes — what Ubuntu Software installs |
| AppImage | yes | yes | yes | yes — single file, no root |
| Native package | `rpm` | `deb` | `pacman` | `tar.xz` |
| Build from source | yes | yes | yes | yes |

The build produces every format at once:

```bash
npm run dist:all
```

Individual formats have their own scripts — `dist` (AppImage + tar.xz),
`dist:deb`, `dist:rpm`, `dist:pacman`, `dist:snap` — and `npm run flatpak`
builds the Flatpak. Snap specifics live in [docs/SNAP.md](./docs/SNAP.md).

**AppImage carries its own copy of each library**, so it does not depend on the
distribution's package versions. That makes it the most reliable choice on a
distribution the project has not been tested against, and it needs no root.
Flatpak is the better choice when you want stronger isolation and automatic
updates.

Distributions using a musl libc (Alpine) are **not** supported. Electron
requires glibc, which is a limitation of the runtime rather than of this client.

## Known playback bug in the Electron build (error 83)

Disney+ may fail with **error code 83**. Inside the player this is an audio
decoder failure, not a DRM or account problem:

```text
PipelineStatus::DECODER_ERROR_NOT_SUPPORTED: audio decoder initialization
failed with DecoderStatus::Codes::kUnsupportedConfig
```

Disney+ streams Dolby Digital Plus (`ec-3`) audio, but castLabs' Electron ships
a `libffmpeg.so` with no AC-3 or E-AC-3 decoder. The build nevertheless reports
that it *can* play Dolby:

| Capability query | Chrome 155 | castLabs Electron |
| --- | --- | --- |
| `MediaSource.isTypeSupported('audio/mp4; codecs="ec-3"')` | `false` | `true` |
| `audio.canPlayType('audio/mp4; codecs="ec-3"')` | `""` | `"probably"` |

Disney+ trusts those answers, serves `ec-3`, and playback then dies. The client
corrects the reported capabilities so Disney+ selects AAC instead, which the
build can decode. Only codec queries are affected; no media stream is altered
and the DRM path is untouched. See `src/codecs.js`.

## Running from source

```bash
npm install
npm start
```

`npm install` downloads the castLabs Electron build and fetches the Widevine
CDM. Start with diagnostics when something does not work:

```bash
npm run start:debug
```

## Window behaviour

The window is frameless and draws its own title bar, which carries the menu,
fullscreen, minimize, maximize and close buttons. The strip is part of the page
rather than a native title bar, so it cannot cover the service's own header;
the page is asked to leave the strip's height empty instead.

- **Fullscreen** is available from the title bar button, from View ▸ Fullscreen
  in the menu, and with <kbd>F11</kbd> or <kbd>Alt</kbd>+<kbd>Return</kbd>. In
  fullscreen the strip hides itself and reappears when the pointer reaches the
  top edge, so the button that entered fullscreen can also leave it.
- **Dragging** the strip moves the window, and double-clicking it toggles
  maximize. Right-clicking it opens the application menu.
- **Closing** the window quits the client. The tray icon can still show the
  window again while it is running.
- **Window state is remembered** between runs: whether the window was windowed,
  maximized or fullscreen, its position and size, and which monitor it was on.
  The state is written on every change rather than only at exit, so a crash or a
  session logout does not lose it. It is stored in
  `~/.var/app/io.github.veylo.Client/config/veylo/window-state.json`
  under Flatpak, or `~/.config/veylo/window-state.json`
  otherwise. Deleting that file resets the window to its defaults.

## Installing as a Flatpak

```bash
npm run flatpak
flatpak run io.github.veylo.Client
```

No root privileges are needed; the app is installed to the user installation.
See [docs/FLATPAK.md](./docs/FLATPAK.md) for the sandbox decisions that the
manifest encodes.

## Hardware video decoding

Without a VA-API driver, playback is decoded on the CPU. On NVIDIA this needs
the `nvidia-vaapi-driver` shim:

```bash
sudo apt install nvidia-vaapi-driver libva2 vainfo
```

The client detects the shim, wires libva to it, and warns when it is missing.
Details and troubleshooting: [docs/NVIDIA.md](./docs/NVIDIA.md).

Inside Flatpak the equivalent is the VA-API extension:

```bash
flatpak install flathub org.freedesktop.Platform.VAAPI.nvidia
```

## The process sandbox

Chromium's sandbox needs either user namespaces or a setuid `chrome-sandbox`
helper, and a few common setups provide neither:

- Ubuntu 24.04 and later set
  `kernel.apparmor_restrict_unprivileged_userns=1`, which denies namespace
  creation to unconfined processes.
- An unpacked Electron build ships `chrome-sandbox` without the setuid bit, so
  the fallback helper cannot be used either.

When neither route exists, Chromium's zygote cannot start and no window ever
appears. The launcher detects this before starting the binary and reports it:

```text
[launcher] Chromium process sandbox is unavailable (apparmor-userns-restricted); starting without it.
[launcher] To re-enable it: sudo chown root:root /path/to/chrome-sandbox && sudo chmod 4755 /path/to/chrome-sandbox
```

Preferred fix — give the helper the permissions it expects, which preserves the
sandbox:

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Set `VEYLO_FORCE_SANDBOX=1` to require the sandbox and refuse to fall back, or
`VEYLO_DISABLE_SANDBOX=1` to disable it explicitly.

Inside Flatpak the sandboxing story is different and is covered in
[docs/FLATPAK.md](./docs/FLATPAK.md).

## Logs

Diagnostics go to stderr and, when `VEYLO_LOG_FILE` is set, to that file. Inside
Flatpak output is redirected there by default because the sandbox wrapper does
not preserve stdout:

```bash
tail -f ~/.var/app/io.github.veylo.Client/.local/state/veylo/client.log
```

If you start the app from a terminal, Chromium also emits D-Bus messages such as
the following. They come from the bundled Chromium build probing services it
does not find in the sandbox and have no effect on playback:

```text
ERROR:dbus/bus.cc:406] Failed to connect to the bus: Failed to connect to
socket /run/dbus/system_bus_socket: No such file or directory
ERROR:dbus/object_proxy.cc:572] Failed to call method:
org.freedesktop.DBus.Properties.GetAll: object_path= /org/freedesktop/UPower/devices/DisplayDevice
```

To silence them, either redirect stderr or launch through the desktop entry
(`flatpak run io.github.veylo.Client`), which does not attach a
terminal.

## Building installers

```bash
npm run dist:all   # every format: AppImage, deb, rpm, pacman, tar.xz, snap
npm run pack       # unpacked directory
```

## Project layout

```text
src/          application code (main process, plus the preload that draws the title bar)
locales/      interface strings, one JSON file per language
scripts/      launcher, icon generation, packaging hooks, Flatpak build
test/         unit tests (`npm test`, node's built-in test runner)
flatpak/      manifest, desktop entry, metainfo, vendored npm sources
docs/         Flatpak, Snap and NVIDIA notes
```

## Translations

Every user-visible string lives in [`locales/`](./locales), one JSON file per
language, with `en.json` as the base language. The files are picked up
automatically, so adding a language means copying `en.json`, translating the
values and dropping the file back in — no code change. See
[`locales/README.md`](./locales/README.md) for the steps.

## License

MIT — see [LICENSE](./LICENSE), as also declared in `package.json`.
