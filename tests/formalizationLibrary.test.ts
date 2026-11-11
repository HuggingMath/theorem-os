import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFormalizationLibraryRelease, snapshotFormalizationLibrary } from '../src/runtime/formalizationLibrary';
import { leanLibraryApiProgram } from '../src/math/leanLibrarySymbolsProgram';
import { compiledFormalizationLibrary, formalizationLibraryLean } from './helpers/formalizationLibraryFixture';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-library-test-')));
  roots.push(root);
  return compiledFormalizationLibrary(path.join(root, 'installed'));
}

describe.skipIf(!fs.existsSync(formalizationLibraryLean))('fixed compiled formalization library release', () => {
  it('checks the receipt and publishes independent source and compiled bytes without unlisted files', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.root, 'HOST_PRIVATE_CANARY'), 'not a library file');
    const release = readFormalizationLibraryRelease(f.access, 'standard');
    const snapshot = path.join(path.dirname(f.root), 'snapshot');
    snapshotFormalizationLibrary(snapshot, release);
    expect(release.modules.map(module => module.import)).toEqual([
      'Submission.Library.TheoremOS.Environment.Base', 'Submission.Library.TheoremOS.Environment.Laws',
    ]);
    expect(fs.existsSync(path.join(snapshot, 'HOST_PRIVATE_CANARY'))).toBe(false);
    const file = f.modules[0].file;
    fs.writeFileSync(path.join(f.root, file), '-- host replacement');
    expect(fs.readFileSync(path.join(snapshot, file), 'utf8')).toBe(f.modules[0].source);
    expect(fs.readFileSync(path.join(snapshot, '.lake/build/lib/lean', file.replace(/\.lean$/u, '.olean'))))
      .toEqual(fs.readFileSync(path.join(f.build, file.replace(/\.lean$/u, '.olean'))));
    expect(() => snapshotFormalizationLibrary(snapshot, release)).toThrow();
  });

  it.each(['source', 'olean', 'receipt', 'configuration', 'catalog'] as const)('rejects changed %s bytes before mounting', kind => {
    const f = fixture(), file = kind === 'source' ? path.join(f.root, f.modules[0].file)
      : kind === 'olean' ? path.join(f.build, f.modules[0].file.replace(/\.lean$/u, '.olean'))
        : kind === 'receipt' ? path.join(f.root, 'build-receipt.json')
          : kind === 'configuration' ? path.join(f.root, 'lean-toolchain') : f.access.file;
    if (kind === 'receipt') {
      f.buildReceipt.modules.pop(); fs.writeFileSync(file, JSON.stringify(f.buildReceipt));
    } else { fs.chmodSync(file, 0o600); fs.appendFileSync(file, '\nchanged'); }
    expect(() => readFormalizationLibraryRelease(f.access, 'standard')).toThrow();
  });

  it('rejects a library release for a different pinned environment', () => {
    const f = fixture();
    expect(() => readFormalizationLibraryRelease(f.access, 'mathlib')).toThrow('formalization_library_environment_changed');
  });
});

describe('library API imports', () => {
  it('preserves the original program when no extra library is requested', () => {
    expect(leanLibraryApiProgram('standard')).toBe(leanLibraryApiProgram('standard', []));
    expect(leanLibraryApiProgram('standard')).not.toContain('import Submission.Library');
  });

  it('deduplicates exact module imports and rejects non-module command text', () => {
    const module = 'Submission.Library.TheoremOS.Environment.Laws';
    expect(leanLibraryApiProgram('standard', [module, module]).split('\n').filter(line => line === 'import ' + module)).toHaveLength(1);
    for (const invalid of ['Mathlib', 'Submission', '../Private', module + '\nrun_cmd IO.println "injected"'])
      expect(() => leanLibraryApiProgram('standard', [invalid])).toThrow('lean_library_api_import_invalid');
  });
});
