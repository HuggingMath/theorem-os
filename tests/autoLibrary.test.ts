import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { autoLibraryPackFor, autoLibraryTheorems, autoLibraryUsage, inspectAutoLibrarySource, libraryImportClosure,
  parseAutoLibraryRecord, publishAutoLibraryRecord, readAutoLibraryPool, reserveAutoLibraryName, takenAutoLibraryNames,
  withAutoLibraryHeader, AUTO_LIBRARY_RECORD_SCHEMA, type AutoLibraryRecord } from '../src/math/autoLibrary';
import { autoLibraryLeanFeedback, autoLibraryPlanJsonSchema, autoLibraryPlannerInput, autoLibraryPlanProblems,
  autoLibraryRejectionFeedback } from '../src/math/autoLibraryPlanner';
import { LIBRARY_PACK_SCHEMA, parseLibraryPack, type LibraryPack } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { temporaryDirectory } from './helpers/files';
import { readAutoLibraryState } from '../src/solver/autoLibrary';

const QUADRUPLE = ['import Submission.Library.Fixture.Double', '', 'open Fixture', '', 'namespace TheoremOS.Auto.Quadruple', '',
  '/-- Four times a number. -/', 'def quadruple (n : Nat) : Nat := double (double n)', '',
  'theorem quadruple_eq (n : Nat) : quadruple n = 4 * n := by', '  sorry', '',
  'theorem quadruple_add (m n : Nat) : quadruple (m + n) = quadruple m + quadruple n := by', '  sorry', '',
  'end TheoremOS.Auto.Quadruple', ''].join('\n');
const libraryModules = new Set(['Submission.Library.Fixture.Double']);
const gate = (source: string, options: { name?: string; allowSorry?: boolean } = {}) =>
  inspectAutoLibrarySource({ name: options.name ?? 'Quadruple', source, libraryModules, allowSorry: options.allowSorry ?? true });
/** A module body inside the Quadruple namespace. */
const inside = (...body: string[]) => ['namespace TheoremOS.Auto.Quadruple', ...body, 'theorem t : True := trivial',
  'end TheoremOS.Auto.Quadruple', ''].join('\n');

