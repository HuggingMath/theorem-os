import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { leanStatementContextCommands, leanStatementStructuresSchema, parseLeanStatementContexts,
  type LeanStatementStructures } from '../src/math/leanStatementContext';
import { runLeanProcess } from '../src/math/mathProcess';

const structures: LeanStatementStructures = {
  schema: 'theorem-os.lean-statement-structures.v1',
  entries: [{ name: 'Imported.Record', class: false,
    fields: [{ name: 'Imported.Record.item', type: '{α : Type u} → Imported.Record α → α' }] }],
};
const minimal = { type: 'True', constants: [{ name: 'Imported.Record', module: 'Imported', type: 'Type u → Type u' }], omitted: [] };
const parse = (context: object) =>
  parseLeanStatementContexts(JSON.stringify([{ id: 'scope', context }]), ['scope']).get('scope')!;

it('preserves legacy context records and exact query bytes unless structure export is enabled', () => {
  expect(parse(minimal)).toEqual(minimal);
  expect(parse(minimal)).not.toHaveProperty('structures');
  expect(parse({ ...minimal, structures }).structures).toEqual(structures);
  expect(parse({ ...minimal, structures: { schema: structures.schema, entries: [] } }).structures?.entries).toEqual([]);
  const roots = [{ id: 'scope', name: 'Fixture.claim' }], modules = [{ module: 'Submission', file: 'Submission.lean' }];
  const digest = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
  expect(digest(leanStatementContextCommands(roots, modules, 'context.json')))
    .toBe('5cfdaf7f19faa02688cc55f4df334d77a85211ca72a10be3cd381b45df276899');
  expect(digest(leanStatementContextCommands(roots, modules, 'context.json', { detailedContext: true })))
    .toBe('dd5f4d9d5db3c79ca6fb2078c85a8b8fa47109a92ab93c4bc30ebe2769d70701');
  expect(digest(leanStatementContextCommands(roots, modules, 'context.json', { semanticContext: true })))
    .toBe('5cbaba6dd1163a4b107c44ac3faff90422314a3baaa2c396ba6b65d51e4b69e4');
  expect(leanStatementContextCommands(roots, modules, 'context.json', { structureContext: false }))
    .toBe(leanStatementContextCommands(roots, modules, 'context.json'));
  expect(leanStatementContextCommands(roots, modules, 'context.json', { structureContext: true }))
    .toBe(leanStatementContextCommands(roots, modules, 'context.json',
      { detailedContext: true, semanticContext: true, structureContext: true }));
});

it('rejects malformed, extra and duplicate structure or projection metadata', () => {
  const entry = structures.entries[0], field = entry.fields[0];
  const invalid = [
    { ...structures, schema: 'theorem-os.lean-statement-structures.v0' },
    { ...structures, proof: 'True.intro' },
    { ...structures, entries: [entry, entry] },
    { ...structures, entries: [{ ...entry, name: '' }] },
    { ...structures, entries: [{ ...entry, name: 'x'.repeat(1001) }] },
    { ...structures, entries: [{ ...entry, class: 'false' }] },
    { ...structures, entries: [{ ...entry, definition: 'secret value' }] },
    { ...structures, entries: [{ ...entry, fields: [field, field] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, name: '' }] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, name: 'x'.repeat(1001) }] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, type: '' }] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, type: '   \n' }] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, type: 'α → ⋯ → α' }] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, value: 'True.intro' }] }] },
    { ...structures, entries: [{ ...entry, fields: [{ ...field, type: 1 }] }] },
  ];
  for (const value of invalid) {
    expect(leanStatementStructuresSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    expect(() => parse({ ...minimal, structures: value })).toThrow('math_statement_elaboration_invalid');
  }
});

