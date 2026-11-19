// A page of a program embedding the console, shown in the settings frame (server.mjs, settingsFrame): the program
// rendered its part on the server into a template, and this puts it in the settings frame, with the side list and the
// avatar menu as on the console's own settings pages. A tab of Settings is under the title Settings and its tabs; one
// of the program's own entries (its template has a heading) is under that heading and the row of its entry's own pages,
// if it has any. Only this one page is registered here, so a click on another tab, the console's or the program's,
// loads it the ordinary way.
(() => {
  'use strict';
  const W = window.Woodshed;
  const template = document.getElementById('woodshed-host-page');
  if (!template) return;
  const current = template.getAttribute('data-current') || location.pathname;
  const heading = template.getAttribute('data-heading');
  let tabs = [];
  try {
    tabs = JSON.parse(template.getAttribute('data-tabs') || '[]');
  } catch { /* no row */ }
  // The same row as Settings' tabs, of the entry's own pages: links, the page's marked.
  const ownTabs = () => tabs.length > 0 && W.h('nav', { class: 'rail-seg settings-tabs', 'aria-label': heading },
    tabs.map((tab) => W.h('a', { class: 'rail-seg-link', href: tab.href, 'aria-current': tab.href === current ? 'page' : null }, tab.label)));
  W.settingsPage(location.pathname, (app, life) => {
    // Its forms and links are the program's: they post and go where it says, as on any page of its own.
    const body = W.h('div', { class: 'host-page' });
    body.append(template.content.cloneNode(true));
    const head = heading
      ? W.h('div', null, W.h('h1', { class: 'title' }, heading), ownTabs())
      : W.h('div', null, W.h('h1', { class: 'title' }, 'Settings'), W.settingsTabs(current));
    app.replaceChildren(W.h('div', { class: 'page' }, life.nav(current), W.h('header', { class: 'page-head' }, head), body));
  });
})();
