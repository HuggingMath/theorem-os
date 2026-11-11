import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { LIBRARY_PACK_SCHEMA } from '../../src/math/libraryPacks';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { writeLibraryCatalog } from '../../src/solver/libraryCatalog';

export const formalizationLibraryLean = path.join(os.homedir(), '.elan/toolchains',
  getLeanTaskEnvironment('standard').toolchain.replace(/[/:]/gu, value => value === '/' ? '--' : '---'), 'bin/lean');

/** Real compiled modules with a dependency, a theorem and a structure; no model or package download. */
export function compiledFormalizationLibrary(root: string, environment: LeanTaskEnvironment = 'standard') {
  fs.mkdirSync(root, { recursive: true });
  const config = getLeanTaskEnvironment(environment);
  const modules = [
    { file: 'Submission/Library/TheoremOS/Environment/Base.lean', source:
      'namespace TheoremOS.Environment\ndef successor (n : Nat) : Nat := n + 1\nend TheoremOS.Environment\n' },
    { file: 'Submission/Library/TheoremOS/Environment/Laws.lean', source:
      'import Submission.Library.TheoremOS.Environment.Base\nnamespace TheoremOS.Environment\n' +
      'structure Witness where\n  value : Nat\ntheorem successor_zero : successor 0 = 1 := by rfl\nend TheoremOS.Environment\n' },
  ].map(module => ({ ...module, origin: { kind: 'upstream' as const, repository: 'theorem-os-library',
    commit: 'a'.repeat(40), file: module.file } }));
  const catalog = writeLibraryCatalog(path.join(root, 'release'), { id: 'example/formalization-environment', revision: 'v1',
    environment, packs: [{ schema: LIBRARY_PACK_SCHEMA, modules }] });
  for (const [file, text] of Object.entries(config.files)) fs.writeFileSync(path.join(root, file), text);
  const build = path.join(root, '.lake/build/lib/lean');
  for (const module of modules) {
    const file = path.join(root, module.file), output = path.join(build, module.file.replace(/\.lean$/u, '.olean'));
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, module.source);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const result = spawnSync(formalizationLibraryLean, ['-j1', '-R', root, '-o', output, file], { cwd: root,
      env: { ...process.env, LEAN_PATH: build }, encoding: 'utf8', timeout: 30_000 });
    if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stdout + result.stderr);
  }
  const buildReceipt = { schema: 'theorem-os.web-library-build.v1', toolchain: config.toolchain,
    ...(config.mathlibRevision ? { mathlibRevision: config.mathlibRevision } : {}), environmentDigest: config.dependencyDigest,
    catalogDigest: catalog.digest, library: { id: catalog.id, revision: catalog.revision,
      catalogDigest: catalog.digest, environmentDigest: config.dependencyDigest },
    catalog: { file: 'release/catalog.json', sha256: catalog.digest }, modules: modules.map(module => ({ file: module.file,
      sourceDigest: mathDigest(module.source),
      oleanDigest: mathDigest(fs.readFileSync(path.join(build, module.file.replace(/\.lean$/u, '.olean')))) })) };
  fs.writeFileSync(path.join(root, 'build-receipt.json'), canonicalMathJson(buildReceipt) + '\n');
  return { root, access: { file: catalog.file, digest: catalog.digest }, build, buildReceipt, modules };
}
