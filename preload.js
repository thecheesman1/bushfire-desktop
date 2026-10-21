// The one door between the game page and the app shell (main.js). contextIsolation stays on: the page only gets
// these two calls, nothing else from Node / Electron.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bushfireShell', {
  // FPS UNLOCKER (v1.40.1): vsync + Chromium's frame cap are launch switches, so flipping it restarts the app
  fpsUnlock: () => ipcRenderer.invoke('fps-unlock:get'),
  setFpsUnlock: (on) => ipcRenderer.invoke('fps-unlock:set', !!on),
});
