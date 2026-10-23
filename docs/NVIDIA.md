# NVIDIA hardware video decoding

Streaming services deliver DRM-protected H.264 (and increasingly HEVC). Decoding it on the
CPU works, but a single 1080p stream can occupy the equivalent of a whole core,
which defeats the point of a dedicated client. Getting the work onto the GPU
needs three things to line up: Chromium has to accept the driver, libva has to
be pointed at NVIDIA's VA-API implementation, and the kernel driver has to
expose a usable render node.

## Why this is not automatic

Chromium's video decode acceleration is written against Mesa. On NVIDIA there is
no Mesa VA-API driver, so a compatibility shim is needed. Two independent pieces
are involved:

| Piece | Purpose | Package |
| --- | --- | --- |
| `nvidia-vaapi-driver` | Implements the VA-API entry points on top of NVDEC | `nvidia-vaapi-driver` |
| `libva` | Loads the driver and hands it to Chromium | `libva2` |

Without the shim, Chromium either fails to initialise VA-API or rejects the
driver through its internal blocklist, and silently falls back to software
decoding.

## Installing the shim

The package name differs per distribution:

| Distribution | Packages |
| --- | --- |
| Debian / Ubuntu | `sudo apt install nvidia-vaapi-driver libva2 vainfo` |
| Fedora | `sudo dnf install nvidia-vaapi-driver libva-utils` |
| Arch | `sudo pacman -S libva-nvidia-driver libva-utils` |
| openSUSE | `sudo zypper install nvidia-vaapi-driver libva-utils` |

The client notes the driver's absence at startup and explains what to install,
so a missing shim never produces a silent downgrade.

## Finding the driver

The shim's location is distribution-dependent, and libva will not find it unless
the directory holding it is on `LIBVA_DRIVERS_PATH`. Rather than hardcoding one
layout, the client derives the multiarch directory from `process.arch` and
searches every layout:

```text
/usr/lib/<multiarch-tuple>/dri                     Debian and Ubuntu
/usr/lib/<multiarch-tuple>/dri/nvidia-vaapi-driver  Flatpak VA-API extension
/usr/lib64/dri                                     Fedora, openSUSE
/usr/lib/dri                                       Arch, Gentoo
/usr/local/lib/dri                                 manual installs
```

The tuple is `x86_64-linux-gnu`, `aarch64-linux-gnu`, `arm-linux-gnueabihf` or
`i386-linux-gnu` depending on `process.arch`, so the same build works on both
supported architectures. An existing `LIBVA_DRIVERS_PATH` is always honoured and
searched first.

## What the client does for you

`src/flags.js` configures the decode path at startup:

- Chromium's internal GPU blocklist is ignored, because the shim never appears
  on NVIDIA's allow list.
- `VaapiVideoDecoder`, `VaapiVideoEncoder`, `VaapiIgnoreDriverChecks` and
  `AcceleratedVideoDecodeLinuxGL` are enabled.
- `LIBVA_DRIVER_NAME=nvidia` and `NVD_BACKEND=direct` are exported so libva
  loads the shim instead of looking for a Mesa driver.
- `LIBVA_DRIVERS_PATH` is published, pointing at the directory the shim was
  actually found in. libva treats this variable as a replacement for its own
  built-in list, so without it the shim is located but never loaded.
- `NVD_DISABLE_DMABUF_FALLBACK_SOFTWARE=0` is set as well. The shim defaults to
  refusing NVIDIA's linear-only buffers, which is what a desktop compositor
  usually hands over; allowing the software fallback for those buffers is the
  difference between a working VA-API surface and `vaInitialize` failing.

## Checking whether it worked

```bash
npm run start:debug
```

The log then reports the resulting feature status:

```text
DEBUG GPU feature status: gpu_compositing=enabled video_decode=enabled rasterization=enabled
```

`video_decode` is the one that matters. If it reads anything other than
`enabled`, hardware decoding is not in use and the client says so explicitly.

`vainfo` is the lower-level check; it should list `VAProfileH264Main` and
friends under the `nvidia` driver.

## Known limitation

Chromium refuses to use NVIDIA's DRM render node for VA-API:

```text
WARNING:media/gpu/vaapi/vaapi_wrapper.cc:130] Should skip nVidia device named: nvidia-drm
```

As a result the compositor can still be software-rendered on some setups even
when the shim is installed. Playback is unaffected and Widevine continues to
work, because decryption is independent of the rendering path. See
[FLATPAK.md](./FLATPAK.md) for the same caveat inside the sandbox.

## Do not disable the GPU process

`--disable-gpu` and `--disable-gpu-compositing` are exposed through
`--disable-hardware-acceleration`. On these drivers the switch makes Chromium
abort with `SIGTRAP` during GPU teardown, so it is applied only when explicitly
requested. A missing shim produces a warning; it never triggers this path
automatically.
