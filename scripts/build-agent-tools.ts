#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * The commands an Agent's shell runs, bundled into one directory outside the application: the web worker hides
 * the application tree from Agent shells, so these files are all of the code a shell can read. `--out DIR`.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const index = process.argv.indexOf('--out');
const output = path.resolve(index > 0 ? process.argv[index + 1]! : path.join(root, 'out/agent-tools'));
const agentToolCommands = {
  'check-lean': 'checkLean.ts', 'search-lean': 'searchLean.ts', knowledge: 'theoremKnowledge.ts', library: 'library.ts',
  declarations: 'readDeclarations.ts',
  hub: 'huggingMath.ts',
  'research-observe': 'researchObserve.ts', 'proof-search': 'proofSearch.ts',
  'plan-validate': 'planValidate.ts', 'plan-apply': 'planApply.ts',
  'check-finite': 'checkFinite.ts', 'kernel-certificate': 'kernelCertificate.ts', continuation: 'readContinuation.ts',
} as const;
fs.rmSync(output, { recursive: true, force: true });
const result = await build({
  entryPoints: { math: path.join(root, 'scripts/mathematics/agentTools.ts'),
    ...Object.fromEntries(Object.entries(agentToolCommands).map(([name, file]) => [name, path.join(root, 'scripts/mathematics', file)])) },
  // ESM for the commands' top-level await; bundled CommonJS dependencies still need require for node: modules.
  outdir: output, outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', minify: true, legalComments: 'none', metafile: true,
  banner: { js: "import{createRequire as __agentRequire}from'node:module';const require=__agentRequire(import.meta.url);" },
  loader: { '.py': 'text', '.lean': 'text' }, tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'silent',
});
// Nothing may stay a runtime import: the shell sees no node_modules.
const external = Object.values(result.metafile.outputs).flatMap(item => item.imports.filter(entry => entry.external && !entry.path.startsWith('node:')));
if (external.length) throw new Error(`Agent tools import outside the bundle: ${[...new Set(external.map(entry => entry.path))].join(', ')}`);
console.log(JSON.stringify({ output, files: fs.readdirSync(output).sort() }));
