const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getShops: () => ipcRenderer.invoke('shops:get'),
  saveShops: (shops) => ipcRenderer.invoke('shops:save', shops),
  getMembers: () => ipcRenderer.invoke('members:get'),
  saveMembers: (members) => ipcRenderer.invoke('members:save', members),
  getAuthConfig: () => ipcRenderer.invoke('auth:get'),
  saveAuthConfig: (cfg) => ipcRenderer.invoke('auth:save', cfg),
  getSavedLogin: () => ipcRenderer.invoke('auth:getSavedLogin'),
  saveSavedLogin: (creds) => ipcRenderer.invoke('auth:saveLogin', creds),
  clearSavedLogin: () => ipcRenderer.invoke('auth:clearSavedLogin'),
  cloudPull: (force) => ipcRenderer.invoke('cloud:pull', Boolean(force)),
  cloudPush: () => ipcRenderer.invoke('cloud:push'),
  cloudReportActive: (data) => ipcRenderer.invoke('cloud:reportActive', data),
  cloudGetActive: () => ipcRenderer.invoke('cloud:getActive'),
  cloudAppendActivity: (event) => ipcRenderer.invoke('cloud:appendActivity', event),
  cloudGetActivity: () => ipcRenderer.invoke('cloud:getActivity'),
  checkOtaUpdate: () => ipcRenderer.invoke('ota:check'),
  applyOtaUpdate: () => ipcRenderer.invoke('ota:apply'),
  restartApp: () => ipcRenderer.invoke('app:restart'),
  wasOtaRestart: () => ipcRenderer.invoke('app:wasOtaRestart'),
  openShop: (id, which, overrideUrl, allowGmvExtension) =>
    ipcRenderer.invoke('shop:open', id, which, overrideUrl, allowGmvExtension === true),
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
