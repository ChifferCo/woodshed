// A page of a program embedding the console, shown as one of Settings' tabs (server.mjs, settingsFrame): the program
// rendered its part on the server into a template, and this puts it in the settings frame, under the title Settings
// and its tabs, with the side list and the avatar menu as on the console's own settings pages. Only this one page is
// registered here, so a click on another tab, the console's or the program's, loads it the ordinary way.
(() => {
  'use strict';
  const W = window.Woodshed;
  const template = document.getElementById('woodshed-host-page');
  if (!template) return;
  const current = template.getAttribute('data-current') || location.pathname;
  W.settingsPage(location.pathname, (app, life) => {
    // Its forms and links are the program's: they post and go where it says, as on any page of its own.
    const body = W.h('div', { class: 'host-page' });
    body.append(template.content.cloneNode(true));
    app.replaceChildren(W.h('div', { class: 'page' }, life.nav(current),
      W.h('header', { class: 'page-head' }, W.h('div', null, W.h('h1', { class: 'title' }, 'Settings'), W.settingsTabs(current))),
      body));
  });
})();
