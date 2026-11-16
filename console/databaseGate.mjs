// Whether sessions can start on each project, and if not why and how to fix it (a blocker). An embedding program's
// `projectReadiness` hook answers first (README.md, "Embedding the console"); otherwise each project's own file, read
// from its repo's default branch (projectFile.mjs), is checked against the database engines this installation hosts.
// A blocked project starts no session that would get databases: New session and My settings show its blocker, the API
// refuses the start with its reason, and a label or /woodshed comment gets it on its issue (fleet.mjs). Every other
// project still starts. A session started anyway, from a branch whose own file differs, stops at start with the
// engine's reason (session/entrypoint.sh, requireDatabases).
import { ENGINES, projectEngines } from '../shared/databases/index.mjs';

// How long a hook's answer is kept: the pages poll /api/my, and a fix should show within a few seconds of it.
const HOOK_KEPT_MS = 10_000;

/**
 * A blocker:
 *   {project, repo, reason, fix: [{text, href?, label?}], ask?: {who: string[], text?}}
 * `reason` is one sentence naming the repo; `fix` the steps someone who can fix it takes, in order, `href` a link (https
 * or a console path) and `label` its text; `ask` who someone who cannot should ask (GitHub logins) and what to send.
 */

const label = (name) => ENGINES[name]?.label ?? name;

