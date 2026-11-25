// The app's bridge to its pages. Its own file:// pages (setup.html, signin.html) get their calls; any other page gets the
// notifications list alone, for the console page's bell (console/public/notificationBell.js). main.mjs checks the sender
// again, and answers the list only to the console's own page in the main window.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('woodshedDesktop', {
    connect: (url) => ipcRenderer.invoke('console:connect', String(url)),
    signInInBrowser: () => ipcRenderer.invoke('signin:browser'),
    signInHere: () => ipcRenderer.invoke('signin:here'),
  });
} else {
  contextBridge.exposeInMainWorld('woodshedNotifications', {
    // { items: [{ key, id, kind, title, body, at, read }], unread }, newest first.
    list: () => ipcRenderer.invoke('notifications:list'),
    // One entry by its key, or every one with none.
    markRead: (key) => ipcRenderer.invoke('notifications:read', typeof key === 'string' ? key : null),
    // Called with each notification the app shows in the page rather than the OS's, as it arrives (the app is in front).
    onArrived: (fn) => {
      const listener = (_event, entry) => fn(entry);
      ipcRenderer.on('notifications:arrived', listener);
      return () => ipcRenderer.removeListener('notifications:arrived', listener);
    },
    // Called with the new list each time it changes; returns a function that stops it.
    onChange: (fn) => {
      const listener = (_event, list) => fn(list);
      ipcRenderer.on('notifications:changed', listener);
      return () => ipcRenderer.removeListener('notifications:changed', listener);
    },
  });
}
