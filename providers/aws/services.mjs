// The project file's services (docs/reference.md, "The shared services") on the AWS provider's base box, one copy of
// each for every session. Two halves, because the base box never reads GitHub:
//
//   - `spec`, in the installation's deploy workflow, on its checkout of the default branch: the services and their
//     files' text, as one base64 line the `<prefix>-refresh-services` SSM document takes (providers/aws/README.md,
//     "The project's services").
//   - `render`, on the base box, in a throwaway container of the console image with no network: the same spec checked
//     again and turned into a compose file, the files, the URLs the console hands sessions (services.json) and the
//     db-admin template's overrides. The base box's `<prefix>-services` script runs it, then the containers.
//
// Only stateless services, for now: one with `data` needs a copy for each person or session, started when one
// starts, which a deploy cannot do. The spec refuses one, and the deploy stops before anything changes on the box.
import fs from 'node:fs';
import path from 'node:path';

import { isMain } from '../../shared/isMain.mjs';
import { loadProject, parseProject, readRepoFile, repoOf, SERVICE_VARIABLE } from '../../shared/project.mjs';
import { serviceProblems } from '../../shared/projectCheck.mjs';
import { isSessionVariable } from '../../shared/reservedNames.mjs';

export const SPEC_VERSION = 1;
// Each service's port on the box, the first one's FIRST_HOST_PORT and so on: the base box's security group lets
// sessions reach HOST_PORT_RANGE (terraform/network.tf), wider than MAX_SERVICES so a copy per person fits later.
export const FIRST_HOST_PORT = 42000;
export const HOST_PORT_RANGE = 100;
// Each service's URL rides in every session's run-task overrides, which ECS caps (ecsLauncher.mjs, sessionOverrides).
export const MAX_SERVICES = 20;
// The deploy passes the spec as one SSM parameter: init scripts are small, and one this big is a mistake.
export const MAX_SPEC_BYTES = 64 * 1024;
// The file the console reads the URLs from, in its state folder (/var/lib/<prefix>/console on the box).
export const SERVICES_FILE = 'services.json';

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const PREFIX = /^[a-z][a-z0-9-]{0,31}$/;
// The same plain URL session/dbAdmin.mjs takes for a service.
const URL = /^http:\/\/[0-9.]+:[0-9]+$/;

function fail(message) {
  throw new Error(`services: ${message}`);
}

// A size as compose takes one (768m, 1g, 512MB, 1073741824), in MiB.
const UNITS = { '': 1 / 1048576, b: 1 / 1048576, k: 1 / 1024, m: 1, g: 1024 };
const mib = (memory) => {
  const [, n, unit] = /^([1-9][0-9]*)([bkmg]?)b?$/i.exec(memory);
  return Math.ceil(Number(n) * UNITS[unit.toLowerCase()]);
};
// What Terraform's shared_services still run (terraform/baseBox.tf, legacy_services): names, variables and ports the
// project's must not take, memory they keep, and variables WOODSHED_SERVICES goes on listing, whose URLs the task
// definition sets.
const LEGACY = { name: /^[a-z][a-z0-9-]*$/, memory: /^[1-9][0-9]*[bkmg]?b?$/i };

function legacyServices(value) {
  if (!Array.isArray(value)) fail('the shared_services must be a list');
  for (const s of value) {
    if (!s || !LEGACY.name.test(s.name) || !SERVICE_VARIABLE.test(s.variable) || !Number.isInteger(s.port) || !LEGACY.memory.test(s.memory)) {
      fail(`${JSON.stringify(s)} is not one of Terraform's shared_services`);
    }
  }
  return value;
}

/**
 * The deploy's half: the project's services with their files' text, checked as the box will check them.
 * @param {ReturnType<typeof loadProject>} project
 * @param {{repoDir: string, repo: string|null}} where  `repo` is owner/name, the default project the box's URLs are for
 * @returns {string}  the spec, base64
 */
