// The app's own pages' bridge (setup.html, signin.html), and nothing for the console's page: it is loaded into the main
// window, so it exposes these calls only to the app's own file:// pages, and main.mjs checks the sender again.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('woodshedDesktop', {
    connect: (url) => ipcRenderer.invoke('console:connect', String(url)),
    signInInBrowser: () => ipcRenderer.invoke('signin:browser'),
    signInHere: () => ipcRenderer.invoke('signin:here'),
  });
}
