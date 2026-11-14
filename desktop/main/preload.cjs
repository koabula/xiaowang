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
  renameBot: (slug, name) => ipcRenderer.invoke("bot:rename", slug, name),
  setAvatar: (slug, patch) => ipcRenderer.invoke("bot:avatar", slug, patch),
  forgetFile: (slug, id) => ipcRenderer.invoke("library:forget", slug, id),
  events: (slug) => ipcRenderer.invoke("chat:events", slug),
  library: (slug) => ipcRenderer.invoke("library:list", slug),
  readFile: (slug, id) => ipcRenderer.invoke("library:text", slug, id),
  pages: (slug) => ipcRenderer.invoke("workspace:pages", slug),
  openPage: (slug, path, page) => ipcRenderer.invoke("workspace:openPage", slug, path, page),
  addFiles: () => ipcRenderer.invoke("library:add"),
  ask: (slug, text) => ipcRenderer.invoke("chat:ask", slug, text),
  stop: (slug) => ipcRenderer.invoke("chat:stop", slug),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  listModels: (patch) => ipcRenderer.invoke("settings:models", patch),
  checkSettings: (patch) => ipcRenderer.invoke("settings:check", patch),
  openKeyPage: (service, region) => ipcRenderer.invoke("link:key", service, region),
  browserBounds: (bounds) => ipcRenderer.invoke("browser:bounds", bounds),
  browserGo: (url) => ipcRenderer.invoke("browser:go", url),
  browserBack: () => ipcRenderer.invoke("browser:back"),
  browserForward: () => ipcRenderer.invoke("browser:forward"),
  browserHolder: (holder) => ipcRenderer.invoke("browser:holder", holder),
  callStart: (slug) => ipcRenderer.invoke("call:start", slug),
  callStop: () => ipcRenderer.invoke("call:stop"),
  previewVoice: (patch) => ipcRenderer.invoke("call:preview", patch),
  callAudio: (audio) => ipcRenderer.send("call:audio", audio),
  callIdle: (serial) => ipcRenderer.send("call:idle", serial),
  onState: (callback) => listeners("state", callback),
  onStep: (callback) => listeners("step", callback),
  onTurn: (callback) => listeners("turn", callback),
  onStage: (callback) => listeners("stage", callback),
  onBrowser: (callback) => listeners("browser", callback),
  onDownload: (callback) => listeners("download", callback),
  onCall: (callback) => listeners("call", callback),
});