export function servicesSpec(project, { repoDir, repo }) {
  if (!repo || !REPO.test(repo)) fail(`the repo could not be told (${repo ?? 'none'}): run it in a checkout whose origin is on GitHub, or set GITHUB_REPOSITORY`);
  const problems = serviceProblems(project, repoDir);
  if (problems.length) fail(`the project file's services are not ready:\n${problems.join('\n')}`);
  const stateful = project.services.filter((s) => s.data);
  if (stateful.length) {
    fail(`${stateful.map((s) => s.name).join(', ')} keep${stateful.length === 1 ? 's' : ''} data (data.keep: ${stateful.map((s) => s.data.keep).join(', ')}), which the AWS provider does not run yet: leave ${stateful.length === 1 ? 'it' : 'them'} in Terraform's shared_services until it does`);
  }
  const services = project.services.map((s) => ({
    name: s.name, image: s.image, port: s.port, variable: s.variable, environment: s.environment, memory: s.memory,
    files: Object.fromEntries(Object.entries(s.files).map(([target, source]) => [target, Buffer.from(readRepoFile(repoDir, source).text).toString('base64')])),
  }));
  const spec = Buffer.from(JSON.stringify({ version: SPEC_VERSION, repo, services })).toString('base64');
  if (spec.length > MAX_SPEC_BYTES) fail(`the services and their files come to ${spec.length} bytes, more than ${MAX_SPEC_BYTES}: keep a service's files to its init scripts`);
  // What the box will refuse, refused here, before the deploy touches AWS.
  render(spec, { dir: '/var/lib/woodshed/services', privateIp: '10.0.0.1', prefix: 'woodshed', memoryMib: Infinity });
  return spec;
}

/**
 * The box's half. Nothing in the spec is trusted: it reaches the box as a parameter anyone who may run the document can set.
 * @param {string} spec  base64, as servicesSpec makes it
 * @param {{dir: string, privateIp: string, prefix: string, memoryMib: number, legacy?: object[]}} box  `dir` is where the
 *   box keeps the result (files are mounted from there), `memoryMib` what the box has for the services, `legacy` what
 *   Terraform's shared_services run beside them (legacyServices)
 * @returns {{compose: object, files: {path: string, text: Buffer}[], urls: object, templateOverrides: object, count: number}}
 *   `files` are relative to `dir`
 */
