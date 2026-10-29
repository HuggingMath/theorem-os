import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { leanStatementContextCommands, parseLeanStatementContexts } from '../src/math/leanStatementContext';
import { runLeanProcess } from '../src/math/mathProcess';

it('preserves the exact default context generator while allowing an explicit known-bound omission', () => {
  const roots = [{ id: '__ID__', name: '__ROOT__' }], modules = [{ module: '__MODULE__', file: '__FILE__' }];
  const legacy = leanStatementContextCommands(roots, modules, '__CONTEXT__');
  expect(crypto.createHash('sha256').update(legacy).digest('hex'))
    .toBe('1f86ef6b6b8dac30ac5f7cff87d45d4d2450c4c18f8e9b8bca03cf2e071f34f3');
  expect(leanStatementContextCommands(roots, modules, '__CONTEXT__', { omitOversizedType: false })).toBe(legacy);
  expect(leanStatementContextCommands(roots, modules, '__CONTEXT__', { detailedContext: false })).toBe(legacy);
  expect(crypto.createHash('sha256').update(leanStatementContextCommands(roots, modules, '__CONTEXT__',
    { detailedContext: true })).digest('hex')).toBe('888b7559084615f8a5891a79afc3f151dd730ce64efbf7ebd96e4e5b1d3fdf5f');
  const optional = leanStatementContextCommands(roots, modules, '__CONTEXT__', { omitOversizedType: true });
  expect(optional).toContain('"statement-type-export-bound"');
  expect(optional).not.toContain('then throwError "Statement type exceeds its export bound"');
});

it('parses explicit binder dependencies without requiring them from legacy snapshots', () => {
  const legacy = { type: '∀ {α : Type} [mul : Mul α] (a : α), Eq (HMul.hMul a a) a', constants: [], omitted: [] };
  const bindings = { binders: [
    { id: 'b0', name: 'α', type: 'Type', kind: 'implicit', dependencies: [] },
    { id: 'b1', name: 'mul', type: 'Mul α', kind: 'instanceImplicit', dependencies: ['b0'] },
    { id: 'b2', name: 'a', type: 'α', kind: 'explicit', dependencies: ['b0'] },
  ], conclusion: '@Eq α (@HMul.hMul α α α (@instHMul α mul) a a) a', conclusionDependencies: ['b0', 'b1', 'b2'] };
  const parse = (context: object) => parseLeanStatementContexts(JSON.stringify([{ id: 'scope', context }]), ['scope']).get('scope');
  expect(parse(legacy)).toEqual(legacy);
  expect(parse({ ...legacy, bindings })?.bindings).toEqual(bindings);
  expect(parse({ ...legacy, bindings: { binders: [], conclusion: 'True', conclusionDependencies: [] } })?.bindings?.binders).toEqual([]);

  const invalid = [
    { ...bindings, conclusionDependencies: ['b3'] },
    { ...bindings, conclusionDependencies: ['b1', 'b0'] },
    { ...bindings, conclusionDependencies: ['b0', 'b0'] },
    { ...bindings, conclusion: '' },
    { ...bindings, binders: bindings.binders.map((b, i) => i === 1 ? { ...b, dependencies: ['b1'] } : b) },
    { ...bindings, binders: bindings.binders.map((b, i) => i === 1 ? { ...b, dependencies: ['b2'] } : b) },
    { ...bindings, binders: bindings.binders.map((b, i) => i === 1 ? { ...b, dependencies: ['missing'] } : b) },
    { ...bindings, binders: bindings.binders.map((b, i) => i === 1 ? { ...b, id: 'b0' } : b) },
    { ...bindings, binders: bindings.binders.map((b, i) => i === 1 ? { ...b, kind: 'unknown' } : b) },
  ];
  for (const item of invalid) expect(() => parse({ ...legacy, bindings: item })).toThrow('math_statement_elaboration_invalid');
});

it('keeps known-bound failure reports invalid for the ordinary statement-context parser', () => {
  expect(() => parseLeanStatementContexts(JSON.stringify([{ id: 'wide', context: {
    unavailable: 'statement-type-export-bound', bytes: 24001, limit: 24000,
  } }]), ['wide'])).toThrow('math_statement_elaboration_invalid');
});

