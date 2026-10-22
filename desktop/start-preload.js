'use strict';
// Загружается во всех вкладках, но открывает доступ к данным только начальной странице браузера.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:' && /\/ui\/start\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('startPage', {
    topSites: () => ipcRenderer.invoke('start:top-sites'),
    rates: () => ipcRenderer.invoke('start:rates'),
  });
}