export function render(spec, { dir, privateIp, prefix, memoryMib, legacy = [] }) {
  const shared = legacyServices(legacy);
  if (typeof spec !== 'string' || !spec || spec.length > MAX_SPEC_BYTES || !BASE64.test(spec)) fail(`the spec must be base64, at most ${MAX_SPEC_BYTES} bytes`);
  const ip = IPV4.exec(privateIp);
  if (!ip || ip.slice(1).some((n) => Number(n) > 255)) fail(`${privateIp} is not the box's private address`);
  if (!PREFIX.test(prefix)) fail(`${prefix} is not a name prefix`);
  if (!path.isAbsolute(dir) || dir.includes(':')) fail(`${dir} must be an absolute folder with no colon`);
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(spec, 'base64').toString('utf8'));
  } catch {
    fail('the spec is not JSON');
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== SPEC_VERSION) fail(`the spec must be version ${SPEC_VERSION}: deploy the console image built with the same Woodshed as the spec`);
  const extra = Object.keys(parsed).filter((k) => !['version', 'repo', 'services'].includes(k));
  if (extra.length) fail(`the spec has ${extra.join(', ')}, which it does not take`);
  if (typeof parsed.repo !== 'string' || !REPO.test(parsed.repo)) fail('the spec names no repo, owner/name');
  if (!Array.isArray(parsed.services)) fail('the spec\'s services must be a list');
  if (parsed.services.length > MAX_SERVICES) fail(`the project has ${parsed.services.length} services, more than ${MAX_SERVICES}`);

  // The project file's own rules, from its parser: the files' text stands in for their paths, which it checks are paths.
  for (const s of parsed.services) {
    if (!s || typeof s !== 'object' || !s.files || typeof s.files !== 'object' || Array.isArray(s.files)) fail('each service needs its files, {} for none');
    for (const [target, text] of Object.entries(s.files)) if (typeof text !== 'string' || !BASE64.test(text)) fail(`${s.name}'s file ${target} is not base64`);
    if ('data' in s) fail(`${s.name} keeps data, which the AWS provider does not run yet`);
  }
  const services = parseProject({
    version: 1,
    services: parsed.services.map((s) => ({ ...s, files: Object.fromEntries(Object.keys(s.files).map((target) => [target, 'spec'])) })),
  }).services;

  // Each on its own beside Terraform's: those keep their names, variables and ports until they move here.
  for (const s of services) {
    const clash = shared.find((t) => t.name === s.name || t.variable === s.variable);
    if (clash) fail(`${s.name} is Terraform's shared_services' ${clash.name} too (${clash.variable}): set shared_services to {} for it and apply first, or name it otherwise`);
  }
  for (const t of shared) {
    if (t.port >= FIRST_HOST_PORT && t.port < FIRST_HOST_PORT + HOST_PORT_RANGE) fail(`Terraform's shared_services' ${t.name} listens on ${t.port}, which the project's services take: give it another port`);
  }
  const total = services.reduce((sum, s) => sum + mib(s.memory), 0);
  const left = memoryMib - shared.reduce((sum, t) => sum + mib(t.memory), 0);
  if (total > left) {
    fail(`the services' memory comes to ${total} MiB, and the base box has ${Math.max(0, Math.floor(left))} MiB for them: set a larger base_box_instance_type in Terraform, or lower their memory`);
  }

  const files = [];
  const compose = { name: `${prefix}-services`, services: {} };
  const urls = { repo: parsed.repo, services: [], sharedVariables: shared.map((t) => t.variable) };
  services.forEach((s, i) => {
    const hostPort = FIRST_HOST_PORT + i;
    const mounts = Object.keys(s.files).map((target, j) => {
      const file = path.posix.join('files', s.name, String(j));
      files.push({ path: file, text: Buffer.from(parsed.services[i].files[target], 'base64') });
      return `${path.posix.join(dir, file)}:${target}:ro`;
    });
    compose.services[s.name] = {
      image: s.image,
      restart: 'unless-stopped',
      mem_limit: s.memory,
      // The private address only: the security group then lets sessions alone reach it.
      ports: [`${privateIp}:${hostPort}:${s.port}`],
      // Compose reads $ in a value as a variable of its own.
      ...(Object.keys(s.environment).length && { environment: Object.fromEntries(Object.entries(s.environment).map(([k, v]) => [k, v.replaceAll('$', () => '$$')])) }),
      ...(mounts.length && { volumes: mounts }),
      security_opt: ['no-new-privileges:true'],
    };
    urls.services.push({ name: s.name, variable: s.variable, url: `http://${privateIp}:${hostPort}` });
  });
  // The db-admin template run (refresh-db-template) gets them as a seed run from the console does (dbAdminRunner.mjs).
  const templateOverrides = { containerOverrides: [{ name: 'db-admin', command: ['template'], environment: serviceEnvironment(urls) }] };
  return { compose, files, urls, templateOverrides, count: services.length };
}

// The variables a session or a db-admin run gets: each service's URL, and WOODSHED_SERVICES listing them with
// Terraform's shared_services' (whose URLs the task definition sets). None leaves the task definition's as they are.
function serviceEnvironment(urls) {
  if (!urls.services.length) return [];
  return [
    ...urls.services.map((s) => ({ name: s.variable, value: s.url })),
    { name: 'WOODSHED_SERVICES', value: [...urls.services.map((s) => s.variable), ...(urls.sharedVariables ?? [])].sort().join(' ') },
  ];
}

/**
 * The console's half: the URLs the box's services answer at, from the file `<prefix>-services` left in the console's
 * state folder. Read at each start, so a deploy reaches the next session without a restart. No file is no services
 * (Terraform's shared_services, in the task definition, then stand).
 * @param {string} stateDir
 * @returns {() => {repo: string, environment: {name: string, value: string}[]}|null}
 */
