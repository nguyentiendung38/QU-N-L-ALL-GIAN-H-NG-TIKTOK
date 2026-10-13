const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getShops: () => ipcRenderer.invoke('shops:get'),
  saveShops: (shops) => ipcRenderer.invoke('shops:save', shops),
  openShop: (id, which) => ipcRenderer.invoke('shop:open', id, which),
  resetProfile: (id) => ipcRenderer.invoke('shop:resetProfile', id),
  getBrowser: () => ipcRenderer.invoke('browser:get'),
  pickBrowser: () => ipcRenderer.invoke('browser:pick')
});
