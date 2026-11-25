'use strict';

const { getService } = require('./services');

function serviceFromArgv(argv = []) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    let id = null;
    if (arg.startsWith('--service=')) id = arg.slice('--service='.length);
    else if (arg === '--service') id = argv[i + 1];
    if (id !== null) return getService(String(id).toLowerCase()) || null;
  }
  return null;
}

module.exports = { serviceFromArgv };
