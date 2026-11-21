// Pick the repositories a Woodshed console works on, through the same checks as Console settings' Repos card.

const USAGE = `Usage: woodshed repo <command> [--console <url>] [--json] [--no-browser]

Commands:
  list                         the console's repos and which repos you can add
  add <owner/name> [--name N]  add a repo, optionally with a different project name
  remove <owner/name>          remove a repo from the console

If GitHub App access is needed, open the link it prints and run the add again.`;

const PATH = '/api/cli/repos';
const printable = (text, max = 600) => typeof text === 'string' ? text.replace(/[^\x20-\x7e]/g, '').slice(0, max) : null;
const appAccess = (repo) => repo.githubAppAccess === true ? 'App has access' : repo.githubAppAccess === false ? 'App has no access' : 'App access unknown';

export async function repoCommand({ origin, args, rest, browser, help }, { stdout, call, token, open, isTerminal, json, emit, say, EXIT, fail }) {
  const [action, repo, flag, name] = args;
  if (help || action === 'help' || !action) {
    stdout.write(`${USAGE}\n`);
    return help || action ? EXIT.done : EXIT.failed;
  }
  const list = action === 'list';
  const add = action === 'add';
  const remove = action === 'remove';
  const named = add && flag === '--name' && name && args.length === 4;
  if (rest || !(list && args.length === 1 || (add || remove) && repo && (args.length === 2 || named))) {
    throw fail(`Usage: woodshed repo list | add <owner/name> [--name N] | remove <owner/name>`);
  }
  const login = `Run: woodshed login --console ${origin}`;
  if (!token) throw fail(`Not signed in to ${origin}. ${login}`, { code: EXIT.waiting, status: 'signed-out' });
  const route = remove ? `${PATH}/remove` : PATH;
  let out;
  try {
    out = await call(origin, route, list ? { token } : { method: 'POST', token, body: { repo, ...(named && { name }) } });
  } catch (err) {
    if (!list && err.unreachable) throw fail(`${err.message}. Check whether the change took effect with woodshed repo list --console ${origin}.`);
    throw err;
  }
  const body = out.body;
  const message = printable(body?.error) ?? `${origin} answered ${out.status}`;
  if (out.status === 401) throw fail(`${message}. ${login}`, { code: EXIT.waiting, status: 'signed-out' });
  if (add && out.status === 409 && body?.status === 'needs-github-app') {
    // Only open a GitHub web page. The console supplies the installation or the App's install page.
    const url = typeof body.url === 'string' ? URL.parse(body.url) : null;
    const href = url?.origin === 'https://github.com' && !url.username && !url.password ? url.href : null;
    if (json) emit({ event: 'error', status: 'needs-github-app', console: origin, repo, error: message, url: href });
    say(message);
    if (href) say(`Open ${href}`);
    say(`After granting access, run woodshed repo add ${printable(repo)}${named ? ` --name ${printable(name)}` : ''} --console ${origin} again.`);
    if (href && browser && isTerminal) open(href);
    return EXIT.waiting;
  }
  if (out.status === 403 || out.status === 409) throw fail(message, { code: EXIT.refused, status: 'refused' });
  if (out.status !== 200 || !body) throw fail(message);
  if (list) {
    if (!Array.isArray(body.projects) || !(body.available === null || Array.isArray(body.available))) throw fail(`${origin} did not return a repo list`);
    if (json) emit({ event: 'repo-list', console: origin, ...body });
    say(body.projects.length ? 'Connected repos' : 'No connected repos.');
    for (const project of body.projects) say(`  ${printable(project.repo)} (${printable(project.name)}) · ${appAccess(project)}`);
    if (!body.canChange) say('An admin can list repos to add and change the repo list.');
    else if (body.available === null) say(printable(body.choicesError) ?? 'Type an owner/name to add a repo.');
    else {
      say(body.available.length ? 'Available to add' : 'No more repos listed to add.');
      for (const project of body.available) say(`  ${printable(project.repo)} · ${appAccess(project)}`);
      if (body.choicesIncomplete) say('Some GitHub App repos could not be listed.');
    }
  } else {
    if (typeof body.repo !== 'string' || typeof body.name !== 'string') throw fail(`${origin} did not confirm the repo change`);
    if (json) emit({ event: add ? 'repo-added' : 'repo-removed', console: origin, repo: body.repo, name: body.name });
    say(`${add ? 'Added' : 'Removed'} ${printable(body.repo)} (${printable(body.name)}).`);
  }
  return EXIT.done;
}
