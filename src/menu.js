'use strict';

const { app, Menu, clipboard, dialog, shell } = require('electron');
const log = require('./logger');
const { isDebug } = log;
const { VOLUME_STEP } = require('./playback');
const { t, available: availableLanguages } = require('./i18n');
const { openSupportPage } = require('./support');

const DEVELOPER_URL = 'https://github.com/rajen77';
const PROJECT_URL = 'https://github.com/rajen77/veylo';
// I, P and R are reserved for devtools, picture-in-picture and force reload.
const SERVICE_LETTER_KEYS = 'ABCDEFGHJKLMNOQSTUVWXYZ';

// Native menu accelerators work even while the page has focus.
function buildMenu({
  window,
  media,
  updater,
  flags,
  services = [],
  activeServiceId = '',
  autoOpen = false,
  hideUnavailable = false,
  languagePref = 'auto',
  onSwitchService = () => {},
  onToggleAutoOpen = () => {},
  onToggleHideUnavailable = () => {},
  onOpenPicker = () => {},
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
      { label: t('menu.playback.volumeUp'), accelerator: 'Up', click: () => media.adjustVolume(VOLUME_STEP) },
      { label: t('menu.playback.volumeDown'), accelerator: 'Down', click: () => media.adjustVolume(-VOLUME_STEP) },
      { label: t('menu.playback.mute'), accelerator: 'M', click: () => media.toggleMute() },
    ],
  });

  template.push({
    label: t('menu.service.title'),
    submenu: [
      ...(!services.some((service) => service.id === activeServiceId)
        ? [{ type: 'radio', visible: false, checked: true }]
        : []),
      ...services.map((service, index) => ({
        id: `service-${service.id}`,
        label: service.unavailable ? `${service.name} (${t(service.unknownRegion ? 'picker.unknownRegion' : 'picker.unavailable')})` : service.name,
        type: 'radio',
        checked: service.id === activeServiceId,
        ...(index < 9
          ? { accelerator: `CommandOrControl+Shift+${index + 1}` }
          : SERVICE_LETTER_KEYS[index - 9]
            ? { accelerator: `CommandOrControl+Shift+${SERVICE_LETTER_KEYS[index - 9]}` }
            : {}),
        click: () => onSwitchService(service.id),
      })),
      { type: 'separator' },
      { label: t('menu.service.manage'), click: () => onOpenPicker() },
      {
        label: t('picker.hideUnavailable'),
        type: 'checkbox',
        checked: hideUnavailable,
        click: () => onToggleHideUnavailable(),
      },
      {
        id: 'service-auto-open',
        label: t('menu.service.autoOpen'),
        type: 'checkbox',
        checked: autoOpen,
        click: () => onToggleAutoOpen(),
      },
    ],
  });

  // Keep automatic and explicit languages in one Electron radio group.
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
        id: 'view-fullscreen',
        label: t('menu.view.fullscreen'),
        type: 'checkbox',
        checked: Boolean(window.window && window.window.isFullScreen()),
        accelerator: 'F11',
        click: () => window.toggleFullscreen(),
      },
      {
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
      // Override Chromium's English role labels with translations.
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
          shell.openExternal('https://github.com/rajen77/veylo#readme');
        },
      },
      { type: 'separator' },
      {
        label: t('menu.help.about'),
        click: async () => {
          const { response } = await dialog.showMessageBox(window.window, {
            type: 'info',
            title: t('dialogs.about.title'),
            message: 'Veylo',
            detail: `${t('dialogs.about.detail', {
              version: app.getVersion(),
              developer: 'Szabó Kornél',
              profile: DEVELOPER_URL,
              project: PROJECT_URL,
              license: 'MIT',
            })}\n\n${t('support.description')}\n${t('support.optional')}`,
            buttons: [t('menu.ok'), t('dialogs.about.developerProfile'), t('dialogs.about.projectPage'), t('support.button')],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (response === 3) {
            await openSupportPage();
            return;
          }
          const url = [null, DEVELOPER_URL, PROJECT_URL][response];
          if (url) {
            try {
              await shell.openExternal(url);
            } catch (err) {
              log.error('Could not open About link:', err.message);
            }
          }
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
  // A window created before this menu may keep the previous one on Linux;
  // set it explicitly so the radio state matches the active service.
  if (window && window.window && !window.window.isDestroyed()) window.window.setMenu(menu);
  if (isDebug) {
    const labels = template.flatMap((item) => (item.label
      ? [item.label, ...(item.submenu || [])
        .filter((child) => child.label)
        .map((child) => `${item.label} ▸ ${child.label}`)]
      : []));
    log.debug(`Menu (${labels.length} items):`, labels.join(' | '));
  }
  const autoItem = menu.getMenuItemById('service-auto-open');
  if (autoItem) autoItem.checked = autoOpen;
  return menu;
}

module.exports = { buildMenu };
