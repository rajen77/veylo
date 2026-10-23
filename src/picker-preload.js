'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge the startup chooser gets: two fixed actions over fixed
 * channels. The page itself is ours (built in src/picker.js), so unlike the
 * streaming pages this preload is not defending against untrusted code — it
 * exists because the chooser runs with contextIsolation like everything else.
 */
contextBridge.exposeInMainWorld('veyloPicker', {
  select: (id, autoOpen) => ipcRenderer.send('picker:select', { id, autoOpen: Boolean(autoOpen) }),
  cancel: () => ipcRenderer.send('picker:cancel'),
});
