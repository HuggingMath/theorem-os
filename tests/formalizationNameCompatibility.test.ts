import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FORMALIZATION_NAMES_FILE, prepareFormalizationNameCompatibility, readFormalizationCompatibilityNames,
  unavailableFormalizationNames, type CompatibilityTarget } from '../src/math/formalizationNameCompatibility';
import type { LeanStatementKernelExpr, LeanStatementKernelName } from '../src/math/leanStatementSemantic';
import { mathDigest } from '../src/math/mathRuntimeIo';

const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

const name = (dotted: string): LeanStatementKernelName =>
  dotted.split('.').reduce<LeanStatementKernelName>((parent, part) => ['str', parent, part], null);
const constant = (dotted: string): LeanStatementKernelExpr => ['const', name(dotted), []];
const app = (...items: LeanStatementKernelExpr[]): LeanStatementKernelExpr =>
  items.reduce((fn, arg) => ['app', fn, arg]);
const target = (kernelType: LeanStatementKernelExpr,
  closure: NonNullable<CompatibilityTarget['context']['semantic']>['localMeaningClosure'] = []): CompatibilityTarget =>
  ({ name: 'claim', context: { semantic: { kernelType, localMeaningClosure: closure } } });
const available = new Set(['Group', 'Subgroup', 'Subgroup.center', 'Set.Countable', 'Eq', 'Top.top', 'Subgroup.instTop']);

describe('pinned-library name compatibility', () => {
  it('reports written library names the pinned list lacks and nothing it contains', () => {
    const source = 'theorem claim {G : Type*} [Group G] [IsMulCommutative G] : Subgroup.center G = ⊤ := by sorry\n';
    const type: LeanStatementKernelExpr = ['forall', 'implicit', ['sort', ['succ', ['zero']]], ['forall', 'instanceImplicit',
      app(constant('Group'), ['bvar', '0']), ['forall', 'instanceImplicit', app(constant('IsMulCommutative'), ['bvar', '1']),
        app(constant('Eq'), app(constant('Subgroup.center'), ['bvar', '2']), app(constant('Top.top'), constant('Subgroup.instTopNew')))]]];
    // The elaborator-chosen instance is newer too, but the source never spells it.
    expect(unavailableFormalizationNames(source, [target(type)], available)).toEqual(['IsMulCommutative']);
    expect(unavailableFormalizationNames(source.replace('[IsMulCommutative G] ', ''), [target(type)], available)).toEqual([]);
  });

  it('matches open namespaces and field notation by dotted suffix and ignores comments and strings', () => {
    const type = app(constant('Set.Countable'), constant('LinearIndepOn'));
    expect(unavailableFormalizationNames('theorem claim (S : Set ℕ) : S.Countable ∧ LinearIndepOn := sorry', [target(type)], available))
      .toEqual(['LinearIndepOn']);
    expect(unavailableFormalizationNames('-- LinearIndepOn\n/- LinearIndepOn -/ theorem claim : "LinearIndepOn" = x := sorry',
      [target(type)], available)).toEqual([]);
  });

  it('accepts a renamed declaration written as a short name that resolves through an opened namespace in both releases', () => {
    const names = new Set([...available, 'FiniteDimensional.finrank']);
    const type = app(constant('Eq'), constant('Module.finrank'));
    const header = 'open Fintype FiniteDimensional Module\n';
    expect(unavailableFormalizationNames(header + 'theorem claim : finrank F V = 1 := sorry', [target(type)], names)).toEqual([]);
    // The qualified new name and an unopened short name have no pinned meaning.
    expect(unavailableFormalizationNames(header + 'theorem claim : Module.finrank F V = 1 := sorry', [target(type)], names))
      .toEqual(['Module.finrank']);
    expect(unavailableFormalizationNames('open Module\ntheorem claim : finrank F V = 1 := sorry', [target(type)], names))
      .toEqual(['Module.finrank']);
    expect(unavailableFormalizationNames('open FiniteDimensional (finrank)\nopen Module in\ntheorem claim : finrank F V = 1 := sorry',
      [target(type)], names)).toEqual([]);
    expect(unavailableFormalizationNames('namespace FiniteDimensional.Inner\ntheorem claim : finrank F V = 1 := sorry',
      [target(type)], names)).toEqual([]);
  });

  it('never checks the candidate\'s own declarations or internal and numbered names', () => {
    const local = app(constant('claim.helper'), ['const', ['num', name('Foo'), '1'], []], constant('_private.Bar'));
    expect(unavailableFormalizationNames('def claim.helper := 0\ntheorem claim : helper = Foo := sorry',
      [target(local, [{ name: 'claim.helper', type: constant('NewOnly'), value: constant('Nat') }])], available))
      .toEqual([]);
    expect(() => unavailableFormalizationNames('theorem claim : True := sorry', [{ name: 'claim', context: {} }], available))
      .toThrow('formalization_compatibility_requires_semantic_context');
  });

  it('freezes the list by digest and refuses changed bytes', () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-names-')));
    roots.push(directory);
    const file = path.join(directory, 'names.txt');
    fs.writeFileSync(file, 'Group\nSet.Countable\n\n');
    const { configuration, namesText } = prepareFormalizationNameCompatibility({ namesFile: file, provenance: 'unit fixture 4.8' });
    expect(configuration).toEqual({ schema: 'theorem-os.formalization-name-compatibility.v1', provenance: 'unit fixture 4.8',
      namesSha256: mathDigest('Group\nSet.Countable\n\n'), namesCount: 2 });
    const run = path.join(directory, 'run'); fs.mkdirSync(run);
    fs.writeFileSync(path.join(run, FORMALIZATION_NAMES_FILE), namesText);
    expect([...readFormalizationCompatibilityNames(run, configuration)]).toEqual(['Group', 'Set.Countable']);
    fs.writeFileSync(path.join(run, FORMALIZATION_NAMES_FILE), 'Group\nIsMulCommutative\n');
    expect(() => readFormalizationCompatibilityNames(run, configuration)).toThrow('formalization_compatibility_names_changed');
    fs.writeFileSync(path.join(directory, 'empty.txt'), '\n');
    expect(() => prepareFormalizationNameCompatibility({ namesFile: path.join(directory, 'empty.txt'), provenance: 'x' }))
      .toThrow('formalization_compatibility_names_empty');
  });
});
