import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { leanStatementContextCommands, parseLeanStatementContexts } from '../src/math/leanStatementContext';
import { leanStatementSemanticCommands, leanStatementSemanticSchema, type LeanStatementSemantic } from '../src/math/leanStatementSemantic';
import { runLeanProcess } from '../src/math/mathProcess';

const minimal: LeanStatementSemantic = { schema: 'theorem-os.lean-statement-semantic.v1', rawType: 'True',
  kernelType: ['const', ['str', null, 'True'], []], localMeaningClosure: [] };
it('validates canonical nodes exactly and excludes theorem bodies from saved semantic evidence', () => {
  expect(leanStatementSemanticSchema.parse(minimal)).toEqual(minimal);
  const declaration = { name: 'claim', kind: 'theorem', rawType: 'True', type: minimal.kernelType };
  const invalid = [
    { ...minimal, kernelType: ['const', 'True', []] },
    { ...minimal, kernelType: ['nat', 9007199254740993] },
    { ...minimal, kernelType: ['nat', '01'] },
    { ...minimal, kernelType: ['mvar', 'unresolved'] },
    { ...minimal, kernelType: ['bvar', '0', 'unexpected'] },
    { ...minimal, localMeaningClosure: [{ ...declaration, value: minimal.kernelType, rawValue: 'True.intro' }] },
    { ...minimal, localMeaningClosure: [{ ...declaration, kind: 'definition', rawValue: 'True.intro' }] },
    { ...minimal, localMeaningClosure: [declaration, declaration] },
  ];
  for (const value of invalid) expect(leanStatementSemanticSchema.safeParse(value).success).toBe(false);
});

it('validates long application spines in linear time and still rejects every malformed node kind', () => {
  const nat: LeanStatementSemantic['kernelType'] = ['const', ['num', ['str', null, 'Nat'], '0'], [['succ', ['param', '0']]]];
  let spine = nat;
  for (let index = 0; index < 2000; index++)
    spine = index % 3 ? ['app', spine, ['bvar', String(index)]] : ['projection', ['str', null, 'S'], '1', spine];
  const deep = { ...minimal, kernelType: ['forall', 'instanceImplicit', ['sort', ['max', ['zero'], ['param', '1']]],
    ['let', false, spine, ['nat', '3'], ['lam', 'strictImplicit', ['string', ''], spine]]] };
  const started = Date.now();
  expect(leanStatementSemanticSchema.safeParse(deep).success).toBe(true);
  expect(Date.now() - started).toBeLessThan(2000);
  for (const kernelType of [
    ['app', nat], ['app', nat, nat, nat], ['forall', 'default', nat, nat], ['let', 'false', nat, nat, nat],
    ['projection', ['str', null, 'S'], 1, nat], ['const', ['num', null, 'x'], []], ['const', ['str', null, 3], []],
    ['const', null, [['succ']]], ['const', null, [['param', '-1']]], ['sort', ['max', ['zero']]], ['const', null, {}],
    ['app', spine, ['bvar', '01']], ['sort', ['zero', 'extra']], [], null,
  ]) expect(leanStatementSemanticSchema.safeParse({ ...minimal, kernelType }).success).toBe(false);
});

