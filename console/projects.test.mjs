import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config.mjs';
import { allProjects, defaultProject, hasRepo, installationIdFor, loadProjects, projectFor, projectNameOf } from './projects.mjs';

const two = JSON.stringify([
  { name: 'app', repo: 'acme/app', default: true },
  { name: 'woodshed', repo: 'acme/woodshed' },
]);

test('with only WOODSHED_CLOUD_REPO, the installation has one project, its default, named after the repo', () => {
  assert.deepEqual(loadProjects({ WOODSHED_CLOUD_REPO: ' acme/Web.App ' }), [{ name: 'web-app', repo: 'acme/Web.App', default: true }]);
  assert.deepEqual(loadProjects({}), [], 'neither set: none, and the console starts with no repo');
  const config = loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_REPO: 'acme/app' });
  assert.equal(defaultProject(config).repo, 'acme/app');
  assert.equal(config.repo, undefined, 'the repo is read through the project, not beside it');
});

test('WOODSHED_CLOUD_PROJECTS lists the projects, and the one marked default is the default', () => {
  const projects = loadProjects({ WOODSHED_CLOUD_PROJECTS: two });
  assert.deepEqual(projects.map((p) => [p.name, p.default]), [['app', true], ['woodshed', false]]);
  assert.equal(defaultProject({ projects }).repo, 'acme/app');
  assert.deepEqual(loadProjects({ WOODSHED_CLOUD_PROJECTS: '[{"name":"solo","repo":"acme/solo"}]' })[0].default, true, 'one project needs no mark');
  assert.equal(loadProjects({ WOODSHED_CLOUD_PROJECTS: '[{"name":"a","repo":"acme/a","installationId":7}]' }).length, 1, 'fields a later console reads are no error');
});

test('WOODSHED_CLOUD_REPO beside the list must be the default project\'s repo', () => {
  assert.equal(loadProjects({ WOODSHED_CLOUD_PROJECTS: two, WOODSHED_CLOUD_REPO: 'acme/app' }).length, 2);
  assert.equal(loadProjects({ WOODSHED_CLOUD_PROJECTS: two, WOODSHED_CLOUD_REPO: 'ACME/App' }).length, 2, 'GitHub names are not case-sensitive');
  assert.throws(() => loadProjects({ WOODSHED_CLOUD_PROJECTS: two, WOODSHED_CLOUD_REPO: 'acme/woodshed' }), /WOODSHED_CLOUD_REPO is acme\/woodshed but the default project's repo is acme\/app/);
});

test('a list that is wrong stops the console with what is wrong in it', () => {
  const refused = (value, message) => assert.throws(() => loadProjects({ WOODSHED_CLOUD_PROJECTS: value }), message);
  refused('[{name:', /WOODSHED_CLOUD_PROJECTS is not JSON/);
  refused('{}', /must be a list of projects/);
  refused('[]', /must be a list of projects/);
  refused('[null]', /\[0\]: name must be/);
  refused('[{"name":"App","repo":"acme/app"}]', /\[0\]: name must be lowercase/);
  for (const name of ['app-', '-app', 'my--app', 'a'.repeat(33)]) refused(JSON.stringify([{ name, repo: 'acme/app' }]), /\[0\]: name must be lowercase/);
  assert.equal(loadProjects({ WOODSHED_CLOUD_PROJECTS: JSON.stringify([{ name: 'a'.repeat(32), repo: 'acme/app' }]) }).length, 1, '32 is long enough');
  refused('[{"name":"a","repo":"acme/a","installationId":"12x"}]', /\[0\] \(a\): installationId must be the GitHub App installation's number/);
  refused('[{"name":"a","repo":"app"}]', /\[0\] \(a\): repo must be owner\/name/);
  refused('[{"name":"a","repo":"acme/a","default":true},{"name":"a","repo":"acme/b"}]', /two projects have the name a/);
  refused('[{"name":"a","repo":"acme/a","default":true},{"name":"b","repo":"ACME/A"}]', /two projects have the repo ACME\/A/);
  refused('[{"name":"a","repo":"acme/a"},{"name":"b","repo":"acme/b"}]', /exactly one project must have "default": true/);
  refused('[{"name":"a","repo":"acme/a","default":true},{"name":"b","repo":"acme/b","default":true}]', /exactly one project/);
  assert.throws(() => loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_PROJECTS: '[]' }), /must be a list of projects/, 'loadConfig refuses it too');
});

test('a config made by hand with only a repo still has a default project', () => {
  assert.deepEqual(defaultProject({ repo: 'acme/app' }), { name: 'app', repo: 'acme/app', default: true });
  assert.equal(projectNameOf('acme/--.x--'), 'x');
  assert.equal(projectNameOf('acme/...'), 'default');
  assert.equal(projectNameOf('acme/a-.b'), 'a-b', 'never two dashes in a row');
  assert.equal(projectNameOf(`acme/${'x'.repeat(31)}-tail`), 'x'.repeat(31), 'cut to 32, then its dashes trimmed, never ending in one');
});

test('a project may name its own GitHub App installation, and otherwise uses the installation\'s', () => {
  const projects = loadProjects({ WOODSHED_CLOUD_PROJECTS: '[{"name":"a","repo":"acme/a","default":true},{"name":"b","repo":"other/b","installationId":42}]' });
  const config = { projects, githubApp: { appId: '1', installationId: '7' } };
  assert.equal(projects[1].installationId, '42', 'a number in the JSON is read as the id it names');
  assert.equal(installationIdFor(config, projects[0]), '7');
  assert.equal(installationIdFor(config, projects[1]), '42');
  assert.equal(installationIdFor({ projects }, projects[0]), null, 'no GitHub App, no installation');
});

test('a session runs on the project it names, or else the one with its repo, or else the default', () => {
  const projects = loadProjects({ WOODSHED_CLOUD_PROJECTS: two });
  const config = { projects };
  assert.equal(projectFor(config, { project: 'woodshed', repo: 'acme/woodshed' }).name, 'woodshed');
  assert.equal(projectFor(config, { repo: 'Acme/Woodshed' }).name, 'woodshed', 'a record from before sessions named their project');
  assert.equal(projectFor(config, { project: 'gone', repo: 'acme/gone' }).name, 'app', 'a project the installation no longer has');
  assert.equal(projectFor(config, {}).name, 'app');
  assert.equal(projectFor({ repo: 'acme/app' }, { repo: 'acme/app' }).name, 'app', 'a config made by hand');
});

test('a console with no repo has no project to list, and its default stands in with no repo', () => {
  const config = loadConfig({ GH_TOKEN: 'x' });
  assert.deepEqual(allProjects(config), [], 'nothing to poll or offer');
  assert.equal(hasRepo(config), false);
  assert.equal(defaultProject(config).repo, '');
  assert.equal(projectFor(config, { project: 'gone' }).repo, '', 'a session record on a project it no longer has falls to no repo, which a start refuses');
  assert.equal(hasRepo(loadConfig({ GH_TOKEN: 'x', WOODSHED_CLOUD_REPO: 'acme/app' })), true);
  assert.deepEqual(allProjects({ repo: 'acme/app' }).map((p) => p.repo), ['acme/app'], 'a config made by hand keeps its one');
});
