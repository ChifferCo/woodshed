// The sign-in page. GitHub does the signing in (/auth/start); this page says why it is needed, and
// what went wrong when a sign-in was refused (?error=). ?next= is where to go afterwards.
(function () {
  'use strict';
  const W = window.Woodshed;
  const { h } = W;
  const params = new URLSearchParams(window.location.search);
  const next = sameOriginPath(params.get('next'));

  // Resolved the way the browser would, so another origin comes back as `/`. Resolving can still leave
  // `//host` (from `/.//host`), which the browser would follow to that host, so leading slashes collapse to one.
  function sameOriginPath(value) {
    try {
      const url = new URL(value || '/', window.location.origin);
      if (url.origin !== window.location.origin) return '/';
      return `/${url.pathname.replace(/^[/\\]+/, '')}${url.search}${url.hash}`;
    } catch {
      return '/';
    }
  }
  const error = params.get('error');

  // The repo is named only to a browser /api/me tells it to, which is not a signed-out one once sign-in is
  // required: the repo may be private.
  function signInWho(repo) {
    const where = repo ? ['write access to ', h('b', null, repo)] : ['write access to the repository it works on'];
    return ['Claude sessions for the team. Anyone on its list, with ', ...where, ', can sign in.'];
  }

  function card(...children) {
    document.getElementById('app').replaceChildren(h('div', { class: 'login-page' }, h('section', { class: 'login-card' },
      h('h1', { class: 'title' }, 'Woodshed Cloud'), ...children)));
  }

  // Signed in with write access, but not on the console's list: ask to join, then wait here to be let in.
  function visitorCard(me) {
    const signOut = h('form', { method: 'post', action: '/auth/sign-out', class: 'inline-form' },
      h('button', { type: 'submit', class: 'btn-link' }, 'Sign out'));
    async function send(path, button) {
      button.disabled = true;
      try {
        const answer = await W.postJson(path, {});
        if (answer.member) return window.location.replace(next);
        visitorCard({ ...me, asked: answer.asked });
      } catch (err) {
        button.disabled = false;
        window.alert(`Not sent: ${err.message}`);
      }
    }
    if (!me.asked) {
      const ask = h('button', { type: 'button', class: 'btn btn-open login-btn', onclick: (e) => send('/api/access/ask', e.currentTarget) }, 'Ask to join');
      card(h('p', { class: 'sub' }, 'Signed in with GitHub as ', h('b', null, `@${me.visitor}`), ', but you are not on Woodshed Cloud\'s list yet.'),
        ask, h('p', { class: 'foot' }, 'Anyone on the list can let you in. ', signOut));
      return;
    }
    const takeBack = h('button', { type: 'button', class: 'btn-link', onclick: (e) => send('/api/access/withdraw', e.currentTarget) }, 'Take back the request');
    card(h('h2', { class: 'login-sub' }, 'Asked to join'),
      h('p', { class: 'sub' }, 'Someone on the list will see your request on their People page. This page lets you in as soon as they accept.'),
      h('p', { class: 'msg-plain' }, `Waiting · asked ${W.ago(me.asked)}`),
      h('p', { class: 'foot' }, takeBack, ' · ', signOut));
    if (!polling) polling = setTimeout(poll, 10_000);
  }

  let polling = null;
  function poll() {
    polling = null;
    W.getJson('/api/me').then((me) => {
      if (me.login) window.location.replace(next);
      else if (me.visitor) visitorCard(me);
      // Signed out meanwhile, or the session ended: the page starts again with the plain sign-in card.
      else window.location.reload();
    }).catch(() => { polling = setTimeout(poll, 30_000); });
  }

  W.getJson('/api/me').then((me) => {
    if (me.login) {
      window.location.replace(next);
      return;
    }
    if (me.visitor) {
      visitorCard(me);
      return;
    }
    // The service that hosts this console signs people in, with every request it passes on: nothing to do here.
    if (me.hosted) {
      card(h('p', { class: 'sub' }, 'This console is signed in to through the service that hosts it, and that sign-in did not reach it.'),
        h('p', { class: 'sub' }, 'Open the console again from the service. If this page keeps coming back, ask whoever runs it.'));
      return;
    }
    if (!me.available && me.signIn) {
      card(h('p', { class: 'sub' }, 'Nobody can sign in: this console requires GitHub sign-in, and the GitHub App’s client secret is not set.'),
        h('p', { class: 'sub' }, 'Put it in the console’s secret store as ', h('code', null, 'github-app-client-secret'), ' and restart the console. woodshed/console/README.md, “Sign-in”, has the steps.'));
      return;
    }
    if (!me.available) {
      card(h('p', { class: 'sub' }, 'GitHub sign-in is off: the GitHub App’s client secret is not set yet, so the console is open to anyone who reaches it.'),
        h('p', { class: 'sub' }, 'Set ', h('code', null, 'github-app-client-secret'), ' on the Secrets tab to turn it on.'),
        h('a', { class: 'btn btn-open login-btn', href: '/secrets' }, 'Open the Secrets tab'));
      return;
    }
    card(
      h('p', { class: 'sub' }, ...signInWho(me.repo)),
      !me.signIn && h('p', { class: 'msg-plain' }, 'Sign-in is not required yet. The first sign-in that works turns it on for every page.'),
      error && h('p', { class: 'form-error', role: 'alert' }, error),
      h('a', { class: 'btn btn-open login-btn', href: `/auth/start?next=${encodeURIComponent(next)}` }, 'Sign in with GitHub'),
      h('p', { class: 'foot' }, 'GitHub asks once to let the Woodshed Cloud app see who you are. It gets no access to your repositories through this.'));
  }).catch((err) => card(h('p', { class: 'form-error' }, `The console did not answer: ${err.message}`)));
})();
