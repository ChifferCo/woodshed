import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('the packed CLI installs offline and runs status, config and review outside the source checkout', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'woodshed-cli-pack-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.resolve(import.meta.dirname, '..');
  const prefix = path.join(home, 'prefix');
  const env = {
    HOME: home, PATH: process.env.PATH, XDG_CONFIG_HOME: path.join(home, '.config'),
    WOODSHED_HC_BIN: path.join(home, 'absent-hc'), npm_config_offline: 'true',
  };
  function run(bin, args, expected = 0) {
    const out = spawnSync(bin, args, { cwd: home, env, encoding: 'utf8' });
    assert.equal(out.status, expected, out.error?.message ?? out.stderr);
    return out.stdout;
  }
  const [packed] = JSON.parse(run('npm', ['pack', root, '--json', '--ignore-scripts']));
  fs.mkdirSync(prefix);
  run('tar', ['-xzf', path.join(home, packed.filename), '-C', prefix]);
  const cli = path.join(home, 'woodshed');
  fs.symlinkSync(path.join(prefix, 'package/cli/woodshed.mjs'), cli);
  const help = run(cli, ['--help']);
  assert.match(help, /Usage: woodshed/);
  assert.match(help, /^  settings\s+plan\|push\|pull/m);
  assert.match(run(cli, ['session', '--help']), /connect <id>/);
  assert.match(run(cli, ['herdr', '--help']), /^  move\s/m);
  assert.match(run(cli, ['herdr', 'move', '--help']), /Usage: woodshed herdr move /);
  assert.equal(JSON.parse(run(cli, ['herdr', 'move', '--terminal', 't1', '--to', 'new', '--json'], 2)).status, 'signed-out');
  assert.equal(JSON.parse(run(cli, ['status', '--json'], 2)).signedIn, false);
  assert.match(run(cli, ['config', '--help']), /Usage: woodshed config/);
  assert.equal(JSON.parse(run(cli, ['settings', 'plan', '--only', 'skills', '--json'], 2)).status, 'signed-out');
  assert.equal(JSON.parse(run(cli, ['config', 'list', '--json'], 2)).status, 'signed-out');
  assert.match(run(cli, ['review', '--help']), /Usage: woodshed review/);
  const repo = path.join(home, 'repo');
  run('git', ['init', '--quiet', repo]);
  run('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/example-org/example-repo.git']);
  const review = JSON.parse(run(cli, ['review', 'enable', '--dir', repo, '--dry-run', '--json'], 2));
  assert.equal(review.repo, 'example-org/example-repo');
  assert.equal(review.written, false);
  assert.equal(fs.existsSync(path.join(repo, '.woodshed', 'project.yaml')), false);
  const skill = path.join(prefix, 'package/skills/woodshed/SKILL.md');
  assert.equal(fs.readFileSync(skill, 'utf8'), fs.readFileSync(path.join(root, 'skills/woodshed/SKILL.md'), 'utf8'));
});
