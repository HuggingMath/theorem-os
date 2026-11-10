import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { focusFormalizationContext, FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL,
  shareFormalizationContext } from '../src/solver/formalizationContext';

function focusedFixture() {
  const name = (value: string): any => value.split('.').reduce((parent, part) => ['str', parent, part], null as any);
  const constant = (value: string): any => ['const', name(value), []];
  const context = {
    type: 'A local operation with an explicit instance.',
    bindings: { binders: [{ id: 'b0', name: 'x', type: 'Nat', kind: 'explicit', dependencies: [] }],
      conclusion: 'Hidden.mul x x = x', conclusionDependencies: ['b0'] },
    references: { statement: [{ name: 'Hidden.mul', file: 'Formalization.lean' }], proof: [] },
    omitted: ['Pinned.alreadyOmitted'],
    semantic: { schema: 'theorem-os.lean-statement-semantic.v1', rawType: 'Hidden.mul with Pinned.instance',
      kernelType: ['app', constant('Pinned.operation'), ['projection', name('Pinned.Structure'), '0', constant('Pinned.instance')]],
      localMeaningClosure: [{ name: 'Hidden.mul', kind: 'definition', rawType: 'Nat -> Nat -> Nat',
        type: constant('Nat'), rawValue: 'fun x y => Pinned.localOperand x y', value: constant('Pinned.localOperand') }] },
    constants: ['Pinned.operation', 'Pinned.instance', 'Pinned.localOperand', 'Nat', 'Pinned.transitive'].map(value => ({
      name: value, module: 'Pinned', type: 'An exact imported type for ' + value,
      definition: value === 'Pinned.transitive' ? crypto.randomBytes(72 * 1024).toString('base64') : 'exact-value-' + value,
    })),
    structures: { schema: 'theorem-os.lean-statement-structures.v1', entries: [
      { name: 'Pinned.Structure', class: true, fields: [{ name: 'Pinned.Structure.parent', type: 'An exact parent type.' }] },
      { name: 'Pinned.TransitiveStructure', class: false,
        fields: [{ name: 'Pinned.TransitiveStructure.field', type: 'An exact deferred field type.' }] },
    ] },
  };
  const snapshot = { source: 'def Hidden.mul (x y : Nat) := x + y\ntheorem claim : True := by sorry',
    sourceSha256: 'source identity', environment: 'mathlib', environmentDigest: 'pinned environment',
    snapshotDigest: 'snapshot identity', targets: [{ name: 'claim', declarationHash: 'target identity', context }] };
  return { context, snapshot, review: { original: '原题全部结论🙂', header: '', candidate: snapshot.source,
    translation: { mathematics: 'The independent reading.' }, caseId: 'case identity', baseInputDigest: 'input identity',
    observation: { snapshot, snapshotDigest: 'snapshot identity', diagnostics: '', status: 'elaborated' } } };
}

