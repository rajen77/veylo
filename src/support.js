'use strict';

const { dialog, shell } = require('electron');
const log = require('./logger');
const { t } = require('./i18n');

async function openSupportPage() {
  try {
    await shell.openExternal('https://www.patreon.com/cw/rajen77');
  } catch (err) {
    log.error('Could not open Patreon page:', err.message);
    dialog.showErrorBox(t('support.title'), t('support.openFailed'));
  }
}

module.exports = { openSupportPage };
