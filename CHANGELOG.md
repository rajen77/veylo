# Changelog

## 0.9.4

- Added optional Patreon support links to the service chooser and About dialog.
- Report invalid update feeds instead of silently ignoring a missing version.
- Honor explicitly configured libva driver paths when detecting NVIDIA decoding support.
- Fall back to the player's controls when direct playback fails, and log failures when no fallback is available.
- Keep the title bar in sync when its own insertion coincides with other page mutations.
- Reviewed and simplified code comments and added regression tests.

## 0.9.0

- Added favorite services and custom ordering, saved in the service chooser.
- Show all services by default, mark regional restrictions and ask for confirmation before opening an unavailable or unknown-region service. An optional filter hides these services; Veylo does not provide a VPN.
- Keep the chooser and player on the last-used monitor, including after moving the chooser to another display.
- Extended service shortcuts to `Ctrl+Shift+1`…`Ctrl+Shift+9`, then `Ctrl+Shift+A`, `B` and so on, skipping reserved letters.
- Added developer information and links to the About dialog.

## 0.8.0

- Added YouTube, YouTube Music and Plex.
- Extended media controls to audio playback and fixed the YouTube title bar and Plex page layout.

## 0.7.0

- Added Pluto TV and Tubi (both free, ad-supported).
- Regional availability: the chooser, the Service menu and `--service` only offer the services that stream in the country resolved from the client's IP (`VEYLO_REGION` pins it).
- Added Peacock (US only) and Paramount+ (29 countries), both presented as Windows Chrome because their help pages list no Linux browser.

## 0.6.0

- Update checks now default to the GitHub releases feed (`VEYLO_UPDATE_FEED` still overrides it).
- Deny-by-default permission policy: only fullscreen, the EME identifier and clipboard writes are granted.
- Sign-in popups are subject to the same navigation allowlist as the main window.
- `--service=<id>` launches a service directly; a second launch with the flag switches the running instance.
- `Ctrl+1`…`Ctrl+9` switch services; the launch window supports arrow keys and number keys.
- Fixed the Service menu marking the last entry instead of the active service.
- Renamed the SkyShowtime icon (`skyshotime.jpg` → `skyshowtime.jpg`).
- Tests for the services registry, permission policy, launch-window layout and CLI parsing; Dependabot and a tag-triggered release workflow.

## 0.5.0

- Added SkyShowtime and Crunchyroll.
- Provider icons converted from PNG to JPEG to reduce the package size.
- The launch window sizes itself to the number of services.

Earlier releases: see the [GitHub releases](https://github.com/rajen77/veylo/releases).
