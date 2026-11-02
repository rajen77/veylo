# Changelog

## Unreleased

- Added Pluto TV and Tubi (both free, ad-supported; `Ctrl+1`…`Ctrl+9` now covers all nine services).

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
