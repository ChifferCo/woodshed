#!/usr/bin/env node
// Start a session without GitHub: nothing is posted to the issue and no
// permission is checked, since only someone on the console's host reaches it.
//
//   node bin/start-session.mjs <issue or PR url | number> --as <login> [--prompt "..."] [--console http://127.0.0.1:7690]

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    as: { type: 'string' },
    prompt: { type: 'string', default: '' },
    console: { type: 'string', default: process.env.WOODSHED_CLOUD_CONSOLE_URL || 'http://127.0.0.1:7690' },
  },
});

const number = Number(/(\d+)\/?$/.exec(positionals[0] || '')?.[1]);
if (!number || !values.as) {
  console.error('usage: start-session.mjs <issue or PR url | number> --as <login> [--prompt "..."] [--console <url>]');
  process.exit(2);
}

const res = await fetch(`${values.console.replace(/\/+$/, '')}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-woodshed': '1' },
  body: JSON.stringify({ number, startedBy: values.as, prompt: values.prompt }),
});
const body = await res.json();
if (!res.ok) {
  console.error(`console refused: ${body.error}`);
  process.exit(1);
}
console.log(`session ${body.id} ${body.status} for #${number} on ${body.branch}`);
console.log(`${values.console.replace(/\/+$/, '')}/s/${body.id}`);