describe('auto-library module gate', () => {
  it('accepts a spec with theorem gaps and the proved module without them', () => {
    expect(gate(QUADRUPLE)).toEqual([]);
    expect(gate(QUADRUPLE, { allowSorry: false })).toEqual(['line 11: sorry is not allowed here']);
    expect(gate(QUADRUPLE.replaceAll('  sorry', '  omega'), { allowSorry: false })).toEqual([]);
    expect(autoLibraryTheorems(QUADRUPLE)).toEqual(['TheoremOS.Auto.Quadruple.quadruple_eq', 'TheoremOS.Auto.Quadruple.quadruple_add']);
    // Comments and strings may mention the forbidden words.
    expect(gate(inside('/-- Not by `native_decide` or `axiom`. -/', 'def label : String := "sorry"'))).toEqual([]);
  });

  it('allows gaps only in theorem bodies', () => {
    expect(gate(inside('def gap : Nat := sorry'))).toEqual(['line 2: sorry is not allowed here']);
    expect(gate(inside('theorem bad (h : (sorry : Prop)) : True := trivial'))).toEqual(['line 2: sorry is not allowed here']);
    for (const [line, token] of [['theorem n : 2 = 2 := by native_decide', 'native_decide'], ['axiom ax : False', 'axiom'],
      ['unsafe def u : Nat := 0', 'unsafe'], ['#eval 1', '#eval'], ['run_cmd pure ()', 'run_cmd']])
      expect(gate(inside(line!)), line).toContain(`line 2: ${token} is not allowed`);
  });

  it('keeps declarations and commands inside the module namespace', () => {
    expect(gate('theorem t : True := trivial\n')).toEqual(['line 1: declarations and commands must be inside namespace TheoremOS.Auto.Quadruple']);
    expect(gate('namespace TheoremOS.Auto.QuadrupleX\ntheorem t : True := trivial\nend TheoremOS.Auto.QuadrupleX\n'))
      .toEqual(['line 2: declarations and commands must be inside namespace TheoremOS.Auto.Quadruple']);
    expect(gate('namespace TheoremOS\nnamespace Auto.Quadruple\nnamespace Inner\ntheorem t : True := trivial\nend Inner\n' +
      'end Auto.Quadruple\nend TheoremOS\n')).toEqual([]);
    expect(gate(`${inside()}theorem late : True := trivial\n`)).toEqual(['line 4: declarations and commands must be inside namespace TheoremOS.Auto.Quadruple']);
    expect(gate('namespace TheoremOS.Auto.Quadruple theorem t : True := trivial\nend TheoremOS.Auto.Quadruple\n'))
      .toContain('line 1: write namespace commands on their own line');
    expect(gate('mutual\ntheorem a : True := trivial\nend\n')).toContain('line 1: mutual blocks must be inside namespace TheoremOS.Auto.Quadruple');
    expect(gate(inside('theorem _root_.escape : True := trivial'))).toContain('`_root_` is not allowed');
    expect(gate('open Fixture\nset_option maxHeartbeats 400000\nuniverse u\n' + inside())).toEqual([]);
  });

  it('rejects global syntax, attributes and environment extensions', () => {
    for (const [line, problem] of [['notation "dbl" => Fixture.double', 'notation must be local or scoped'],
      ['infixl:65 " +++ " => Nat.add', 'infixl must be local or scoped'], ['macro "go" : tactic => `(tactic| rfl)', 'macro must be local or scoped'],
      ['attribute [simp] Nat.add_comm', 'an attribute command must be local or scoped'],
      ['attribute [local simp, ext] Nat.add_comm', 'an attribute command must be local or scoped'],
      ['elab "go" : tactic => pure ()', 'elab is not allowed in a library module'],
      ['initialize counter : IO.Ref Nat ← IO.mkRef 0', 'initialize is not allowed in a library module'],
      ['register_simp_attr my_simp', 'register_simp_attr is not allowed in a library module']])
      expect(gate(inside(line!)), line).toContain(`line 2: ${problem}`);
    for (const line of ['local notation "dbl" => Fixture.double', 'scoped infixl:65 " +++ " => Nat.add',
      'attribute [local simp] Nat.add_comm', 'attribute [scoped simp] Nat.add_comm', '@[simp] theorem s : 1 + 1 = 2 := rfl'])
      expect(gate(inside(line)), line).toEqual([]);
  });

  it('checks imports, names, size and text', () => {
    expect(gate(`import Submission.Library.Auto.Quadruple\n${inside()}`)).toEqual(['line 1: the module imports itself']);
    expect(gate(`import Challenge\nimport Submission.Helpers\nimport Mathlib.Tactic.Lemma\n${inside()}`))
      .toEqual(['line 1: import Challenge is not an available library module', 'line 2: import Submission.Helpers is not an available library module']);
    expect(gate(inside('def only : Nat := 0').replace('theorem t : True := trivial\n', ''))).toEqual(['the module states no theorem or lemma']);
    expect(gate(inside('theorem t : True := trivial', 'namespace Inner', 'theorem t : True := trivial', 'end Inner')))
      .toEqual(['declaration names repeat their final component: t']);
    expect(gate(inside(), { name: 'lower' })).toEqual(['module name must match ^[A-Z][A-Za-z0-9]{2,47}$']);
    expect(gate(inside('-- \u0007'))).toEqual(['source must be UTF-8 text without control characters']);
    expect(gate(`${inside()}${'-- x\n'.repeat(40_000)}`)).toEqual(['source is larger than 131072 bytes']);
  });
});