for (const version of ['4.8.0', '4.33.0']) {
  const executable = version === '4.8.0'
    ? path.join(process.env.THEOREMOS_TEST_LEGACY_ELAN_ROOT ??
      path.join(os.homedir(), '.elan', 'toolchains', 'leanprover--lean4---v4.8.0'), 'bin', 'lean')
    : path.join(os.homedir(), '.elan', 'toolchains', 'leanprover--lean4---v' + version, 'bin', 'lean');
  it(`exports canonical kernel meaning, local definitions and chosen instances in Lean ${version}`, async () => {
    expect(fs.existsSync(executable), 'Required Lean toolchain: ' + executable).toBe(true);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statement-semantic-')));
    try {
      const roots = ['alphaA', 'alphaB', 'proofA', 'proofB', 'localStatement', 'viaInstance', 'largeStatement', 'recursiveStatement', 'opaqueStatement']
        .map(name => ({ id: name, name }));
      const query = async (variant: number) => {
        const cwd = path.join(directory, String(variant)); fs.mkdirSync(cwd);
        fs.writeFileSync(path.join(cwd, 'Submission.lean'), [
          'universe u v',
          'theorem alphaA {α : Type u} (x : α) : x = x := rfl',
          'theorem alphaB {β : Type v} (renamed : β) : renamed = renamed := rfl',
          'theorem proofA : True := True.intro',
          'theorem proofB : True := by exact (fun h : True => h) True.intro',
          `def seed : Nat := ${variant + 7}`,
          'def predicate (n : Nat) : Prop := n = seed',
          'def proofValue : True := True.intro',
          'def chosen (_ : True) : Nat := seed',
          'def unused : Nat := 999',
          'theorem localStatement : predicate (chosen proofValue) := rfl',
          'section',
          `local instance selected : HMul Nat Nat Nat := ⟨${variant ? 'Nat.mul' : 'Nat.add'}⟩`,
          'theorem viaInstance (n : Nat) : n * n = n * n := rfl',
          'end',
          'def large : Nat := 9007199254740993',
          'theorem largeStatement : large = large := rfl',
          'def recurse : Nat → Nat | 0 => 0 | n + 1 => recurse n',
          'theorem recursiveStatement (n : Nat) : recurse n = recurse n := rfl',
          'opaque hidden : Nat := 7',
          'theorem opaqueStatement : hidden = hidden := rfl',
        ].join('\n') + '\n');
        const input = { cwd, env: { ...process.env, LEAN_PATH: cwd }, timeoutMs: Infinity, outputLimit: 1_000_000 };
        const built = await runLeanProcess(executable, ['-o', 'Submission.olean', 'Submission.lean'], input);
        expect(built.exitCode, built.stdout + built.stderr).toBe(0);
        fs.writeFileSync(path.join(cwd, 'Context.lean'), 'import Lean\nimport Submission\n' +
          leanStatementContextCommands(roots, [{ module: 'Submission', file: 'Submission.lean' }], 'context.json',
            { detailedContext: true, semanticContext: true }) + '\n');
        const queried = await runLeanProcess(executable, ['--json', 'Context.lean'], input);
        expect(queried.exitCode, queried.stdout + queried.stderr).toBe(0);
        const contexts = parseLeanStatementContexts(fs.readFileSync(path.join(cwd, 'context.json'), 'utf8'), roots.map(root => root.id));
        return new Map([...contexts].map(([id, context]) => {
          expect(context.bindings).toBeDefined();
          return [id, leanStatementSemanticSchema.parse(context.semantic)];
        }));
      };
      const first = await query(0), second = await query(1);
      expect(first.get('alphaA')!.kernelType).toEqual(first.get('alphaB')!.kernelType);
      expect(first.get('proofA')).toEqual(first.get('proofB'));
      expect(first.get('localStatement')!.kernelType).toEqual(second.get('localStatement')!.kernelType);
      const local = first.get('localStatement')!.localMeaningClosure;
      expect(local.map(entry => entry.name)).toEqual(['chosen', 'predicate', 'proofValue', 'seed']);
      expect(local.find(entry => entry.name === 'predicate')!.value).toBeDefined();
      expect(local.find(entry => entry.name === 'proofValue')!.value).toBeUndefined();
      expect(local.find(entry => entry.name === 'chosen')!.rawValue).toContain('seed');
      expect(local.find(entry => entry.name === 'seed')!.value)
        .not.toEqual(second.get('localStatement')!.localMeaningClosure.find(entry => entry.name === 'seed')!.value);
      const chosen = first.get('viaInstance')!;
      expect(JSON.stringify(chosen.kernelType)).toContain('selected');
      expect(chosen.kernelType).toEqual(second.get('viaInstance')!.kernelType);
      expect(chosen.localMeaningClosure.find(entry => entry.name === 'selected')!.value)
        .not.toEqual(second.get('viaInstance')!.localMeaningClosure.find(entry => entry.name === 'selected')!.value);
      expect(JSON.stringify(first.get('largeStatement')!.localMeaningClosure.find(entry => entry.name === 'large')!.value))
        .toContain('["nat","9007199254740993"]');
      const recursive = first.get('recursiveStatement')!.localMeaningClosure;
      expect(recursive.find(entry => entry.name === 'recurse')!.value).toBeDefined();
      expect(recursive.every(entry => entry.kind === 'definition' && entry.value !== undefined)).toBe(true);
      const opaque = first.get('opaqueStatement')!.localMeaningClosure.find(entry => entry.name === 'hidden')!;
      expect(opaque.kind).toBe('opaque'); expect(JSON.stringify(opaque.value)).toContain('["nat","7"]');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 60000);

  it(`preserves structured names and universe operators while ignoring expression metadata in Lean ${version}`, async () => {
    expect(fs.existsSync(executable), 'Required Lean toolchain: ' + executable).toBe(true);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statement-semantic-nodes-')));
    try {
      fs.writeFileSync(path.join(directory, 'Probe.lean'), [
        'import Lean', 'run_cmd Lean.Elab.Command.liftTermElabM do',
        '  let env <- Lean.getEnv', '  let localModules : List String := []',
        ...leanStatementSemanticCommands(),
        '  let first <- semanticExpression [`u] (.forallE `x (.sort (.param `u)) (.bvar 0) .implicit)',
        '  let second <- semanticExpression [`v] (.mdata {} (.forallE `renamed (.sort (.param `v)) (.bvar 0) .implicit))',
        '  unless first.compress == second.compress do throwError "Metadata or display names changed kernel encoding"',
        '  let dotted <- semanticExpression [] (.const (.str .anonymous "A.B") [])',
        '  let nested <- semanticExpression [] (.const (.str (.str .anonymous "A") "B") [])',
        '  if dotted.compress == nested.compress then throwError "Structured names collided"',
        '  let maximum <- semanticLevel [`u, `v] (.max (.param `u) (.param `v))',
        '  let imaximum <- semanticLevel [`u, `v] (.imax (.param `u) (.param `v))',
        '  let expectedMax := Lean.Json.arr #[Lean.toJson "max", Lean.Json.arr #[Lean.toJson "param", Lean.toJson "0"], Lean.Json.arr #[Lean.toJson "param", Lean.toJson "1"]]',
        '  unless maximum.compress == expectedMax.compress do throwError "Universe positions or max order changed"',
        '  if maximum.compress == imaximum.compress then throwError "Universe max and imax collided"',
        '  let application <- semanticExpression [] (.app (.const `function []) (.const `argument []))',
        '  let expectedApp := Lean.Json.arr #[Lean.toJson "app", Lean.Json.arr #[Lean.toJson "const", Lean.Json.arr #[Lean.toJson "str", Lean.Json.null, Lean.toJson "function"], Lean.Json.arr #[]], Lean.Json.arr #[Lean.toJson "const", Lean.Json.arr #[Lean.toJson "str", Lean.Json.null, Lean.toJson "argument"], Lean.Json.arr #[]]]',
        '  unless application.compress == expectedApp.compress do throwError "Application order changed"',
        '  Lean.logInfo "semantic node checks passed"',
      ].join('\n') + '\n');
      const result = await runLeanProcess(executable, ['--json', 'Probe.lean'], { cwd: directory,
        env: process.env, timeoutMs: Infinity, outputLimit: 1_000_000 });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain('semantic node checks passed');
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30000);

  it(`fails explicitly for unsupported local inductives instead of returning incomplete meaning in Lean ${version}`, async () => {
    expect(fs.existsSync(executable), 'Required Lean toolchain: ' + executable).toBe(true);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statement-semantic-unsupported-')));
    try {
      fs.writeFileSync(path.join(directory, 'Submission.lean'),
        'inductive Local where | point\ntheorem unsupported (x : Local) : x = x := rfl\n');
      const input = { cwd: directory, env: { ...process.env, LEAN_PATH: directory }, timeoutMs: Infinity, outputLimit: 1_000_000 };
      const built = await runLeanProcess(executable, ['-o', 'Submission.olean', 'Submission.lean'], input);
      expect(built.exitCode, built.stdout + built.stderr).toBe(0);
      fs.writeFileSync(path.join(directory, 'Context.lean'), 'import Lean\nimport Submission\n' +
        leanStatementContextCommands([{ id: 'unsupported', name: 'unsupported' }], [{ module: 'Submission', file: 'Submission.lean' }],
          'context.json', { detailedContext: true, semanticContext: true }) + '\n');
      const queried = await runLeanProcess(executable, ['--json', 'Context.lean'], input);
      expect(queried.exitCode).not.toBe(0);
      expect(queried.stdout + queried.stderr).toContain('Unsupported local declaration in statement semantic export: Local');
      expect(fs.existsSync(path.join(directory, 'context.json'))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 30000);
}
