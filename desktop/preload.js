'use strict';
// Мост между панелью браузера и главным процессом: только отправка команд и приём событий.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('browser', {
  send: (command, ...args) => ipcRenderer.send('cmd', command, ...args),
  on: (channel, handler) => ipcRenderer.on(channel, (_event, ...args) => handler(...args)),
});