describe('auto-library module header', () => {
  it('goes after the imports and keeps the summary inside the comment', () => {
    const proved = QUADRUPLE.replaceAll('  sorry', '  omega');
    const source = withAutoLibraryHeader(proved, { name: 'Quadruple', summary: 'Closes -/ early /- maybe', sources: ['Peano'] });
    expect(source.split('\n').slice(0, 4)).toEqual(['import Submission.Library.Fixture.Double', '', '/-! # TheoremOS auto-library module `Quadruple`', '']);
    expect(source).toContain('\nCloses - / early / - maybe\n\nSources:\n* Peano\n');
    expect(source.slice(source.indexOf(' -/\n') + 4)).toBe(proved.slice(proved.indexOf('\n') + 1));
    // The provenance text must not trip a search for gaps in published modules.
    expect(/sorry/u.test(source)).toBe(false);
    expect(gate(source, { allowSorry: false })).toEqual([]);
    expect(withAutoLibraryHeader(inside(), { name: 'Quadruple', summary: 'S', sources: [] }))
      .toMatch(/^\/-! # TheoremOS auto-library module `Quadruple`\n\nS\n\nWritten by[^]*-\/\nnamespace TheoremOS\.Auto\.Quadruple\n/u);
  });
});

const DOUBLE = 'namespace Fixture\ndef double (n : Nat) : Nat := n + n\ntheorem double_eq (n : Nat) : double n = 2 * n := by\n  unfold double; omega\nend Fixture\n';
const DOUBLE_FILE = 'Submission/Library/Fixture/Double.lean';
const base = (): LibraryPack => parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: [{ file: DOUBLE_FILE, source: DOUBLE,
  origin: { kind: 'upstream', repository: 'fixture', commit: 'a'.repeat(40), file: 'Double.lean' } }] });
const ENVIRONMENT = 'e'.repeat(64);
const BUILD = '0f2d05e8-5d78-402b-b74e-3f0936f8e8b2', OTHER_BUILD = '6a1c3f0e-2b7d-4e51-9c8a-1f0e2d3c4b5a';
function record(name: string, source: string, overrides: Partial<AutoLibraryRecord> = {}): AutoLibraryRecord {
  return parseAutoLibraryRecord({ schema: AUTO_LIBRARY_RECORD_SCHEMA, name, file: `Submission/Library/Auto/${name}.lean`, source,
    sourceDigest: mathDigest(source), summary: `${name} fixture`, sources: [], theorems: autoLibraryTheorems(source),
    requires: [{ file: DOUBLE_FILE, digest: mathDigest(DOUBLE) }], visible: [DOUBLE_FILE], environment: { id: 'standard', digest: ENVIRONMENT },
    trigger: { challengeId: `fixture/${name}`, challengeDigest: 'c'.repeat(64), taskDigest: 'd'.repeat(64) },
    cost: { plannerTokens: 1200, proverTokens: 34000, wallMs: 5000, rounds: 2 }, planner: { model: 'm', effort: 'max' },
    prover: { runId: `run-${name}`, commit: 'b'.repeat(40), model: 'm', dropped: [] }, buildId: BUILD, buildDigest: 'f'.repeat(64),
    publishedAt: '2026-11-01T12:00:00.000Z', ...overrides });
}
const PROVED = withAutoLibraryHeader(QUADRUPLE.replaceAll('  sorry', '  unfold quadruple double; omega'), { name: 'Quadruple', summary: 'Q', sources: [] });
const OCTUPLE = ['import Submission.Library.Auto.Quadruple', 'namespace TheoremOS.Auto.Octuple',
  'def octuple (n : Nat) : Nat := TheoremOS.Auto.Quadruple.quadruple n + TheoremOS.Auto.Quadruple.quadruple n',
  'theorem octuple_eq (n : Nat) : octuple n = 8 * n := by', '  unfold octuple; rw [TheoremOS.Auto.Quadruple.quadruple_eq]; omega',
  'end TheoremOS.Auto.Octuple', ''].join('\n');

