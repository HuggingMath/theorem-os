import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFixture } from './formalizationFixture';
import { prepareInformalization, type InformalizationPreparation } from '../../src/math/informalization';

// A synthetic two-module proof and a handwritten extraction report for contract tests only, never benchmark evidence.
export const INFORMALIZATION_NONCE = '0123456789abcdef0123456789abcdef';
export const LIB_SOURCE = 'theorem lib_fact (n : Nat) : n + 0 = n := rfl\n';
export const PROOF_SOURCE = ['import Lib', '', '/-- Twice a number. -/', 'def double (n : Nat) : Nat := n + n', '',
  'theorem double_eq (n : Nat) : double n = 2 * n := by', '  unfold double', '  omega', '',
  'theorem double_add_zero (n : Nat) : double (n + 0) = 2 * n := by', '  rw [lib_fact]', '  exact double_eq n', ''].join('\n');
export const presetAuthor = { model: 'preset-informalization', effort: 'none', profile: '/preset-only', executable: '/no-model' };

export function sourceRange(text: string, snippet: string) {
  const start = text.indexOf(snippet);
  if (start < 0) throw new Error('fixture_snippet_missing');
  const before = text.slice(0, start).split('\n'), lines = snippet.split('\n');
  const line = before.length, column = [...before.at(-1)!].length;
  return { line, column, endLine: line + lines.length - 1,
    endColumn: lines.length === 1 ? column + [...snippet].length : [...lines.at(-1)!].length };
}

const unit = (name: string, kind: string, module: string, snippet: string, statementDependencies: string[],
  proofDependencies: string[], external: string[]) => ({ name, displayName: name, kind, module,
  range: sourceRange(module === 'Lib' ? LIB_SOURCE : PROOF_SOURCE, snippet),
  // Lean's signature printer omits the keyword and the doc comment.
  signature: snippet.split(' :=')[0]!.replace(/^\/--.*-\/\n/u, '').replace(/^(?:theorem|def) /u, ''),
  statementDependencies, proofDependencies, external, externalTruncated: false });

/** Target first, so ordering is exercised. */
export function informalizationReport(nonce = INFORMALIZATION_NONCE) {
  return { nonce, target: 'double_add_zero', axioms: ['propext'],
    units: [
      unit('double_add_zero', 'theorem', 'Proof', 'theorem double_add_zero (n : Nat) : double (n + 0) = 2 * n := by\n  rw [lib_fact]\n  exact double_eq n',
        ['double'], ['double', 'double_eq', 'lib_fact'], ['Eq.mpr', 'Nat']),
      unit('double_eq', 'theorem', 'Proof', 'theorem double_eq (n : Nat) : double n = 2 * n := by\n  unfold double\n  omega',
        ['double'], ['double'], ['Nat.two_mul', 'Lean.Omega.LinearCombo.eval', 'Eq']),
      unit('double', 'definition', 'Proof', '/-- Twice a number. -/\ndef double (n : Nat) : Nat := n + n', [], [], ['HAdd.hAdd', 'Nat']),
      unit('lib_fact', 'theorem', 'Lib', 'theorem lib_fact (n : Nat) : n + 0 = n := rfl', [], [], ['rfl', 'Nat']),
    ],
    library: [
      { name: 'Nat.two_mul', kind: 'theorem', module: 'Init.Data.Nat.Basic', signature: 'theorem Nat.two_mul (n : Nat) : 2 * n = n + n' },
      { name: 'Lean.Omega.LinearCombo.eval', kind: 'definition', module: 'Init.Omega.LinearCombo', signature: 'def Lean.Omega.LinearCombo.eval' },
    ], libraryTruncated: false };
}
export const informalizationSources = () => [{ module: 'Lib', file: 'Lib.lean', text: LIB_SOURCE },
  { module: 'Proof', file: 'Proof.lean', text: PROOF_SOURCE }];

export function informalizationFixture(roots: string[], overrides: Partial<InformalizationPreparation> = {},
  files: Record<string, string> = { 'Lib.lean': LIB_SOURCE, 'Proof.lean': PROOF_SOURCE }) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'informalization-'))); roots.push(base);
  const { root, manifest } = buildFixture(base), project = path.join(base, 'project');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(project, name)), { recursive: true }); fs.writeFileSync(path.join(project, name), text);
  }
  const directory = path.join(base, 'run');
  const preparation: InformalizationPreparation = { proofId: 'synthetic_double', proofFile: path.join(project, 'Proof.lean'),
    projectRoot: project, target: 'double_add_zero', environment: 'standard', statement: 'Show that double (n + 0) is 2n.',
    language: 'zh', writer: presetAuthor, auditors: [{ ...presetAuthor, id: 'auditor-1' }, { ...presetAuthor, id: 'auditor-2' }],
    batching: { maxUnits: 2, maxSourceBytes: 60_000 }, maxRoundsPerBatch: 3, maxRunSeconds: 0, maxTurnSeconds: 0,
    maxCompileSeconds: 0, maxTotalTokens: 0, buildManifestRef: manifest, ...overrides };
  return { base, root, project, directory, preparation, prepare: () => prepareInformalization(directory, preparation) };
}
