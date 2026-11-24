import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const window = { WoodshedLogins: require('./public/logins.cjs'), WoodshedAgents: require('../shared/agents.cjs'), WoodshedSetup: require('./public/setupSteps.cjs') };
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

test('Grok Build shows its one allowance and counts only its own sessions', () => {
  const spanMs = 30 * 86400_000;
  const resetsAt = new Date(Date.now() + spanMs / 2).toISOString();
  const grok = {
    owner: 'octocat', status: 'running', options: { agent: 'grok' },
    planUsage: { agent: 'grok', asOf: new Date().toISOString(), fiveHour: null, sevenDay: { usedPercent: 40, resetsAt, label: 'Month', short: 'mo', spanMs } },
  };
  const another = { owner: 'octocat', status: 'running', options: { agent: 'grok' } };
  const stopped = { ...another, status: 'stopped' };
  const claude = { owner: 'octocat', status: 'running', planUsage: reading(99, '2026-11-12T12:00:00Z') };
  const codex = { owner: 'octocat', status: 'running', options: { agent: 'codex' }, planUsage: { ...reading(11, '2026-11-12T12:00:00Z'), agent: 'codex' } };
  const usage = planUsageOf(grok, [grok, another, stopped, claude, codex]);
  assert.equal(usage.agent, 'grok');
  assert.equal(usage.running, 2);
  assert.equal(usage.windows.length, 1);
  assert.equal(usage.windows[0].key, 'sevenDay');
  assert.equal(usage.windows[0].label, 'Month');
  assert.equal(usage.windows[0].short, 'mo');
  assert.equal(usage.windows[0].usedPercent, 40);
  assert.ok(Math.abs(usage.windows[0].pace - 0.5) < 0.05);
  const weekSession = { ...grok, planUsage: { agent: 'grok', asOf: new Date().toISOString(), fiveHour: null, sevenDay: { usedPercent: 70, resetsAt: null } } };
  const week = planUsageOf(weekSession, [weekSession]);
  assert.equal(week.windows.length, 1);
  assert.equal(week.windows[0].key, 'sevenDay');
  assert.equal(week.windows[0].label, 'Week');
  assert.equal(week.windows[0].short, 'wk');
  assert.equal(planUsageOf(claude, [grok, claude]).windows[0].usedPercent, 99);
  assert.equal(planUsageOf({ owner: 'octocat', status: 'running', options: { agent: 'opencode' } }, [grok]), null);
  // A month that names a reset and no length must not borrow the seven-day span for its tick.
  const far = new Date(Date.now() + 8 * 86400_000).toISOString();
  const noSpan = {
    ...grok,
    planUsage: { agent: 'grok', asOf: new Date().toISOString(), fiveHour: null, sevenDay: { usedPercent: 40, resetsAt: far, label: 'Month', short: 'mo' } },
  };
  const open = planUsageOf(noSpan, [noSpan]);
  assert.equal(open.windows.length, 1);
  assert.equal(open.windows[0].usedPercent, 40);
  assert.equal(open.windows[0].resetsAt, far);
  assert.equal(open.windows[0].pace, null);
  const claudeReset = new Date(Date.now() + 3 * 86400_000).toISOString();
  const claudeWindow = {
    owner: 'octocat', status: 'running',
    planUsage: { asOf: new Date().toISOString(), fiveHour: null, sevenDay: { usedPercent: 20, resetsAt: claudeReset } },
  };
  const claudePace = planUsageOf(claudeWindow, [claudeWindow]).windows[1].pace;
  assert.ok(claudePace > 0.5 && claudePace < 0.6, claudePace);
});
