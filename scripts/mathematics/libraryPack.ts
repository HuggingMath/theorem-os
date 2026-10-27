#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { extractRunLibraryModules, LIBRARY_PACK_SCHEMA, readLibraryPack, summarizeLibraryPack, upstreamLibraryModules,
  type LibraryPack } from '../../src/math/libraryPacks';

const usage = `Usage: theorem-os library-pack extract --state RUN/state.json --file Submission/Helpers.lean [--file F]
                      [--commit OID] [--into NAME] [--drop-unproved] [--base PACK] --output PACK
       theorem-os library-pack upstream --repo LEAN_REPO --commit REV --file Mathlib/X/Y.lean [--file F]
                      [--into NAME] [--base PACK] --output PACK
       theorem-os library-pack inspect PACK
Builds a ${LIBRARY_PACK_SCHEMA} JSON for bootstrap-lean-eval --library-pack. Modules land under Submission/Library/NAME.
extract copies owned files of a run commit (default: its canonical commit) and removes the original problem declarations,
proofs with sorry or admit (only with --drop-unproved) and every declaration that mentions a removed name.
upstream copies files of a local repository revision verbatim, renaming imports among the selected files.
Imports of a --base pack's modules are kept; --output is created and never overwritten. Without --output only the summary prints.
Lexical checks only: the bootstrap installs the modules byte-frozen and every run rechecks them in Lean before solving.`;

function main() {
  const [command, ...rest] = process.argv.slice(2)[0] === 'library-pack' ? process.argv.slice(3) : process.argv.slice(2);
  const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: {
    state: { type: 'string' }, repo: { type: 'string' }, commit: { type: 'string' }, file: { type: 'string', multiple: true },
    into: { type: 'string' }, 'drop-unproved': { type: 'boolean' }, base: { type: 'string' }, output: { type: 'string' },
    help: { type: 'boolean' } } });
  if (values.help || !command || command === 'help' || command === '--help') { console.log(usage); return; }
  if (command === 'inspect') {
    if (positionals.length !== 1) throw new Error('inspect takes one PACK file');
    console.log(JSON.stringify(summarizeLibraryPack(readLibraryPack(positionals[0]!)), null, 2));
    return;
  }
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  const base = values.base ? readLibraryPack(values.base) : undefined;
  let pack: LibraryPack;
  if (command === 'extract') {
    if (!values.state || !values.file?.length) throw new Error('extract requires --state and --file');
    pack = extractRunLibraryModules({ stateFile: values.state, files: values.file, commit: values.commit, into: values.into,
      dropUnproved: values['drop-unproved'], base });
  } else if (command === 'upstream') {
    if (!values.repo || !values.commit || !values.file?.length) throw new Error('upstream requires --repo, --commit and --file');
    pack = upstreamLibraryModules({ repository: values.repo, commit: values.commit, files: values.file, into: values.into, base });
  } else throw new Error(`Unknown library-pack command: ${command}`);
  if (values.output) fs.writeFileSync(path.resolve(values.output), JSON.stringify(pack) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ ...summarizeLibraryPack(pack), ...(values.output ? { output: path.resolve(values.output) } : { dryRun: true }) }, null, 2));
}
try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : 'math_library_pack_failed');
  process.exitCode = 1;
}
