#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { readLibraryPack, summarizeLibraryPack } from '../../src/math/libraryPacks';
import { canonicalMathJson, readMathText, writeMathFrozen } from '../../src/math/mathRuntimeIo';
import { readLibraryCatalog, writeLibraryCatalog } from '../../src/solver/libraryCatalog';

const usage = `Usage: theorem-os library-catalog build --pack PACK [--pack PACK] --id OWNER/NAME --revision REV
                                  --environment standard|mathlib --output NEW_DIRECTORY
       theorem-os library-catalog inspect --catalog CATALOG [--sha256 DIGEST]
       theorem-os library-catalog search --catalog CATALOG [--sha256 DIGEST] [--query WORDS] [--goal LEAN_TYPE]
       theorem-os library-catalog select --catalog CATALOG [--sha256 DIGEST] --source SOURCE.lean
                                   [--task TASK.md] --output PACK.json
Build separates searchable interfaces from content-addressed module sources. Search reads metadata only;
select reads a bounded dependency closure and writes PACK.json plus PACK.json.lock.json, pinning the release
and source hashes. The normal solver rechecks every installed module and the final proof in Lean.`;

function main() {
  const [command, ...args] = process.argv.slice(2)[0] === 'library-catalog' ? process.argv.slice(3) : process.argv.slice(2);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    pack: { type: 'string', multiple: true }, id: { type: 'string' }, revision: { type: 'string' },
    environment: { type: 'string' }, output: { type: 'string' }, catalog: { type: 'string' },
    sha256: { type: 'string' }, source: { type: 'string' }, task: { type: 'string' },
    query: { type: 'string' }, goal: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (!command || command === 'help' || command === '--help' || values.help) { console.log(usage); return; }
  if (positionals.length) throw new Error(`Unexpected argument: ${positionals[0]}`);
  if (command === 'build') {
    if (!values.pack?.length || !values.id || !values.revision || !values.environment || !values.output)
      throw new Error('build requires --pack, --id, --revision, --environment and --output');
    const environment = getLeanTaskEnvironment(values.environment as LeanTaskEnvironment);
    console.log(JSON.stringify(writeLibraryCatalog(values.output, { id: values.id, revision: values.revision,
      environment: environment.id, packs: values.pack.map(readLibraryPack) }), null, 2));
    return;
  }
  if (!['inspect', 'search', 'select'].includes(command)) throw new Error(`Unknown library-catalog command: ${command}`);
  if (!values.catalog) throw new Error(`${command} requires --catalog`);
  const catalog = readLibraryCatalog(values.catalog, values.sha256);
  if (command === 'inspect') {
    console.log(JSON.stringify({ ...catalog.identity, environment: catalog.environment, toolchain: catalog.toolchain,
      modules: catalog.moduleCount, declarations: catalog.declarationCount }, null, 2));
  } else if (command === 'search') {
    console.log(JSON.stringify(catalog.search([{ query: values.query ?? '', goal: values.goal }])[0], null, 2));
  } else {
    if (!values.source || !values.output) throw new Error('select requires --source and --output');
    const selection = catalog.select({ source: readMathText(path.resolve(values.source), 256 * 1024),
      task: values.task ? readMathText(path.resolve(values.task), 256 * 1024) : '',
      environmentDigest: catalog.identity.environmentDigest });
    const pack = catalog.materialize(selection);
    if (!pack) throw new Error('No matching library module.');
    const output = path.resolve(values.output), lock = output + '.lock.json';
    if (fs.existsSync(output) || fs.existsSync(lock)) throw new Error('Use new pack and lock output paths.');
    writeMathFrozen(output, canonicalMathJson(pack) + '\n');
    writeMathFrozen(lock, canonicalMathJson(selection) + '\n');
    console.log(JSON.stringify({ output, lock, library: catalog.identity, ...summarizeLibraryPack(pack) }, null, 2));
  }
}
try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : 'math_library_catalog_failed'); process.exitCode = 1;
}