describe('auto-library pool', () => {
  let directory: string, pool: string;
  beforeEach(() => { directory = temporaryDirectory('auto-library-pool-'); pool = path.join(directory, 'pool'); });
  afterEach(() => {
    for (const file of fs.existsSync(path.join(pool, 'modules')) ? fs.readdirSync(path.join(pool, 'modules')) : [])
      fs.chmodSync(path.join(pool, 'modules', file), 0o600);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('reserves names per build, case-insensitively, and publishes each record once', async () => {
    expect(readAutoLibraryPool(pool)).toEqual([]);
    expect(await reserveAutoLibraryName(pool, 'Quadruple', BUILD)).toBe(true);
    expect(await reserveAutoLibraryName(pool, 'Quadruple', BUILD)).toBe(true);
    expect(await reserveAutoLibraryName(pool, 'QUADRUPLE', OTHER_BUILD)).toBe(false);
    expect(await reserveAutoLibraryName(pool, 'lower', BUILD)).toBe(false);
    expect(takenAutoLibraryNames(pool, BUILD)).toEqual([]);
    expect(takenAutoLibraryNames(pool, OTHER_BUILD)).toEqual(['Quadruple']);

    const published = record('Quadruple', PROVED);
    await expect(publishAutoLibraryRecord(pool, record('Quadruple', PROVED, { buildId: OTHER_BUILD })))
      .rejects.toThrow('auto_library_reservation_missing: Quadruple');
    await publishAutoLibraryRecord(pool, published);
    await publishAutoLibraryRecord(pool, published);
    await expect(publishAutoLibraryRecord(pool, record('Quadruple', PROVED, { publishedAt: '2026-11-01T13:00:00.000Z' })))
      .rejects.toThrow('auto_library_name_taken: Quadruple');
    expect(fs.statSync(path.join(pool, 'modules', 'Quadruple.json')).mode & 0o777).toBe(0o400);
    expect(readAutoLibraryPool(pool)).toEqual([published]);
    expect(takenAutoLibraryNames(pool, BUILD)).toEqual(['Quadruple']);
    expect(await reserveAutoLibraryName(pool, 'Quadruple', BUILD)).toBe(false);
  });

  it('refuses records whose bytes or file do not match and stops on a corrupt pool', () => {
    expect(() => record('Quadruple', PROVED, { sourceDigest: '0'.repeat(64) })).toThrow('auto_library_record_invalid: sourceDigest does not match the source');
    expect(() => record('Quadruple', PROVED, { file: 'Submission/Library/Auto/Other.lean' })).toThrow('file does not match the name');
    fs.mkdirSync(path.join(pool, 'modules'), { recursive: true });
    fs.writeFileSync(path.join(pool, 'modules', 'Quadruple.json'), JSON.stringify({ ...record('Quadruple', PROVED), name: 'Octuple' }));
    expect(() => readAutoLibraryPool(pool)).toThrow('auto_library_record_invalid');
  });
});

describe('auto-library destination packs and usage', () => {
  const quadruple = record('Quadruple', PROVED);
  const octuple = record('Octuple', OCTUPLE, { publishedAt: '2026-11-01T12:30:00.000Z',
    requires: [{ file: DOUBLE_FILE, digest: mathDigest(DOUBLE) }, { file: quadruple.file, digest: quadruple.sourceDigest }],
    visible: [quadruple.file, DOUBLE_FILE] });
  const SPARE = 'namespace TheoremOS.Auto.Spare\ntheorem spare : True := trivial\nend TheoremOS.Auto.Spare\n';
  const elsewhere = record('Elsewhere', SPARE.replaceAll('Spare', 'Elsewhere'), { environment: { id: 'mathlib', digest: '9'.repeat(64) } });
  const stale = record('Stale', SPARE.replaceAll('Spare', 'Stale'), { requires: [{ file: DOUBLE_FILE, digest: '0'.repeat(64) }] });
  const clash = record('Clash', SPARE.replaceAll('Spare', 'Clash'));
  const challenge = 'namespace TheoremOS.Auto.Clash\ntheorem spare : True := trivial\nend TheoremOS.Auto.Clash\n\ntheorem target : True := by\n  sorry\n';

  it('adds records built for the same environment whose requirements and names fit, in publication order', () => {
    const records = [quadruple, octuple, elsewhere, stale, clash];
    const result = autoLibraryPackFor({ base: base(), records, environmentDigest: ENVIRONMENT, challengeSource: challenge });
    expect(result.included).toEqual(['Quadruple', 'Octuple']);
    expect(result.skipped).toEqual([{ name: 'Elsewhere', reason: 'environment' }, { name: 'Stale', reason: 'requirement_missing' },
      { name: 'Clash', reason: 'declaration_conflict' }]);
    expect(result.pack!.modules.map(module => module.file)).toEqual([DOUBLE_FILE, quadruple.file, octuple.file]);
    expect(result.pack!.modules[1]).toEqual({ file: quadruple.file, source: PROVED,
      origin: { kind: 'run', runId: 'run-Quadruple', commit: 'b'.repeat(40), file: 'Submission.lean' } });
    // A record never joins before the module it requires, and an installed file is not replaced.
    expect(autoLibraryPackFor({ base: base(), records: [octuple, quadruple], environmentDigest: ENVIRONMENT, challengeSource: challenge }))
      .toMatchObject({ included: ['Quadruple'], skipped: [{ name: 'Octuple', reason: 'requirement_missing' }] });
    expect(autoLibraryPackFor({ base: result.pack, records: [quadruple], environmentDigest: ENVIRONMENT, challengeSource: challenge }))
      .toEqual({ pack: result.pack, included: [], skipped: [{ name: 'Quadruple', reason: 'file_present' }] });
    expect(autoLibraryPackFor({ records: [quadruple], environmentDigest: ENVIRONMENT, challengeSource: challenge }))
      .toEqual({ pack: undefined, included: [], skipped: [{ name: 'Quadruple', reason: 'requirement_missing' }] });
  });

  it('skips a record whose build saw a library file this problem does not install, and records built on it', () => {
    // Built where the hand module Hidden was installed; it imports only Double but may restate Hidden.
    const hidden = 'Submission/Library/Fixture/Hidden.lean';
    const saw = record('Saw', SPARE.replaceAll('Spare', 'Saw'), { visible: [DOUBLE_FILE, hidden] });
    const later = record('Later', SPARE.replaceAll('Spare', 'Later'), { publishedAt: '2026-11-01T12:40:00.000Z',
      visible: [saw.file, DOUBLE_FILE, hidden].sort() });
    const withHidden = parseLibraryPack({ schema: LIBRARY_PACK_SCHEMA, modules: [...base().modules, { file: hidden,
      source: 'namespace Fixture.Hidden\ntheorem hidden : True := trivial\nend Fixture.Hidden\n',
      origin: { kind: 'upstream', repository: 'fixture', commit: 'a'.repeat(40), file: 'Hidden.lean' } }] });
    expect(autoLibraryPackFor({ base: base(), records: [quadruple, saw, later], environmentDigest: ENVIRONMENT, challengeSource: challenge }))
      .toMatchObject({ included: ['Quadruple'], skipped: [{ name: 'Saw', reason: 'visibility' }, { name: 'Later', reason: 'visibility' }] });
    expect(autoLibraryPackFor({ base: withHidden, records: [quadruple, saw, later], environmentDigest: ENVIRONMENT, challengeSource: challenge }))
      .toMatchObject({ included: ['Quadruple', 'Saw', 'Later'], skipped: [] });
    expect(() => record('Saw', SPARE.replaceAll('Spare', 'Saw'), { visible: [hidden, DOUBLE_FILE] })).toThrow('visible must be sorted');
    expect(() => record('Saw', SPARE.replaceAll('Spare', 'Saw'), { visible: [DOUBLE_FILE, DOUBLE_FILE] })).toThrow('visible must be sorted');
    expect(() => record('Saw', SPARE.replaceAll('Spare', 'Saw'), { visible: [saw.file, DOUBLE_FILE] })).toThrow('exclude the module itself');
    expect(() => record('Saw', SPARE.replaceAll('Spare', 'Saw'), { visible: [] })).toThrow('visible must contain every required file');
  });

  it('reports the pool modules a solution reaches, which it imports directly and which theorems it names', () => {
    const pack = autoLibraryPackFor({ base: base(), records: [quadruple, octuple], environmentDigest: ENVIRONMENT, challengeSource: challenge }).pack;
    const solution = ['import Submission.Library.Auto.Octuple', 'open TheoremOS.Auto.Quadruple', '-- quadruple_add is not used',
      'theorem target (n : Nat) : quadruple n + quadruple n = 8 * n := by', '  rw [quadruple_eq, Other.quadruple_add]; omega', ''].join('\n');
    expect(libraryImportClosure(pack, solution)).toEqual([DOUBLE_FILE, quadruple.file, octuple.file].sort());
    expect(libraryImportClosure(pack, 'theorem t : True := trivial\n')).toEqual([]);
    expect(autoLibraryUsage({ records: [quadruple, octuple, elsewhere], pack, source: solution })).toEqual([
      { name: 'Quadruple', file: quadruple.file, direct: false, mentioned: ['TheoremOS.Auto.Quadruple.quadruple_eq'],
        trigger: quadruple.trigger, cost: quadruple.cost },
      { name: 'Octuple', file: octuple.file, direct: true, mentioned: [], trigger: octuple.trigger, cost: octuple.cost }]);
  });
});

describe('auto-library planner contract', () => {
  const input = autoLibraryPlannerInput({ challengeId: 'fixture/q', challenge: 'theorem target : True := by\n  sorry\n', task: '',
    environment: 'standard', library: [], taken: ['Taken'], module: 0, round: 1, maxRounds: 3 });
  const plan = { inputDigest: input.inputDigest, decision: 'module', reason: 'Quadrupling recurs.', name: 'Quadruple',
    summary: 'Quadrupling.', sources: ['Peano'], lean: QUADRUPLE, target: 'target',
    application: 'Use TheoremOS.Auto.Quadruple.quadruple_eq for the consumer.', remaining: ['Adapt its hypothesis'] };
  const problems = (value: unknown) => autoLibraryPlanProblems(value, { inputDigest: input.inputDigest, taken: input.takenNames,
    challenge: input.challenge.source, libraryModules });

  it('exports a strict role guide for the optional host application report', () => {
    const schema = autoLibraryPlanJsonSchema();
    expect(schema.required).toContain('consumerApplication');
    const application = schema.properties!.consumerApplication.anyOf![0]!.properties!.application;
    expect(application.required).toEqual(['expression', 'expectedType', 'context', 'remainingGoals']);
    expect(application.additionalProperties).toBe(false);
    expect(schema.properties!.consumerApplication.anyOf![1]).toEqual({ type: 'null', const: null });
  });

  it('binds the output to its input and checks each decision', () => {
    expect(autoLibraryPlannerInput({ challengeId: 'fixture/q', challenge: 'theorem target : True := by\n  sorry\n', task: '',
      environment: 'standard', library: [], taken: ['Taken'], module: 0, round: 1, maxRounds: 3 }).inputDigest).toBe(input.inputDigest);
    expect(autoLibraryPlannerInput({ challengeId: 'fixture/q', challenge: 'theorem target : True := by\n  sorry\n', task: '',
      environment: 'standard', library: [], taken: ['Taken'], module: 0, round: 2, maxRounds: 3, feedback: 'x' }).inputDigest).not.toBe(input.inputDigest);
    expect(problems(plan)).toEqual([]);
    expect(problems({ ...plan, decision: 'none', name: null, summary: null, sources: null, lean: null,
      target: null, application: null, remaining: null })).toEqual([]);
    expect(problems({ ...plan, inputDigest: '0'.repeat(64) })).toEqual(['inputDigest must be copied from INPUT.json']);
    expect(problems({ ...plan, decision: 'none' })).toEqual(['decision none requires name, summary, sources, lean, target, application and remaining to be null']);
    expect(problems({ ...plan, lean: null })).toEqual(['decision module requires name, summary, sources, lean, target, application and remaining']);
    expect(problems({ ...plan, target: 'other' })).toEqual(['target must name a theorem or explicit definition target in INPUT.challenge.source']);
    expect(problems({ ...plan, application: 'Unrelated assertion' })).toEqual(['application must name a theorem stated in the proposed module']);
    expect(problems({ ...plan, consumerApplication: { declaration: 'Other.lemma', application: {
      expression: 'trivial', expectedType: 'True', context: { file: 'Submission.lean', declaration: 'target' },
    } } })).toEqual(['consumerApplication must name a stated module theorem and the selected original target context']);
    expect(problems({ ...plan, name: 'TAKEN' })).toEqual(['name TAKEN is taken; choose another']);
    expect(problems({ ...plan, name: 'lower' })[0]).toMatch(/^name: /u);
    expect(problems({ ...plan, extra: 1 })[0]).toMatch(/^output: /u);
    expect(problems({ ...plan, lean: QUADRUPLE.replace('open Fixture', 'notation "dbl" => Fixture.double') }))
      .toEqual(['line 3: notation must be local or scoped', 'line 3: declarations and commands must be inside namespace TheoremOS.Auto.Quadruple']);
  });

  it('accepts an explicit construction target without promoting frozen definitions to goals', () => {
    const challenge = 'namespace Example\ndef frozen : Nat := 1\ndef witness : Nat := by sorry\nend Example\n';
    const query = { inputDigest: input.inputDigest, taken: input.takenNames, challenge, libraryModules,
      definitionTargets: ['Example.witness'] };
    expect(autoLibraryPlanProblems({ ...plan, target: 'Example.witness' }, query)).toEqual([]);
    expect(autoLibraryPlanProblems({ ...plan, target: 'Example.frozen' }, query)).toEqual([
      'target must name a theorem or explicit definition target in INPUT.challenge.source']);
    const withDefinitions = autoLibraryPlannerInput({ challengeId: 'fixture/construction', challenge, task: '', environment: 'standard',
      library: [], taken: [], module: 0, round: 1, maxRounds: 1, definitionTargets: ['Example.witness'] });
    expect(withDefinitions.challenge.definitionTargets).toEqual(['Example.witness']);
  });

  it('reads saved legacy plans while keeping new submissions subject to the current contract', () => {
    const directory = temporaryDirectory('auto-library-legacy-');
    try {
      const { target: _target, application: _application, remaining: _remaining, ...legacy } = plan;
      fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({ schema: 'theorem-os.auto-library-state.v1',
        requestDigest: 'a'.repeat(64), status: 'stopped', elapsedMs: 100, sessions: [],
        modules: [{ index: 0, status: 'open', openedAtMs: 0, rounds: [{ round: 1, phase: 'check', pool: [], taken: [], plan: legacy }] }] }));
      expect(readAutoLibraryState(directory)?.modules[0]?.rounds[0]?.plan).toMatchObject({ ...legacy,
        target: null, application: null, remaining: null });
      expect(problems(legacy).length).toBeGreaterThan(0);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('turns Lean diagnostics and host problems into feedback', () => {
    expect(autoLibraryLeanFeedback('Lean rejected it:', { messages: [
      { format: 'lean-json', severity: 'info', message: 'ignored', line: 1, column: 0 },
      { format: 'lean-json', severity: 'error', message: 'Unknown identifier `doubel`', line: 8, column: 33 },
      { format: 'lean-json', severity: 'warning', message: "declaration uses 'sorry'", line: 10, column: 8 }] }))
      .toBe("Lean rejected it:\nline 8:33: Unknown identifier `doubel`\nline 10:8: declaration uses 'sorry'");
    expect(autoLibraryLeanFeedback('H', { timedOut: true })).toBe('H\nLean did not finish in time. Make the definitions and statements cheaper to elaborate.');
    expect(autoLibraryLeanFeedback('H', { messages: [], stderr: 'boom\n' })).toBe('H\nboom');
    expect(autoLibraryRejectionFeedback(['a', 'b'])).toBe('The host rejected the module:\n- a\n- b');
    expect(autoLibraryRejectionFeedback(['a'], 'The solver run did not prove the module:')).toBe('The solver run did not prove the module:\n- a');
  });
});
