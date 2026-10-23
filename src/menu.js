'use strict';

const { app, Menu, clipboard, dialog } = require('electron');
const log = require('./logger');
const { isDebug } = require('./logger');

/**
 * Builds the application menu. On Linux this is the only place accelerators can
 * be registered globally, which is how playback shortcuts work even while the
 * video has focus inside the page.
 */
function buildMenu({
  window,
  media,
  updater,
  flags,
  services = [],
  activeServiceId = '',
  autoOpen = false,
  onSwitchService = () => {},
  onToggleAutoOpen = () => {},
}) {
  const send = (command) => () => media.emit(command);
  const isMac = process.platform === 'darwin';

  const template = [];

  if (isMac) {
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: 'Playback',
    submenu: [
      { label: 'Play / Pause', accelerator: 'Space', click: send('playpause') },
      { label: 'Stop', click: send('stop') },
      { type: 'separator' },
      { label: 'Next Episode', accelerator: 'CommandOrControl+Right', click: send('next') },
      { label: 'Previous Episode', accelerator: 'CommandOrControl+Left', click: send('previous') },
      { type: 'separator' },
      { label: 'Skip Forward 10s', accelerator: 'Right', click: () => media.emit('seek', 10_000_000) },
      { label: 'Skip Back 10s', accelerator: 'Left', click: () => media.emit('seek', -10_000_000) },
      { type: 'separator' },
      { label: 'Volume Up', accelerator: 'Up', click: () => media.adjustVolume(0.05) },
      { label: 'Volume Down', accelerator: 'Down', click: () => media.adjustVolume(-0.05) },
      { label: 'Toggle Mute', accelerator: 'M', click: () => media.toggleMute() },
    ],
  });

  template.push({
    label: 'Streaming Service',
    submenu: [
      ...services.map((service) => ({
        id: `service-${service.id}`,
        label: service.name,
        type: 'radio',
        checked: service.id === activeServiceId,
        click: () => onSwitchService(service.id),
      })),
      { type: 'separator' },
      {
        id: 'service-auto-open',
        label: 'Open Last Service on Startup',
        type: 'checkbox',
        checked: autoOpen,
        click: () => onToggleAutoOpen(),
      },
    ],
  });

  template.push({
    label: 'View',
    submenu: [
      {
        // A checkbox rather than a plain item so the menu shows which mode the
        // window is in; the title bar's fullscreen button is the other way in.
        id: 'view-fullscreen',
        label: 'Fullscreen',
        type: 'checkbox',
        checked: Boolean(window.window && window.window.isFullScreen()),
        accelerator: 'F11',
        click: () => window.toggleFullscreen(),
      },
      {
        // A second accelerator for the same action. F11 is the Linux
        // convention, Alt+Return the media-player one, and neither is claimed
        // by the page's own text fields.
        label: 'Fullscreen (alternate shortcut)',
        visible: false,
        accelerator: 'Alt+Return',
        click: () => window.toggleFullscreen(),
      },
      {
        label: 'Picture-in-Picture',
        accelerator: 'CommandOrControl+Shift+P',
        click: () => media.togglePinned(),
      },
      { type: 'separator' },
      { role: 'reload', accelerator: 'CommandOrControl+R' },
      { role: 'forceReload' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
    ],
  });

  if (isDebug) {
    template.push({ role: 'toggleDevTools' });
  }

  template.push({
    label: 'Help',
    submenu: [
      {
        label: 'Check for Updates…',
        click: () => updater.check({ interactive: true }),
      },
      {
        label: 'Copy Diagnostics',
        click: () => {
          const info = [
            `Veylo ${app.getVersion()}`,
            `Electron ${process.versions.electron}`,
            `Chromium ${process.versions.chrome}`,
            `Node ${process.versions.node}`,
            `Platform ${process.platform} ${process.arch}`,
            `Session ${process.env.XDG_SESSION_TYPE || 'unknown'}`,
            `Desktop ${process.env.XDG_CURRENT_DESKTOP || 'unknown'}`,
            `NVIDIA GPU ${flags.nvidia ? 'yes' : 'no'}`,
            `nvidia-vaapi-driver ${flags.nvidiaVaapi ? 'present' : 'absent'}`,
            `Flatpak ${updater.isFlatpak ? 'yes' : 'no'}`,
          ].join('\n');
          clipboard.writeText(info);
          dialog.showMessageBox(window.window, {
            type: 'info',
            title: 'Diagnostics',
            message: 'Diagnostics copied to the clipboard.',
            detail: info,
            buttons: ['OK'],
          });
        },
      },
      {
        label: 'Troubleshooting Guide',
        click: () => {
          log.info('Opening troubleshooting guide');
          const { shell } = require('electron');
          shell.openExternal('https://github.com/');
        },
      },
      { type: 'separator' },
      {
        label: `About Veylo`,
        click: () => {
          dialog.showMessageBox(window.window, {
            type: 'info',
            title: 'About',
            message: 'Veylo',
            detail:
              `Version ${app.getVersion()}\n\n` +
              'An unofficial, lightweight desktop client for Linux. It displays ' +
              'the official web players of supported streaming services in a ' +
              'dedicated Chromium shell with Widevine support.\n\n' +
              'Not affiliated with, endorsed by, or sponsored by any streaming ' +
              'service or its owner. Disney+ and Netflix are trademarks of their ' +
              'respective owners. A valid subscription to the chosen service is ' +
              'required.',
            buttons: ['OK'],
          });
        },
      },
    ],
  });

  if (!isMac) {
    template.push({
      label: 'File',
      submenu: [{ label: 'Quit', role: 'quit', accelerator: 'CommandOrControl+Q' }],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  // Keeps the checkbox items honest after a service switch, which rebuilds the
  // window rather than the menu.
  for (const service of services) {
    const item = menu.getMenuItemById(`service-${service.id}`);
    if (item) item.checked = service.id === activeServiceId;
  }
  const autoItem = menu.getMenuItemById('service-auto-open');
  if (autoItem) autoItem.checked = autoOpen;
  return menu;
}

module.exports = { buildMenu };
