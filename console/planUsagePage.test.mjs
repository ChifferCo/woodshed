import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
vm.runInNewContext(fs.readFileSync(new URL('./public/common.js', import.meta.url), 'utf8'), {
  window, console,
  document: { addEventListener() {}, querySelector() {}, createElement: () => ({}) },
  matchMedia: () => ({}),
  fetch: () => new Promise(() => {}),
});
const { planUsageOf } = window.Woodshed;
const reading = (usedPercent, asOf) => ({ asOf, fiveHour: { usedPercent } });

test('Claude plan readings and running count exclude Codex sessions', () => {
  const claude = { owner: 'octocat', status: 'running', options: { agent: 'claude' }, planUsage: reading(42, '2026-11-12T10:00:00Z') };
  const legacy = { owner: 'octocat', status: 'running' };
  const codex = { owner: 'octocat', status: 'running', options: { agent: 'codex' }, planUsage: reading(99, '2026-11-12T11:00:00Z') };
  const other = { ...claude, owner: 'someone-else', planUsage: reading(88, '2026-11-12T12:00:00Z') };
  const sessions = [claude, legacy, codex, other];
  assert.equal(planUsageOf(codex, sessions), null);
  for (const selected of [claude, legacy]) {
    const usage = planUsageOf(selected, sessions);
    assert.equal(usage.windows[0].usedPercent, 42);
    assert.equal(usage.running, 2);
  }
  assert.equal(planUsageOf(legacy, [legacy, codex]), null);
  assert.equal(planUsageOf({ owner: null }, sessions), null);
});

test('Codex shows only tagged Codex readings and counts only Codex sessions', () => {
  const codex = { owner: 'octocat', status: 'running', options: { agent: 'codex' } };
  const oldCodex = { ...codex, status: 'stopped', planUsage: { ...reading(28, '2026-11-12T10:00:00Z'), agent: 'codex' } };
  const claude = { owner: 'octocat', status: 'running', planUsage: reading(99, '2026-11-12T12:00:00Z') };
  const usage = planUsageOf(codex, [codex, oldCodex, claude]);
  assert.equal(usage.agent, 'codex');
  assert.equal(usage.windows[0].usedPercent, 28);
  assert.equal(usage.running, 1);
  assert.equal(planUsageOf(claude, [codex, oldCodex]), null);
});
