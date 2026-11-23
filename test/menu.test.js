'use strict';

const { it, after } = require('node:test');
const assert = require('node:assert/strict');

let template;
let dialogOptions;
let response = 0;
const opened = [];
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { getVersion: () => '0.8.0' },
    Menu: {
      buildFromTemplate(items) {
        template = items;
        return { getMenuItemById: () => null };
      },
      setApplicationMenu() {},
    },
    clipboard: {},
    dialog: {
      async showMessageBox(_window, options) {
        dialogOptions = options;
        return { response };
      },
    },
    shell: { async openExternal(url) { opened.push(url); } },
  },
};

const playbackPath = require.resolve('../src/playback');
require.cache[playbackPath] = {
  id: playbackPath,
  filename: playbackPath,
  loaded: true,
  exports: { VOLUME_STEP: 0.05 },
};

const i18n = require('../src/i18n');
const { buildMenu } = require('../src/menu');
after(() => i18n.setLanguage('en'));

it('shows localized developer credits and opens the selected About links', async () => {
  const win = { isFullScreen: () => false, isDestroyed: () => false, setMenu() {} };
  for (const [locale, country] of [['en', 'Hungary'], ['hu', 'Magyarország'], ['de', 'Ungarn']]) {
    i18n.setLanguage(locale);
    buildMenu({ window: { window: win }, media: {}, updater: {}, flags: {} });
    const help = template.find((item) => item.label === i18n.t('menu.help.title'));
    const about = help.submenu.find((item) => item.label === i18n.t('menu.help.about'));
    response = 0;
    await about.click();
    assert.match(dialogOptions.detail, /0\.8\.0/);
    assert.ok(dialogOptions.detail.includes('Szabó Kornél'));
    assert.ok(dialogOptions.detail.includes(country));
    assert.ok(dialogOptions.detail.includes('https://github.com/rajen77'));
    assert.ok(dialogOptions.detail.includes('https://github.com/rajen77/veylo'));
    assert.ok(dialogOptions.detail.includes('MIT'));
    assert.equal(dialogOptions.cancelId, 0);
    assert.equal(opened.length, 0);
  }
  const help = template.find((item) => item.label === i18n.t('menu.help.title'));
  const about = help.submenu.find((item) => item.label === i18n.t('menu.help.about'));
  response = 1;
  await about.click();
  response = 2;
  await about.click();
  assert.deepEqual(opened, ['https://github.com/rajen77', 'https://github.com/rajen77/veylo']);
});

it('assigns service shortcuts in menu order without using reserved letter shortcuts', () => {
  const services = Array.from({ length: 34 }, (_, index) => ({ id: `test-${index}`, name: `Service ${index}` }));
  const selected = [];
  const win = { isFullScreen: () => false, isDestroyed: () => false, setMenu() {} };
  buildMenu({
    window: { window: win },
    media: {},
    updater: {},
    flags: {},
    services,
    activeServiceId: services[0].id,
    onSwitchService: (id) => selected.push(id),
  });
  const menu = template.find((item) => item.label === i18n.t('menu.service.title'));
  const items = menu.submenu.filter((item) => item.id?.startsWith('service-test-'));
  assert.deepEqual(items.slice(0, 9).map((item) => item.accelerator),
    Array.from({ length: 9 }, (_, index) => `CommandOrControl+Shift+${index + 1}`));
  assert.deepEqual(items.slice(9, 32).map((item) => item.accelerator),
    [...'ABCDEFGHJKLMNOQSTUVWXYZ'].map((key) => `CommandOrControl+Shift+${key}`));
  assert.equal(items[32].accelerator, undefined);
  assert.equal(items[33].accelerator, undefined);
  items[9].click();
  items[18].click();
  assert.deepEqual(selected, ['test-9', 'test-18']);
});