it('requires every structure entry to match a constant actually present in the same context', () => {
  expect(() => parse({ ...minimal, constants: [], structures })).toThrow('math_statement_elaboration_invalid');
  expect(() => parse({ ...minimal, structures: { ...structures,
    entries: [{ ...structures.entries[0], name: 'Imported.record' }] } })).toThrow('math_statement_elaboration_invalid');
  const wide = Array.from({ length: 256 }, (_, index) => ({ name: 'Imported.Record' + index, class: false, fields: [] }));
  const packet = { schema: structures.schema, entries: wide };
  expect(parse({ ...minimal, constants: wide.map(entry => ({ name: entry.name, module: 'Imported', type: 'Type' })),
    structures: packet }).structures?.entries).toHaveLength(256);
  expect(leanStatementStructuresSchema.safeParse({ ...packet, entries: [...wide,
    { name: 'Imported.Record256', class: false, fields: [] }] }).success).toBe(false);
});

it('measures field types and the complete context in UTF-8 bytes without adding a projection-count cap', () => {
  const field = structures.entries[0].fields[0];
  const withType = (type: string) => ({ ...structures, entries: [{ ...structures.entries[0], fields: [{ ...field, type }] }] });
  const permitted = '界'.repeat(2666), oversized = permitted + '界';
  expect(Buffer.byteLength(permitted)).toBe(7998);
  expect(parse({ ...minimal, structures: withType(permitted) }).structures).toEqual(withType(permitted));
  expect(oversized.length).toBeLessThan(8000);
  expect(() => parse({ ...minimal, structures: withType(oversized) })).toThrow('math_statement_elaboration_invalid');
  const manyFields = Array.from({ length: 300 }, (_, index) => ({ name: 'Imported.Record.field' + index, type: 'Nat' }));
  const many = { ...structures, entries: [{ ...structures.entries[0], fields: manyFields }] };
  expect(parse({ ...minimal, structures: many }).structures?.entries[0].fields).toHaveLength(300);
  const large = { ...structures, entries: [{ ...structures.entries[0], fields: Array.from({ length: 40 }, (_, index) =>
    ({ name: 'Imported.Record.field' + index, type: '界'.repeat(2500) })) }] };
  expect(leanStatementStructuresSchema.safeParse(large).success).toBe(true);
  const context = { ...minimal, structures: large };
  expect(Buffer.byteLength(JSON.stringify(context))).toBeGreaterThan(256000);
  expect(() => parse(context)).toThrow('math_statement_elaboration_invalid');
});

