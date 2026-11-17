// The project file's `services` (shared/project.mjs) as each installation runs them. The file says which containers
// the repo's sessions need; where they run is the installation's:
//
//   AWS     the base box, for every session: the deploy workflow's plan job writes servicesTfvars as a var file of
//           Terraform's (`node shared/project.mjs services-tfvars`), which gives each at http://<the box>:<port>
//   local   the machine's compose stack, beside the databases: install.sh writes servicesCompose as a compose file of
//           its own, and sessions reach each by its name on the woodshed network (serviceEnv)
//
// Every reader takes the repo's default branch: the deploy workflow and install.sh check it out, and a branch's copy
// never changes what runs beside the console.

import fs from 'node:fs';
import path from 'node:path';

import { PROJECT_FILE, readRepoFile } from './project.mjs';

/**
 * Each service's files, the path in the container to the file's text: what Terraform and compose put there.
 * @returns {Record<string, string>}
 * @throws {Error}  naming a file that is not in the checkout or on the default branch
 */
function filesOf(service, repoDir) {
  return Object.fromEntries(Object.entries(service.files).map(([target, source]) => {
    const file = readRepoFile(repoDir, source);
    if (!file) throw new Error(`${PROJECT_FILE}: services ${service.name}'s file ${source} is not in the checkout or on the default branch`);
    return [target, file.text];
  }));
}

/**
 * The services as Terraform's `shared_services` variable takes them (providers/aws/terraform/variables.tf), for a var
 * file of their own: each file's text in place of its path in the repo.
 * @param {{services: object[]}} project  parsed
 * @returns {{shared_services: Record<string, object>}}
 */
export function servicesTfvars(project, repoDir) {
  return {
    shared_services: Object.fromEntries(project.services.map((s) => [s.name, {
      image: s.image, port: s.port, variable: s.variable, environment: s.environment, files: filesOf(s, repoDir), mem_limit: s.memory,
    }])),
  };
}

/**
 * Each service's variable, set to its URL by its name on the sessions' network, and WOODSHED_SERVICES, their list:
 * what a session and the seed get where the services run beside them by name (local, a session's own VM).
 * @returns {Record<string, string>}  {} for none
 */
export function serviceEnv(project) {
  if (!project.services.length) return {};
  const urls = Object.fromEntries(project.services.map((s) => [s.variable, `http://${s.name}:${s.port}`]));
  return { ...urls, WOODSHED_SERVICES: Object.keys(urls).sort().join(' ') };
}

/**
 * The services as a compose file beside providers/local/compose.yml, each on its woodshed network with no published
 * port, and each file written under `dir` (`<name>/<n>`) and mounted read-only at its path. JSON, which compose reads
 * as the YAML it is.
 * @param {{services: object[]}} project  parsed
 * @param {{repoDir: string, dir: string, network?: string|null}} where  `dir` is the installation's folder for the files,
 *   emptied first; `network` the one sessions join, which each service joins too when it is another (WOODSHED_NETWORK,
 *   the repository's own compose network), so they reach it by name there
 * @returns {object|null}  null for none
 */
export function servicesCompose(project, { repoDir, dir, network = null }) {
  fs.rmSync(dir, { recursive: true, force: true });
  if (!project.services.length) return null;
  const other = network && network !== 'woodshed';
  const services = {};
  for (const s of project.services) {
    const files = filesOf(s, repoDir);
    const volumes = Object.entries(files).map(([target, text], i) => {
      const file = path.join(dir, s.name, String(i));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, { mode: 0o755 });
      return `${file}:${target}:ro`;
    });
    services[s.name] = {
      image: s.image, restart: 'unless-stopped', environment: s.environment, mem_limit: s.memory,
      networks: other ? ['woodshed', 'sessions'] : ['woodshed'], ...(volumes.length ? { volumes } : {}),
    };
  }
  return other ? { services, networks: { sessions: { name: network, external: true } } } : { services };
}