function joined(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** @returns {string}  the project file on GitHub, on its default branch */
export function projectFileUrl(repo) {
  return `https://github.com/${repo}/blob/HEAD/.woodshed/project.yaml`;
}

/** @returns {string}  what a start refused for the blocker says: its reason, and its first step */
export function blockerText(blocker) {
  const first = blocker.fix?.[0]?.text;
  return first ? `${blocker.reason} ${first}` : blocker.reason;
}

// A hook's answer, kept to the contract: anything else is dropped, a link that is neither https nor a console path too.
function cleanBlocker(given, project) {
  if (!given || typeof given !== 'object' || typeof given.reason !== 'string' || !given.reason.trim()) return null;
  const href = (value) => (typeof value === 'string' && (/^https:\/\//.test(value) || /^\/(?!\/)/.test(value)) ? value : null);
  const fix = (Array.isArray(given.fix) ? given.fix : [])
    .filter((step) => step && typeof step.text === 'string' && step.text.trim())
    .map((step) => ({
      text: step.text,
      ...(href(step.href) ? { href: step.href, ...(typeof step.label === 'string' && step.label ? { label: step.label } : {}) } : {}),
    }));
  const who = Array.isArray(given.ask?.who) ? given.ask.who.filter((login) => typeof login === 'string' && login) : null;
  return {
    project: project.name, repo: project.repo, reason: given.reason, fix,
    ...(who ? { ask: { who, ...(typeof given.ask.text === 'string' && given.ask.text ? { text: given.ask.text } : {}) } } : {}),
  };
}

/**
 * @param {{projectDatabases: (project: {name: string, repo: string}) => Promise<{engine: string}[]|null>,
 *          hosted: string[], provider?: string|null,
 *          fix?: (project: object, missing: string[]) => {text: string, href?: string, label?: string}[]|null,
 *          admins?: () => string[]|null, readiness?: ((project: {name: string, repo: string}) => Promise<object|null>)|null,
 *          now?: () => number}} deps
 *   `projectDatabases` reads that project's file, null when it could not be read, which blocks nothing; `hosted` the
 *   engines the installation hosts; `fix`, when it says something, the steps that host them, in place of the
 *   provider's own; `admins` whom to ask (the People list's admins), none without a list; `readiness` the embedding
 *   program's hook, asked first
 */
export function createDatabaseGate({ projectDatabases, hosted, provider = null, fix = () => null, admins = () => null, readiness = null, now = Date.now }) {
  const lastText = new Map();
  const hookKept = new Map();

  function hostSteps(project, missing) {
    const given = fix(project, missing);
    if (given?.length) return given;
    if (provider === 'aws') {
      return [{ text: `Add ${joined(missing.map((m) => `"${m}"`))} to databases in the installation's terraform.tfvars, then run terraform plan and terraform apply in providers/aws/terraform.` }];
    }
    if (provider === 'local') {
      return [{ text: `Give the console a ${joined(missing.map(label))} server with the local provider's WOODSHED_LOCAL_DB_* settings (providers/local/README.md), then start it again.` }];
    }
    return [{ text: `Whoever runs this console adds ${joined(missing.map(label))} to the databases it hosts.` }];
  }

  // The engine check, as a blocker.
  async function ownBlocker(project) {
    const databases = await projectDatabases(project);
    if (databases === null) return { blocker: null, read: false, databases };
    const missing = [...new Set(projectEngines({ databases }).filter((name) => !hosted.includes(name)))];
    if (!missing.length) return { blocker: null, read: true, databases };
    const many = missing.length > 1;
    const runs = hosted.length ? `only runs ${joined(hosted.map(label))}` : 'runs no database';
    const reason = `${project.repo}'s project file asks for ${many ? '' : 'a '}${joined(missing.map(label))} database${many ? 's' : ''}, and this console ${runs}.`;
    const who = admins() ?? [];
    return {
      read: true, databases,
      blocker: {
        project: project.name, repo: project.repo, reason,
        fix: [
          ...hostSteps(project, missing),
          { text: `Or take the ${joined(missing.map(label))} database${many ? 's' : ''} out of ${project.repo}'s project file.`, href: projectFileUrl(project.repo), label: 'Open the project file' },
        ],
        ...(who.length ? { ask: { who, text: `Sessions cannot start on ${project.repo}: its project file asks for ${joined(missing.map(label))}, which this console does not run. Could you add it, or should the project file drop it?` } } : {}),
      },
    };
  }

  async function fromHook(project) {
    if (!readiness) return null;
    const kept = hookKept.get(project.name);
    if (kept && kept.repo === project.repo && now() - kept.at < HOOK_KEPT_MS) return kept.blocker;
    let blocker = null;
    try {
      blocker = cleanBlocker(await readiness({ name: project.name, repo: project.repo }), project);
    } catch (err) {
      // A hook that fails blocks nothing: the engine check still runs.
      console.warn('console: project readiness not read', { project: project.name, message: String(err?.message ?? err).split('\n')[0] });
    }
    hookKept.set(project.name, { repo: project.repo, at: now(), blocker });
    return blocker;
  }

  /** @returns {Promise<object|null>}  why no session that gets databases can start on `project`, or null */
  async function blocker(project) {
    if (!project?.repo) return null;
    const hooked = await fromHook(project);
    const own = hooked ? null : await ownBlocker(project);
    const found = hooked ?? own.blocker;
    const text = found ? blockerText(found) : null;
    if (text !== (lastText.get(project.name) ?? null)) {
      const field = { project: project.name, repo: project.repo };
      if (hooked) console.warn('console: project not ready', { ...field, from: 'program', reason: hooked.reason });
      else if (found) console.warn('console: project databases not hosted', { ...field, needs: own.databases.map((d) => d.engine), hosted });
      else if (!own.read) console.warn('console: project file not read, its databases not checked', { ...field, hosted });
      else console.log('console: project ready again', { ...field, hosted });
    }
    lastText.set(project.name, text);
    return found;
  }

  return {
    blocker,
    /** @returns {Promise<Record<string, object>>}  each blocked project's blocker, by name */
    async blockers(projects) {
      const found = await Promise.all(projects.map((p) => blocker(p)));
      return Object.fromEntries(found.filter(Boolean).map((b) => [b.project, b]));
    },
    /** @returns {Promise<string|null>}  what a refused start on `project` says, or null */
    async refusal(project) {
      const found = await blocker(project);
      return found ? blockerText(found) : null;
    },
    /** @returns {string|null}  the last answer for a project, for a page that cannot wait for a read */
    last: (name) => lastText.get(name) ?? null,
  };
}
