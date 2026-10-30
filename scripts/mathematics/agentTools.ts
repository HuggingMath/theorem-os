#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `math <command>` for an Agent shell that cannot read the application. scripts/build-agent-tools.ts bundles this
 * next to one file per command; each runs as its own process, as through bin/math.ts.
 */
const self = fileURLToPath(import.meta.url), directory = path.dirname(self);
const [command, ...args] = process.argv.slice(2);
const file = command && /^[a-z][a-z-]*$/u.test(command) ? path.join(directory, `${command}.mjs`) : '';
if (!file || !fs.existsSync(file) || file === self) {
  const known = fs.readdirSync(directory).filter(name => name.endsWith('.mjs') && name !== path.basename(self)).map(name => name.slice(0, -4));
  console.error(`${command ? `Unknown command: ${command}\n` : ''}Commands: ${known.sort().join(', ')}`);
  process.exitCode = command && !['help', '--help', '-h'].includes(command) ? 1 : 0;
} else {
  const child = spawn(process.execPath, [file, ...args], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', error => { console.error(error.message); process.exitCode = 1; });
  child.once('exit', (code, signal) => {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
  });
}
