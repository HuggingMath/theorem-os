#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMathTools } from '../../src/math/mathTools';

declare const Bun: { which(command: string): string | null };

const args = process.argv.slice(2);
if (args.length !== 3) throw new Error('Usage: bun make-profile.ts BASE_RUNTIME COMPONENTS NEW_PROFILE');
const [base, components, target] = args.map(arg => path.resolve(arg));
const baseline = readMathTools(base);
const init = path.join(base, 'env.sh');
fs.accessSync(init, fs.constants.R_OK);
if (fs.existsSync(target)) throw new Error(`Profile already exists: ${target}`);

const tools = [...baseline.tools];
const catalog = fs.readFileSync(fileURLToPath(new URL('./profile-tools.tsv', import.meta.url)), 'utf8');
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const stage = fs.mkdtempSync(path.join(path.dirname(target), '.math-profile-'));
try {
  const bin = path.join(stage, 'bin');
  fs.mkdirSync(bin);
  for (const tool of baseline.tools) {
    for (const command of tool.commands) fs.symlinkSync(path.join(base, 'bin', command), path.join(bin, command));
  }

  for (const line of catalog.trimEnd().split(/\r?\n/u)) {
    const fields = line.split('\t');
    if (fields.length !== 5) throw new Error('Expected five tab-separated fields in profile-tools.tsv');
    const [group, name, version, names, purpose] = fields;
    const commands = names.split(' ');
    for (const command of commands) {
      if (!command || path.basename(command) !== command || command === '.' || command === '..')
        throw new Error(`Invalid command in profile-tools.tsv: ${command}`);
      const program = group === 'path' ? Bun.which(command) : path.join(components, group, 'bin', command);
      if (!program || !fs.statSync(program, { throwIfNoEntry: false })?.isFile())
        throw new Error(`Missing installed command: ${program || command}`);
      fs.accessSync(program, fs.constants.X_OK);
      const juliaDepot = command === 'math-julia' ? 'export THEOREMOS_JULIA_WRITABLE_DEPOT="$HOME/.julia"\n' : '';
      // O_EXCL also refuses a collision with a symlink into the frozen base runtime.
      const body = '#!/bin/sh\n. ' + quote(init) + ' || exit $?\n' + juliaDepot + 'exec ' + quote(program) + ' "$@"\n';
      fs.writeFileSync(path.join(bin, command), body, { flag: 'wx', mode: 0o755 });
    }
    tools.push({ name, version, purpose, commands });
  }

  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ schema: 'theorem-os.math-tools.v1', tools }, null, 2) + '\n', { mode: 0o444 });
  const { digest } = readMathTools(stage);
  // Pin the checked bytes. A changed manifest should fail the host's resume check.
  fs.writeFileSync(path.join(stage, 'activate.sh'), [
    'export DEEPSCIENTIST_MATH_TOOLS_ROOT=' + quote(target),
    'export DEEPSCIENTIST_MATH_TOOLS_SHA256=' + quote(digest),
    'case ":${PATH:-}:" in',
    '  *":$DEEPSCIENTIST_MATH_TOOLS_ROOT/bin:"*) ;;',
    '  *) export PATH="${PATH:+$PATH:}$DEEPSCIENTIST_MATH_TOOLS_ROOT/bin" ;;',
    'esac', ''
  ].join('\n'), { mode: 0o444 });
  fs.chmodSync(stage, 0o755 & ~process.umask());
  // GNU mv -n also handles a destination created after the initial existence check.
  execFileSync('mv', ['-nT', '--', stage, target]);
  if (fs.existsSync(stage)) throw new Error(`Profile already exists: ${target}`);
  console.log(`Built ${tools.length} tool groups (${tools.flatMap(tool => tool.commands).length} commands) in ${target}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
