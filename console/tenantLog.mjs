// Which tenant a line of the log is about, in a console serving many (hosted.mjs). Each tenant's requests, loops and
// webhook events run inside runAs(tenantId, ...), and every console.log, warn and error made while one runs, however
// deep in the console's modules, gets `tenant` added to its fields. Nothing in those modules passes a tenant along:
// AsyncLocalStorage carries it through awaits, timers and callbacks started inside.
//
// Only while a multi-tenant console has it on (installTenantLog): a self-hosted console's lines are as they were.
// A line made outside any tenant (the process starting, the shared HTTP server) says `tenant: null`.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();
const LEVELS = ['log', 'info', 'warn', 'error'];
let installed = null;

/** Runs `fn` as `tenantId`'s: every line it logs, now or later from what it starts, names the tenant. */
export function runAs(tenantId, fn) {
  return storage.run({ tenant: tenantId }, fn);
}

/** @returns {string|null}  the tenant the running code is for, or null outside any */
export function currentTenant() {
  return storage.getStore()?.tenant ?? null;
}

function isFields(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Error);
}

/**
 * The console's lines are `(message, {fields})`: the tenant goes into the fields, or a fields object of its own after
 * the message when the line has none.
 * @param {unknown[]} args
 * @param {string|null} tenant
 * @returns {unknown[]}
 */
export function withTenantField(args, tenant) {
  if (args.length >= 2 && isFields(args[1])) return [args[0], { ...args[1], tenant }, ...args.slice(2)];
  if (args.length === 1) return [args[0], { tenant }];
  return [...args, { tenant }];
}

/**
 * Sends every console line through `sink` with its tenant, until the returned function is called. Two consoles in one
 * process (tests) share one install, which ends with the last of them.
 * @param {{sink?: {log?: Function, info?: Function, warn?: Function, error?: Function}|null}} [opts]
 *   where the lines go: the host's logger, or the console's own methods as they were
 * @returns {() => void}  puts console back
 */
export function installTenantLog({ sink = null } = {}) {
  if (installed) {
    installed.count += 1;
  } else {
    const original = Object.fromEntries(LEVELS.map((level) => [level, console[level]]));
    installed = { count: 1, original };
    for (const level of LEVELS) {
      console[level] = (...args) => {
        const target = installed?.sink?.[level] ?? installed?.sink?.log ?? original[level];
        target.apply(installed?.sink ?? console, withTenantField(args, currentTenant()));
      };
    }
  }
  // console itself as the sink is its own methods as they were: through the patched ones it would call itself.
  if (sink && sink !== console) installed.sink = sink;
  let done = false;
  return function uninstall() {
    if (done || !installed) return;
    done = true;
    installed.count -= 1;
    if (installed.count > 0) return;
    for (const level of LEVELS) console[level] = installed.original[level];
    installed = null;
  };
}
