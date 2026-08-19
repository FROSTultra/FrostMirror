const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  validateSettings: (s) => ipcRenderer.invoke('settings:validate', s),
  setTint: (v) => ipcRenderer.invoke('settings:set-tint', v),
  setLangTarget: (v) => ipcRenderer.invoke('settings:set-lang-target', v),
  setDeepMode: (v) => ipcRenderer.invoke('settings:set-deep-mode', v),
  setClipWatch: (v) => ipcRenderer.invoke('settings:set-clip-watch', v),
  setHotkey: (v) => ipcRenderer.invoke('settings:set-hotkey', v),
  onClipboardChanged: (cb) => ipcRenderer.on('clipboard:changed', (_e, payload) => cb(payload)),
  translate: (p) => ipcRenderer.invoke('translate:run', p),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  setPin: (on) => ipcRenderer.invoke('window:pin', on),
  copyText: (t) => ipcRenderer.invoke('clipboard:write', t),
});
