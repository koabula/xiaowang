const { contextBridge, ipcRenderer } = require("electron");

const listeners = (channel, callback) => {
  const wrapped = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld("xiaowang", {
  getState: () => ipcRenderer.invoke("state:get"),
  setActive: (slug) => ipcRenderer.invoke("bot:active", slug),
  createBot: (name, baseline) => ipcRenderer.invoke("bot:create", name, baseline),
  events: (slug) => ipcRenderer.invoke("chat:events", slug),
  library: (slug) => ipcRenderer.invoke("library:list", slug),
  readFile: (slug, id) => ipcRenderer.invoke("library:text", slug, id),
  addFiles: () => ipcRenderer.invoke("library:add"),
  ask: (slug, text) => ipcRenderer.invoke("chat:ask", slug, text),
  stop: () => ipcRenderer.invoke("chat:stop"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  listModels: (patch) => ipcRenderer.invoke("settings:models", patch),
  checkSettings: (patch) => ipcRenderer.invoke("settings:check", patch),
  browserBounds: (bounds) => ipcRenderer.invoke("browser:bounds", bounds),
  browserGo: (url) => ipcRenderer.invoke("browser:go", url),
  browserBack: () => ipcRenderer.invoke("browser:back"),
  browserForward: () => ipcRenderer.invoke("browser:forward"),
  browserHolder: (holder) => ipcRenderer.invoke("browser:holder", holder),
  onState: (callback) => listeners("state", callback),
  onStep: (callback) => listeners("step", callback),
  onStage: (callback) => listeners("stage", callback),
  onBrowser: (callback) => listeners("browser", callback),
  onDownload: (callback) => listeners("download", callback),
});
