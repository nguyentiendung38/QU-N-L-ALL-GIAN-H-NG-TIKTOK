const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getShops: () => ipcRenderer.invoke('shops:get'),
  saveShops: (shops) => ipcRenderer.invoke('shops:save', shops),
  getMembers: () => ipcRenderer.invoke('members:get'),
  saveMembers: (members) => ipcRenderer.invoke('members:save', members),
  openShop: (id, which) => ipcRenderer.invoke('shop:open', id, which),
  closeShop: (id) => ipcRenderer.invoke('shop:close', id),
  closeAllShops: () => ipcRenderer.invoke('shops:closeAll'),
  getRunningShops: () => ipcRenderer.invoke('shops:running'),
  checkProxy: (proxyStr) => ipcRenderer.invoke('proxy:check', proxyStr),
  exportShops: () => ipcRenderer.invoke('shops:export'),
  exportMemberShops: (payload) => ipcRenderer.invoke('shops:exportMember', payload),
  importShops: () => ipcRenderer.invoke('shops:import'),
  resetProfile: (id) => ipcRenderer.invoke('shop:resetProfile', id),
  getBrowser: () => ipcRenderer.invoke('browser:get'),
  pickBrowser: () => ipcRenderer.invoke('browser:pick'),
  onRunningChanged: (cb) => {
    ipcRenderer.on('shops:runningChanged', (_e, runningIds) => cb(runningIds));
  }
});
