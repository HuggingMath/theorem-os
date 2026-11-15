#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const args = process.argv.slice(2);
const argument = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const profile = argument('--profile');
const scenario = argument('--scenario') || 'ordinary';
const format = argument('--format') || 'jsonl';
let stdin = '';
process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  const file = argument('--prompt-file');
  const prompt = file ? fs.readFileSync(file, 'utf8') : argument('--prompt') || stdin;
  const id = argument('--resume') || argument('--session-id') || 'native-' + crypto.randomUUID();
  const returnedId = scenario === 'foreign-id' ? 'foreign-native-session' : id;
  fs.appendFileSync(path.join(profile, 'cli-peer-calls.jsonl'), JSON.stringify({ args, prompt, stdin, promptFile: file,
    cwd: process.cwd(), home: process.env.HOME, cache: process.env.XDG_CACHE_HOME, fixtureEnvironment: process.env.CLI_FIXTURE_VALUE }) + '\n');
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const init = { kind: 'init', ...(scenario !== 'missing-id' ? { session: { id: returnedId } } : {}) };
  if (format === 'jsonl') send(init);
  if (scenario === 'hang') { setInterval(() => {}, 1000); return; }
  if (scenario === 'invalid-json') { process.stdout.write('{broken\n'); return; }
  if (scenario === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 0xfe])); return; }
  if (scenario === 'oversized') { process.stdout.write('x'.repeat(9 * 1024 * 1024)); return; }
  if (scenario === 'signal') { process.kill(process.pid, 'SIGKILL'); return; }
  if (scenario === 'background') {
    const writer = spawn(process.execPath, ['-e',
      'setInterval(() => require("node:fs").appendFileSync(process.argv[1], "write\\n"), 10)',
      path.join(process.cwd(), 'background.txt')], { detached: true, stdio: 'ignore' });
    writer.unref();
  }
  if (scenario === 'isolation') {
    const result = {};
    try { result.hidden = fs.readFileSync(process.env.CLI_FIXTURE_HIDDEN, 'utf8'); } catch { result.hidden = 'denied'; }
    try { fs.writeFileSync(process.env.CLI_FIXTURE_OUTSIDE, 'forbidden'); result.outside = 'written'; } catch { result.outside = 'denied'; }
    fs.writeFileSync(path.join(process.cwd(), 'owned.txt'), 'owned');
    fs.writeFileSync(path.join(profile, 'cli-peer-isolation.json'), JSON.stringify(result));
  }
  if (scenario.startsWith('failure-')) {
    send({ kind: 'failure', reason: scenario.slice('failure-'.length), message: 'private provider secret' });
    return;
  }
  const final = { kind: 'final', ...(scenario !== 'missing-id' ? { session: { id: returnedId } } : {}),
    result: { text: 'Saved generic research. λ' },
    stats: { input: 11, output: 5, cached: 2, reasoning: 1, context: 9 } };
  if (scenario === 'missing-usage') delete final.stats;
  if (scenario === 'zero-usage') final.stats = { input: 0, output: 0, cached: 0, reasoning: 0, context: 0 };
  if (scenario === 'bad-subset') final.stats.cached = 12;
  if (scenario === 'bad-output-subset') final.stats.reasoning = 6;
  if (scenario === 'overflow-usage') final.stats.input = Number.MAX_SAFE_INTEGER;
  if (scenario === 'nonzero') { process.stderr.write('private provider secret\n'); process.exitCode = 19; }
  if (format === 'text') process.stdout.write(final.result.text);
  else if (format === 'json') process.stdout.write(JSON.stringify(final));
  else {
    if (scenario === 'multiple-finals') send({ ...final, stats: { input: 7, output: 3, cached: 0, reasoning: 0, context: 5 } });
    if (scenario === 'append') { send({ kind: 'delta', text: 'First ' }); send({ kind: 'delta', text: 'second.' }); }
    if (scenario === 'changed-id') send({ kind: 'init', session: { id: 'different-native-session' } });
    send(final);
    if (scenario === 'trailing-invalid-usage') send({ ...final, stats: { input: 0, output: 0 } });
    if (scenario === 'no-newline') process.stdout.write(JSON.stringify(final));
  }
  if (scenario === 'final-then-wait') {
    fs.writeFileSync(path.join(profile, 'cli-peer-ready'), 'ready');
    setInterval(() => {}, 1000);
  }
});