for (const version of ['4.8.0', '4.33.0']) {
  const executable = version === '4.8.0'
    ? path.join(process.env.THEOREMOS_TEST_LEGACY_ELAN_ROOT ??
      path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.8.0'), 'bin/lean')
    : path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v' + version, 'bin/lean');
  it(`exports only direct imported structure and Prop-class fields with full types in Lean ${version}`, async () => {
    expect(fs.existsSync(executable), 'Required Lean toolchain: ' + executable).toBe(true);
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'statement-structures-')));
    try {
      const input = { cwd: directory, env: { ...process.env, LEAN_PATH: directory }, timeoutMs: Infinity, outputLimit: 1_000_000 };
      fs.writeFileSync(path.join(directory, 'Imported.lean'), [
        'namespace Imported', 'universe u',
        'structure Record (α : Type u) where', '  item : α', '  marker : Nat',
        'def indexedCarrier (_ : True) : Type := Nat',
        'structure ProofIndexed where', '  value : indexedCarrier True.intro',
        'class Parent (α : Type u) : Prop where', '  witness : Nonempty α',
        'class Child (α : Type u) extends Parent α : Prop where', '  law : True',
        'def secretDefinition : Nat := 81234567',
        'theorem secretProof : True := by exact (fun h : True => h) True.intro',
        'end Imported',
      ].join('\n') + '\n');
      const imported = await runLeanProcess(executable, ['-o', 'Imported.olean', 'Imported.lean'], input);
      expect(imported.exitCode, imported.stdout + imported.stderr).toBe(0);
      fs.writeFileSync(path.join(directory, 'Submission.lean'), [
        'import Imported', 'universe u',
        'structure LocalBox where', '  payload : Nat',
        'theorem importedStatement {α : Type u} (item : Imported.Record α) (proofIndexed : Imported.ProofIndexed) [Imported.Child α] :',
        '    item = item ∧ proofIndexed = proofIndexed ∧ Imported.secretDefinition = Imported.secretDefinition ∧ True := ⟨rfl, rfl, rfl, Imported.secretProof⟩',
        'theorem localStatement (item : LocalBox) : item = item := rfl',
      ].join('\n') + '\n');
      const built = await runLeanProcess(executable, ['-o', 'Submission.olean', 'Submission.lean'], input);
      expect(built.exitCode, built.stdout + built.stderr).toBe(0);
      const modules = [{ module: 'Submission', file: 'Submission.lean' }];
      const roots = [{ id: 'imported', name: 'importedStatement' }];
      fs.writeFileSync(path.join(directory, 'Context.lean'), 'import Lean\nimport Submission\n' +
        leanStatementContextCommands(roots, modules, 'context.json', { structureContext: true }) + '\n');
      const queried = await runLeanProcess(executable, ['--json', 'Context.lean'], input);
      expect(queried.exitCode, queried.stdout + queried.stderr).toBe(0);
      const context = parseLeanStatementContexts(fs.readFileSync(path.join(directory, 'context.json'), 'utf8'), ['imported']).get('imported')!;
      expect(context.bindings).toBeDefined(); expect(context.semantic).toBeDefined();
      const metadata = leanStatementStructuresSchema.parse(context.structures);
      const entries = new Map(metadata.entries.map(entry => [entry.name, entry]));
      expect(entries.get('Imported.Record')).toMatchObject({ class: false });
      expect(entries.get('Imported.Record')!.fields.map(field => field.name))
        .toEqual(['Imported.Record.item', 'Imported.Record.marker']);
      expect(entries.get('Imported.Child')).toMatchObject({ class: true });
      const childFields = entries.get('Imported.Child')!.fields;
      expect(childFields.map(field => field.name)).toEqual(['Imported.Child.toParent', 'Imported.Child.law']);
      expect(childFields.find(field => field.name === 'Imported.Child.toParent')!.type)
        .toMatch(/Imported\.Child.*Imported\.Parent/su);
      expect(childFields.find(field => field.name === 'Imported.Child.law')!.type).toContain('True');
      expect(entries.get('Imported.Record')!.fields[0].type).toContain('Imported.Record');
      expect(entries.get('Imported.Record')!.fields[0].type).toContain('Type');
      expect(entries.get('Imported.Record')!.fields[0].type).toMatch(/→.*α/su);
      const indexedFields = entries.get('Imported.ProofIndexed')!.fields;
      expect(indexedFields).toHaveLength(1);
      expect(indexedFields[0].name).toBe('Imported.ProofIndexed.value');
      expect(indexedFields[0].type).toContain('Imported.indexedCarrier');
      expect(indexedFields[0].type).toContain('True.intro');
      expect(entries.has('Imported.Parent')).toBe(false);
      expect(entries.has('LocalBox')).toBe(false); expect(entries.has('Eq')).toBe(false);
      expect(context.constants.some(item => item.name === 'Imported.secretDefinition')).toBe(true);
      expect(context.constants.some(item => item.name === 'Imported.secretProof')).toBe(false);
      expect(entries.has('Imported.secretDefinition')).toBe(false);
      expect(metadata.entries.every(entry => context.constants.some(item => item.name === entry.name))).toBe(true);
      const serialized = JSON.stringify(metadata);
      expect(serialized).not.toContain('81234567');
      expect(serialized).not.toContain('secretProof'); expect(serialized).not.toContain('⋯');
      for (const entry of metadata.entries) {
        expect(Object.keys(entry).sort()).toEqual(['class', 'fields', 'name']);
        for (const field of entry.fields) expect(Object.keys(field).sort()).toEqual(['name', 'type']);
      }

      // Structure metadata adds no support for previously rejected local inductives.
      fs.writeFileSync(path.join(directory, 'LocalContext.lean'), 'import Lean\nimport Submission\n' +
        leanStatementContextCommands([{ id: 'local', name: 'localStatement' }], modules,
          'local-context.json', { structureContext: true }) + '\n');
      const local = await runLeanProcess(executable, ['--json', 'LocalContext.lean'], input);
      expect(local.exitCode).not.toBe(0);
      expect(local.stdout + local.stderr).toContain('Unsupported local declaration in statement semantic export: LocalBox');
      expect(fs.existsSync(path.join(directory, 'local-context.json'))).toBe(false);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  }, 0);
}