const lean = path.join(os.homedir(), '.elan', 'toolchains', 'leanprover--lean4---v4.33.0', 'bin', 'lean');
it.skipIf(!fs.existsSync(lean))('omits only oversized types per root while preserving ordinary contexts and propagating other Lean errors', async () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statement-bound-')));
  try {
    const binder = 'long_' + 'n'.repeat(500), source =
      `theorem longReadable (${binder} : Nat) : ${Array(30).fill(`(${binder} = ${binder})`).join(' ∧ ')} := by simp\n` +
      'theorem small : True := True.intro\n';
    fs.writeFileSync(path.join(directory, 'Submission.lean'), source);
    const input = { cwd: directory, env: { ...process.env, LEAN_PATH: directory }, timeoutMs: Infinity, outputLimit: 1_000_000 };
    const built = await runLeanProcess(lean, ['-o', 'Submission.olean', 'Submission.lean'], input);
    expect(built.exitCode, built.stdout + built.stderr).toBe(0);
    const modules = [{ module: 'Submission', file: 'Submission.lean' }];
    const query = async (file: string, roots: { id: string; name: string }[], output: string, omitOversizedType?: boolean) => {
      fs.writeFileSync(path.join(directory, file), 'import Lean\nimport Submission\n' +
        leanStatementContextCommands(roots, modules, output, { omitOversizedType }) + '\n');
      return runLeanProcess(lean, ['--json', file], input);
    };
    const defaultResult = await query('Default.lean', [{ id: 'wide', name: 'longReadable' }], 'default.json');
    expect(defaultResult.exitCode).not.toBe(0);
    expect(defaultResult.stdout).toContain('Statement type exceeds its export bound');
    expect(fs.existsSync(path.join(directory, 'default.json'))).toBe(false);

    const enabled = await query('Optional.lean', [{ id: 'wide', name: 'longReadable' }, { id: 'small', name: 'small' }], 'optional.json', true);
    expect(enabled.exitCode, enabled.stdout + enabled.stderr).toBe(0);
    const [wide, small] = JSON.parse(fs.readFileSync(path.join(directory, 'optional.json'), 'utf8'));
    expect(wide).toEqual({ id: 'wide', context: { unavailable: 'statement-type-export-bound', bytes: expect.any(Number), limit: 24000 } });
    expect(wide.context.bytes).toBeGreaterThan(24000);
    expect(parseLeanStatementContexts(JSON.stringify([small]), ['small']).get('small')?.type).toBe('True');
    expect(() => parseLeanStatementContexts(JSON.stringify([wide]), ['wide'])).toThrow('math_statement_elaboration_invalid');

    const normal = await query('Small.lean', [{ id: 'small', name: 'small' }], 'small.json');
    expect(normal.exitCode, normal.stdout + normal.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'small.json'), 'utf8'))).toEqual([small]);

    const missing = await query('Missing.lean', [{ id: 'missing', name: 'missingRoot' }], 'missing.json', true);
    expect(missing.exitCode).not.toBe(0); expect(missing.stdout).toContain('missingRoot');
    expect(fs.existsSync(path.join(directory, 'missing.json'))).toBe(false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}, 30000);

for (const version of ['4.8.0', '4.33.0']) {
  const executable = version === '4.8.0' && process.env.THEOREMOS_TEST_LEGACY_ELAN_ROOT
    ? path.join(process.env.THEOREMOS_TEST_LEGACY_ELAN_ROOT, 'bin', 'lean')
    : path.join(os.homedir(), '.elan', 'toolchains', 'leanprover--lean4---v' + version, 'bin', 'lean');
  it.skipIf(!fs.existsSync(executable))(`exports actual instance dependencies and preserves hypothesis scope in Lean ${version}`, async () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statement-bindings-')));
    try {
      fs.writeFileSync(path.join(directory, 'Submission.lean'), [
        'theorem scopedStatement {α : Type} [mul : Mul α] (a : α) (P : α → Prop)',
        '    (h : ∀ b : α, P (a * b)) : P (a * a) := by sorry',
        'theorem closed : True := by sorry',
        'theorem shadowed (n : Nat) (n : Nat) (h : n = n) : n = n := by sorry',
        'theorem strict ⦃α : Type⦄ (x : α) : x = x := by sorry',
      ].join('\n') + '\n');
      const input = { cwd: directory, env: { ...process.env, LEAN_PATH: directory }, timeoutMs: Infinity, outputLimit: 1_000_000 };
      const built = await runLeanProcess(executable, ['-o', 'Submission.olean', 'Submission.lean'], input);
      expect(built.exitCode, built.stdout + built.stderr).toBe(0);
      const roots = ['scopedStatement', 'closed', 'shadowed', 'strict'].map(name => ({ id: name, name }));
      fs.writeFileSync(path.join(directory, 'Context.lean'), 'import Lean\nimport Submission\n' +
        leanStatementContextCommands(roots, [{ module: 'Submission', file: 'Submission.lean' }], 'context.json', { detailedContext: true }) + '\n');
      const queried = await runLeanProcess(executable, ['--json', 'Context.lean'], input);
      expect(queried.exitCode, queried.stdout + queried.stderr).toBe(0);
      const contexts = parseLeanStatementContexts(fs.readFileSync(path.join(directory, 'context.json'), 'utf8'), roots.map(root => root.id));
      const scoped = contexts.get('scopedStatement')!;
      expect(scoped.type).toContain('@HMul.hMul');
      expect(scoped.bindings?.binders.map(binder => ({ id: binder.id, name: binder.name, kind: binder.kind, dependencies: binder.dependencies }))).toEqual([
        { id: 'b0', name: 'α', kind: 'implicit', dependencies: [] },
        { id: 'b1', name: 'mul', kind: 'instanceImplicit', dependencies: ['b0'] },
        { id: 'b2', name: 'a', kind: 'explicit', dependencies: ['b0'] },
        { id: 'b3', name: 'P', kind: 'explicit', dependencies: ['b0'] },
        { id: 'b4', name: 'h', kind: 'explicit', dependencies: ['b0', 'b1', 'b2', 'b3'] },
      ]);
      expect(scoped.bindings?.binders[4]?.type).toContain('∀ (b : α)');
      expect(scoped.bindings?.binders[4]?.type).toContain('mul');
      expect(scoped.bindings?.conclusionDependencies).toEqual(['b0', 'b1', 'b2', 'b3']);
      expect(contexts.get('closed')?.bindings).toEqual({ binders: [], conclusion: 'True', conclusionDependencies: [] });
      expect(contexts.get('shadowed')?.bindings?.binders.map(binder => binder.dependencies)).toEqual([[], [], ['b1']]);
      expect(contexts.get('shadowed')?.bindings?.conclusionDependencies).toEqual(['b1']);
      expect(contexts.get('strict')?.bindings?.binders[0]?.kind).toBe('strictImplicit');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30000);
}
