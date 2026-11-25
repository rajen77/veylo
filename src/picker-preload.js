'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Context isolation requires a fixed-channel bridge for the chooser.
contextBridge.exposeInMainWorld('veyloPicker', {
  select: (id, autoOpen) => ipcRenderer.send('picker:select', { id, autoOpen: Boolean(autoOpen) }),
  cancel: () => ipcRenderer.send('picker:cancel'),
  change: (action, id) => ipcRenderer.send('picker:change', { action, id }),
  support: () => ipcRenderer.send('picker:support'),
  onState: (callback) => ipcRenderer.on('picker:state', (_event, state) => callback(state)),
});
