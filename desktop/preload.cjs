// The setup page's bridge, and nothing for the console's page: it is loaded into the main window, so it exposes the
// one call only to the app's own file:// page.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('woodshedDesktop', {
    connect: (url) => ipcRenderer.invoke('console:connect', String(url)),
  });
}