describe('focused formalization reading view', () => {
  it.each(['backtranslate', 'compare'] as const)('preserves all target/local meaning and exact imported lookup positions for %s', role => {
    const fixture = focusedFixture(), input = role === 'backtranslate' ? fixture.snapshot : fixture.review;
    const inputText = canonicalMathJson(input), packet = JSON.parse(focusFormalizationContext(inputText, role)!);
    expect(packet.schema).toBe('theorem-os.formalization-review-context.v3');
    expect(packet.canonicalInputSha256).toBe(mathDigest(inputText));
    const snapshot = role === 'backtranslate' ? packet.input : packet.input.observation.snapshot;
    const focused = snapshot.targets[0].context, imported = focused.importedLibrary;
    for (const key of ['type', 'bindings', 'references', 'omitted', 'semantic'])
      expect(focused[key]).toEqual(fixture.context[key as keyof typeof fixture.context]);
    expect(focused.semantic.localMeaningClosure[0].rawValue).toContain('Pinned.localOperand');
    expect(imported.constants.count).toBe(fixture.context.constants.length);
    expect(imported.structures.count).toBe(fixture.context.structures.entries.length);
    for (const [index, original] of fixture.context.constants.entries()) {
      const position = imported.constants.directEntries.find((entry: any) => entry.index === index);
      if (original.name === 'Pinned.transitive') { expect(position).toBeUndefined(); continue; }
      const entry = packet.libraryCatalog.constants[position.catalogIndex];
      expect(entry.name).toBe(original.name); expect(entry.module).toBe(original.module);
      expect(entry.type).toBe(original.type); expect(entry.definition).toBe(original.definition);
    }
    expect(packet.libraryCatalog.structures[imported.structures.directEntries[0].catalogIndex].fields).toEqual(fixture.context.structures.entries[0].fields);
    expect(imported.structures.directEntries.map((entry: any) => entry.index)).toEqual([0]);
    expect(packet.libraryCatalog.structures.map((entry: any) => entry.name)).not.toContain('Pinned.TransitiveStructure');
    expect(imported.constants.inputPath).toBe((role === 'backtranslate' ? '$' : '$.observation.snapshot') + '.targets[0].context.constants');
    expect(imported.structures.inputPath).toBe((role === 'backtranslate' ? '$' : '$.observation.snapshot') + '.targets[0].context.structures.entries');
    // Rehydrate only the indexed imported collections; every other byte remains the original input.
    const { importedLibrary: _index, ...core } = focused;
    snapshot.targets[0].context = { ...core, constants: fixture.context.constants, structures: fixture.context.structures };
    expect(canonicalMathJson(packet.input)).toBe(inputText);
    expect(canonicalMathJson(input)).toBe(inputText);
    expect(role === 'backtranslate' ? packet.input.original : packet.input.original).toBe(role === 'backtranslate' ? undefined : fixture.review.original);
  });

  it('shares identical imported observations across targets while preserving each original array order', () => {
    const { snapshot, context } = focusedFixture(), second = structuredClone(snapshot.targets[0]);
    second.name = 'second'; second.context.constants.reverse(); second.context.structures.entries.reverse();
    snapshot.targets.push(second);
    const before = canonicalMathJson(snapshot), packet = JSON.parse(focusFormalizationContext(before, 'backtranslate')!);
    const [a, b] = packet.input.targets.map((target: any) => target.context.importedLibrary);
    expect(packet.libraryCatalog.constants).toHaveLength(context.constants.length - 1);
    expect(packet.libraryCatalog.structures).toHaveLength(context.structures.entries.length - 1);
    expect(b.constants.directEntries.map((entry: any) => entry.catalogIndex))
      .toEqual(a.constants.directEntries.map((entry: any) => entry.catalogIndex).reverse());
    for (const [i, target] of packet.input.targets.entries()) {
      const { importedLibrary, ...core } = target.context, original = snapshot.targets[i].context;
      for (const kind of ['constants', 'structures'] as const) {
        const originals = kind === 'constants' ? original.constants : original.structures.entries;
        expect(importedLibrary[kind].count).toBe(originals.length);
        for (const entry of importedLibrary[kind].directEntries)
          expect(packet.libraryCatalog[kind][entry.catalogIndex]).toEqual(originals[entry.index]);
      }
      target.context = { ...core, constants: original.constants, structures: original.structures };
    }
    expect(canonicalMathJson(packet.input)).toBe(before);
    expect(canonicalMathJson(snapshot)).toBe(before);
  });

  it('keeps distinct complete direct observations separate and deferred records bound to the full input', () => {
    const { snapshot } = focusedFixture(), second = structuredClone(snapshot.targets[0]);
    second.name = 'second';
    second.context.constants[0].definition += '-different-direct-value';
    second.context.constants[4].definition += '-different-deferred-value';
    second.context.structures.entries[1].fields[0].type += ' Different deferred field.';
    snapshot.targets.push(second);
    const before = canonicalMathJson(snapshot), packet = JSON.parse(focusFormalizationContext(before, 'backtranslate')!);
    const [a, b] = packet.input.targets.map((target: any) => target.context.importedLibrary);
    const directId = (collection: any) => collection.directEntries.find((entry: any) => entry.index === 0).catalogIndex;
    expect(directId(a.constants)).not.toBe(directId(b.constants));
    expect(packet.libraryCatalog.constants[directId(a.constants)].definition)
      .not.toBe(packet.libraryCatalog.constants[directId(b.constants)].definition);
    expect(packet.canonicalInputSha256).toBe(mathDigest(before));
    expect(packet.libraryCatalog.constants).toHaveLength(5);
    for (const imported of [a, b]) {
      expect(imported.constants.count).toBe(5);
      expect(imported.constants.directEntries.some((entry: any) => entry.index === 4)).toBe(false);
      expect(imported.structures.directEntries.some((entry: any) => entry.index === 1)).toBe(false);
    }
    expect(canonicalMathJson(snapshot)).toBe(before);
  });

  it('retains complete shared records needed directly by a later target without subsequent downgrades', () => {
    const { snapshot } = focusedFixture(), direct = structuredClone(snapshot.targets[0]);
    direct.name = 'direct';
    snapshot.targets[0].context.semantic.kernelType = ['const', ['str', ['str', null, 'Pinned'], 'operation'], []];
    const deferredAgain = structuredClone(snapshot.targets[0]); deferredAgain.name = 'deferredAgain';
    snapshot.targets.push(direct, deferredAgain);
    const packet = JSON.parse(focusFormalizationContext(canonicalMathJson(snapshot), 'backtranslate')!);
    const imports = packet.input.targets.map((target: any) => target.context.importedLibrary);
    const instance = imports[1].constants.directEntries.find((entry: any) => entry.index === 1);
    expect(imports[0].constants.directEntries.some((entry: any) => entry.index === 1)).toBe(false);
    expect(imports[2].constants.directEntries.some((entry: any) => entry.index === 1)).toBe(false);
    expect(packet.libraryCatalog.constants[instance.catalogIndex].definition).toBe('exact-value-Pinned.instance');
    expect(packet.libraryCatalog.structures[imports[1].structures.directEntries[0].catalogIndex].fields)
      .toEqual(direct.context.structures.entries[0].fields);
    expect(imports[0].structures.directEntries).toEqual([]); expect(imports[0].structures.count).toBe(2);
  });

  it.each(['bindings', 'references', 'semantic', 'structures'] as const)('keeps the full-input path without complete %s', missing => {
    const { snapshot } = focusedFixture(); delete (snapshot.targets[0].context as any)[missing];
    expect(focusFormalizationContext(canonicalMathJson(snapshot), 'backtranslate')).toBeUndefined();
  });

  it.each([
    ['num', ['str', null, 'Pinned'], '1'], ['str', ['str', null, 'Pinned'], 'quoted.component'],
    ['str', ['str', null, 'Pinned'], '1bad'], ['str', ['str', null, 'Pinned'], "'bad"],
  ])('keeps unsupported kernel name rendering in the complete-input path', name => {
    const { snapshot } = focusedFixture(); snapshot.targets[0].context.semantic.kernelType = ['const', name, []] as any;
    expect(focusFormalizationContext(canonicalMathJson(snapshot), 'backtranslate')).toBeUndefined();
  });

  it('uses the complete-input path when a kernel name has no exact observed record', () => {
    const { snapshot } = focusedFixture();
    snapshot.targets[0].context.constants = snapshot.targets[0].context.constants.filter(entry => entry.name !== 'Pinned.operation');
    expect(focusFormalizationContext(canonicalMathJson(snapshot), 'backtranslate')).toBeUndefined();
  });

  it.each(['backtranslate', 'compare'] as const)('keeps explicitly omitted direct imports visible without falling back for %s', role => {
    const fixture = focusedFixture(), context = fixture.context;
    context.constants = context.constants.filter(entry => entry.name !== 'Pinned.operation');
    context.structures.entries = context.structures.entries.filter(entry => entry.name !== 'Pinned.Structure');
    context.omitted.push('Pinned.operation', 'Pinned.Structure');
    const input = role === 'backtranslate' ? fixture.snapshot : fixture.review, before = canonicalMathJson(input);
    const packet = JSON.parse(focusFormalizationContext(before, role)!);
    const snapshot = role === 'backtranslate' ? packet.input : packet.input.observation.snapshot;
    const focused = snapshot.targets[0].context, { importedLibrary, ...core } = focused;
    expect(importedLibrary.unavailableDirectNames).toEqual(['Pinned.Structure', 'Pinned.operation']);
    expect(focused.omitted).toEqual(context.omitted);
    expect(focused.semantic).toEqual(context.semantic);
    expect(packet.libraryCatalog.constants.some((entry: any) => entry.name === 'Pinned.operation')).toBe(false);
    expect(packet.libraryCatalog.structures.some((entry: any) => entry.name === 'Pinned.Structure')).toBe(false);
    snapshot.targets[0].context = { ...core, constants: context.constants, structures: context.structures };
    expect(canonicalMathJson(packet.input)).toBe(before);
    expect(packet.canonicalInputSha256).toBe(mathDigest(before));
    expect(canonicalMathJson(input)).toBe(before);
    expect(FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL).toContain('They remain unavailable observations');
    expect(FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL).toContain('Do not treat these names as inspected');
  });

  it('keeps small inputs on the complete-input path and requires imported fact checks without pretending deferred fields are empty', () => {
    expect(focusFormalizationContext(canonicalMathJson({ source: 'small' }), 'backtranslate')).toBeUndefined();
    expect(FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL).toContain('They are deferred, not empty');
    expect(FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL).toContain('Read all fields of a relevant structure');
    expect(FOCUSED_FORMALIZATION_CONTEXT_PROTOCOL).toContain('use unknown if a necessary fact remains unresolved');
  });
});

