'use strict';

const { app, Menu, clipboard, dialog } = require('electron');
const log = require('./logger');
const { isDebug } = require('./logger');
const { t, available: availableLanguages } = require('./i18n');

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
  languagePref = 'auto',
  onSwitchService = () => {},
  onToggleAutoOpen = () => {},
  onSetLanguage = () => {},
}) {
  const send = (command) => () => media.emit(command);
  const isMac = process.platform === 'darwin';

  const template = [];

  if (isMac) {
    template.push({ role: 'appMenu' });
  }

  template.push({
    label: t('menu.playback.title'),
    submenu: [
      { label: t('menu.playback.playPause'), accelerator: 'Space', click: send('playpause') },
      { label: t('menu.playback.stop'), click: send('stop') },
      { type: 'separator' },
      { label: t('menu.playback.next'), accelerator: 'CommandOrControl+Right', click: send('next') },
      { label: t('menu.playback.previous'), accelerator: 'CommandOrControl+Left', click: send('previous') },
      { type: 'separator' },
      { label: t('menu.playback.forward'), accelerator: 'Right', click: () => media.emit('seek', 10_000_000) },
      { label: t('menu.playback.back'), accelerator: 'Left', click: () => media.emit('seek', -10_000_000) },
      { type: 'separator' },
      { label: t('menu.playback.volumeUp'), accelerator: 'Up', click: () => media.adjustVolume(0.05) },
      { label: t('menu.playback.volumeDown'), accelerator: 'Down', click: () => media.adjustVolume(-0.05) },
      { label: t('menu.playback.mute'), accelerator: 'M', click: () => media.toggleMute() },
    ],
  });

  template.push({
    label: t('menu.service.title'),
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
        label: t('menu.service.autoOpen'),
        type: 'checkbox',
        checked: autoOpen,
        click: () => onToggleAutoOpen(),
      },
    ],
  });

  // One radio per locale file found in locales/, plus the automatic choice
  // that follows the system language. The list comes from the directory, so a
  // new translation shows up here without a code change.
  //
  // No separator between the automatic choice and the languages on purpose:
  // Electron groups radio items up to the next separator, and a group without
  // a checked item gets its first entry checked — which would mark a language
  // as chosen while "Automatic" is the real state. One group keeps exactly one
  // radio filled.
  const languages = availableLanguages();
  const languageListed = languages.some((entry) => entry.code === languagePref);
  template.push({
    label: t('menu.language.title'),
    submenu: [
      {
        id: 'language-auto',
        label: t('menu.language.auto'),
        type: 'radio',
        checked: !languageListed,
        click: () => onSetLanguage('auto'),
      },
      ...languages.map((entry) => ({
        id: `language-${entry.code}`,
        label: entry.name,
        type: 'radio',
        checked: languagePref === entry.code,
        click: () => onSetLanguage(entry.code),
      })),
    ],
  });

  template.push({
    label: t('menu.view.title'),
    submenu: [
      {
        // A checkbox rather than a plain item so the menu shows which mode the
        // window is in; the title bar's fullscreen button is the other way in.
        id: 'view-fullscreen',
        label: t('menu.view.fullscreen'),
        type: 'checkbox',
        checked: Boolean(window.window && window.window.isFullScreen()),
        accelerator: 'F11',
        click: () => window.toggleFullscreen(),
      },
      {
        // A second accelerator for the same action. F11 is the Linux
        // convention, Alt+Return the media-player one, and neither is claimed
        // by the page's own text fields.
        label: t('menu.view.fullscreenAlt'),
        visible: false,
        accelerator: 'Alt+Return',
        click: () => window.toggleFullscreen(),
      },
      {
        label: t('menu.view.pip'),
        accelerator: 'CommandOrControl+Shift+P',
        click: () => media.togglePinned(),
      },
      { type: 'separator' },
      // The roles keep their behaviour but bring their own label: role labels
      // come from Chromium's baked-in strings and are always English.
      { role: 'reload', label: t('menu.view.reload'), accelerator: 'CommandOrControl+R' },
      { role: 'forceReload', label: t('menu.view.forceReload') },
      { type: 'separator' },
      { role: 'resetZoom', label: t('menu.view.actualSize') },
      { role: 'zoomIn', label: t('menu.view.zoomIn') },
      { role: 'zoomOut', label: t('menu.view.zoomOut') },
    ],
  });

  if (isDebug) {
    template.push({ role: 'toggleDevTools', label: t('menu.devTools') });
  }

  template.push({
    label: t('menu.help.title'),
    submenu: [
      {
        label: t('menu.help.checkUpdates'),
        click: () => updater.check({ interactive: true }),
      },
      {
        label: t('menu.help.diagnostics'),
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
            title: t('dialogs.diagnostics.title'),
            message: t('dialogs.diagnostics.message'),
            detail: info,
            buttons: [t('menu.ok')],
          });
        },
      },
      {
        label: t('menu.help.troubleshooting'),
        click: () => {
          log.info('Opening troubleshooting guide');
          const { shell } = require('electron');
          shell.openExternal('https://github.com/');
        },
      },
      { type: 'separator' },
      {
        label: t('menu.help.about'),
        click: () => {
          dialog.showMessageBox(window.window, {
            type: 'info',
            title: t('dialogs.about.title'),
            message: 'Veylo',
            detail: t('dialogs.about.detail', { version: app.getVersion() }),
            buttons: [t('menu.ok')],
          });
        },
      },
    ],
  });

  if (!isMac) {
    template.push({
      label: t('menu.file.title'),
      submenu: [{ label: t('menu.file.quit'), role: 'quit', accelerator: 'CommandOrControl+Q' }],
    });
  }

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  if (isDebug) {
    // Two levels deep: enough to see the whole interface at a glance when
    // checking a translation or a rebuild.
    const labels = template.flatMap((item) => (item.label
      ? [item.label, ...(item.submenu || [])
        .filter((child) => child.label)
        .map((child) => `${item.label} ▸ ${child.label}`)]
      : []));
    log.debug(`Menu (${labels.length} items):`, labels.join(' | '));
  }
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