export function serviceUrlReader(stateDir) {
  const file = path.join(stateDir, SERVICES_FILE);
  return () => {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    const urls = JSON.parse(text);
    if (!urls || typeof urls.repo !== 'string' || !REPO.test(urls.repo) || !Array.isArray(urls.services)) throw new Error(`${file} is not the base box's services`);
    if (!Array.isArray(urls.sharedVariables ?? []) || (urls.sharedVariables ?? []).some((v) => typeof v !== 'string' || !SERVICE_VARIABLE.test(v) || isSessionVariable(v))) {
      throw new Error(`${file} has sharedVariables that are not services' variables`);
    }
    for (const s of urls.services) {
      // Each lands in a session's environment: never one of Woodshed's own, nor a URL the entrypoint would not take.
      if (typeof s?.variable !== 'string' || !SERVICE_VARIABLE.test(s.variable) || isSessionVariable(s.variable) || typeof s.url !== 'string' || !URL.test(s.url)) {
        throw new Error(`${file} has ${JSON.stringify(s)}, which is not a service's variable and URL`);
      }
    }
    return { repo: urls.repo, environment: serviceEnvironment(urls) };
  };
}

/**
 * The services' variables for a session: only one on the repo the box's services are for, the installation's default
 * project, which a session on another project (PROJECT_REPO) is not.
 * @param {ReturnType<ReturnType<typeof serviceUrlReader>>} services
 * @param {Record<string, string>} env  the session's
 * @returns {Record<string, string>}
 */
export function sessionServiceEnv(services, env) {
  if (!services) return {};
  if (env.PROJECT_REPO && env.PROJECT_REPO.toLowerCase() !== services.repo.toLowerCase()) return {};
  return Object.fromEntries(services.environment.map(({ name, value }) => [name, value]));
}

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i += 2) {
    if (!list[i].startsWith('--') || list[i + 1] === undefined) fail(`expected --name value pairs, not ${list.slice(i).join(' ')}`);
    out[list[i].slice(2)] = list[i + 1];
  }
  return out;
}

function main([command, ...rest]) {
  if (command === 'spec') {
    const repoDir = process.env.REPO_DIR || process.cwd();
    const project = loadProject(repoDir);
    process.stdout.write(`${servicesSpec(project, { repoDir, repo: repoOf(repoDir) ?? process.env.GITHUB_REPOSITORY ?? null })}\n`);
  } else if (command === 'render') {
    const { out, dir, 'private-ip': privateIp, prefix, 'memory-mib': memory, legacy = '' } = args(rest);
    if (!out || !dir || !privateIp || !prefix || !memory) fail('render takes --out, --dir, --private-ip, --prefix, --memory-mib and --legacy (base64 JSON), with the spec on stdin');
    const result = render(fs.readFileSync(0, 'utf8').trim(), { dir, privateIp, prefix, memoryMib: Number(memory), legacy: legacy ? JSON.parse(Buffer.from(legacy, 'base64').toString('utf8')) : [] });
    for (const file of result.files) {
      fs.mkdirSync(path.join(out, path.dirname(file.path)), { recursive: true });
      // Read-only in the container, and executable, for an init script.
      fs.writeFileSync(path.join(out, file.path), file.text, { mode: 0o755 });
    }
    fs.writeFileSync(path.join(out, 'compose.json'), `${JSON.stringify(result.compose, null, 2)}\n`);
    fs.writeFileSync(path.join(out, SERVICES_FILE), `${JSON.stringify(result.urls, null, 2)}\n`);
    fs.writeFileSync(path.join(out, 'template-overrides.json'), `${JSON.stringify(result.templateOverrides)}\n`);
    fs.writeFileSync(path.join(out, 'count'), `${result.count}\n`);
    process.stdout.write(`services: ${result.urls.services.map((s) => `${s.name} at ${s.url} in ${s.variable}`).join(', ') || 'none'}\n`);
  } else {
    fail(`unknown command: ${command} (expected spec or render)`);
  }
}

if (isMain(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