describe('lossless formalization context transport', () => {
  it('preserves distinct observations, strings, ordering and arbitrary JSON property names', () => {
    const first = { name: 'A', type: '原文🙂 \\n"'.repeat(4000), observations: [true, null, 0, -1, ''] };
    const second = { ...first, name: 'B', type: first.type + ' ' };
    const inputText = canonicalMathJson({
      targets: [first, second, first, second],
      extra: JSON.parse('{"__proto__":{"meaning":"literal property"},"constructor":null}'),
    });
    const packed = JSON.parse(shareFormalizationContext(inputText)!);
    expect(packed.canonicalInputSha256).toBe(mathDigest(inputText));
    expect(packed.dictionary).toHaveLength(2);
    const dictionary: unknown[] = [];
    const decode = (value: any): any => {
      if (Array.isArray(value)) return value.map(decode);
      if (value && typeof value === 'object') {
        if (Object.keys(value).length === 1 && '$ref' in value) {
          expect(Number.isSafeInteger(value.$ref) && value.$ref >= 0 && value.$ref < dictionary.length).toBe(true);
          return dictionary[value.$ref];
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
      }
      return value;
    };
    for (const entry of packed.dictionary) dictionary.push(decode(entry));
    expect(canonicalMathJson(decode(packed.input))).toBe(inputText);
    expect(Buffer.byteLength(JSON.stringify(packed))).toBeLessThan(Buffer.byteLength(inputText) * 0.6);
  });

  it('keeps the raw path for small inputs and large inputs with no useful repetition', () => {
    expect(shareFormalizationContext(canonicalMathJson({ source: '原题🙂' }))).toBeUndefined();
    expect(shareFormalizationContext(canonicalMathJson({ source: crypto.randomBytes(72 * 1024).toString('base64') })))
      .toBeUndefined();
  });

  it('keeps literal reference keys in the raw input rather than reinterpreting them', () => {
    const repeated = 'complete observation '.repeat(5000);
    for (const literal of [{ $ref: 0 }, { $ref: 'literal', other: true }]) {
      const inputText = canonicalMathJson({ literal, values: [repeated, repeated] });
      expect(shareFormalizationContext(inputText)).toBeUndefined();
      expect(JSON.parse(inputText).literal).toEqual(literal);
    }
  });
});
