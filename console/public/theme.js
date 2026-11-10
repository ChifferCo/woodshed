// The theme picked on the settings sheet (shell.js), set before the page paints so it never flashes the other one.
// None picked follows the device. The terminals stay dark either way: they are a program's colours.
(function () {
  'use strict';
  try {
    const theme = window.localStorage.getItem('woodshed-cloud-theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  } catch {
    // A private window follows the device.
  }
})();
