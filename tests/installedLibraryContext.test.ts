import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import * as residualReader from '../src/math/leanResidualGoals';
import * as knowledgeContext from '../src/solver/knowledgeContext';
import type { SolverRunState } from '../src/solver/archive';
import type { CooperationState } from '../src/solver/cooperation';
import { installedLibraryContextSections, installedLibraryRetrievals, readInstalledLibrarySnapshot } from '../src/solver/installedLibraryContext';
import * as knowledgeApplications from '../src/solver/knowledgeApplications';
import { buildResearchContext, finalizeResearchDispatch, type ContextAccess } from '../src/solver/modules/context';
import { readSolverProblem } from '../src/solver/problem';
import { libraryKnowledgeCandidates } from '../src/solver/theoremKnowledgeLibrary';
import { leadPlanDeliveryFile, taskVersion, type CooperativeAction, type TaskRecord } from '../src/solver/tasks';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const environmentDigest = mathDigest('current-installed-library-environment');
const file = 'Submission/Library/Arithmetic/Commutativity.lean';
const otherFile = 'Submission/Library/Lists/Reverse.lean';
const type = 'forall (a b : Nat), a + b = b + a';
const sources = {
  [file]: 'namespace Frozen.Arithmetic\ndef double (n : Nat) : Nat := n + n\ntheorem add_comm (a b : Nat) : a + b = b + a := Nat.add_comm a b\nend Frozen.Arithmetic\n',
  [otherFile]: 'namespace Frozen.Lists\ntheorem reverse_reverse (xs : List Nat) : xs.reverse.reverse = xs := List.reverse_reverse xs\nend Frozen.Lists\n',
};

function fixture(options: { source?: string; sources?: Record<string, string> } = {}) {
  const root = temporaryDirectory('installed-library-context-'); roots.push(root);
  const receipt = bootstrapLeanTask(path.join(root, 'workspace'), {
    source: options.source ?? `namespace Original\ntheorem target : ${type} := by sorry\nend Original\n`, task: 'Prove the addition identity.',
    libraryPack: { schema: LIBRARY_PACK_SCHEMA, modules: Object.entries(options.sources ?? sources).map(([file, source]) => ({ file, source,
      origin: { kind: 'upstream' as const, repository: 'fixture', commit: 'a'.repeat(40), file: 'Library.lean' } })) },
  });
  const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath);
  const library = readInstalledLibrarySnapshot(problem, environmentDigest)!;
  const record: TaskRecord = { task: { id: 'bridge', kind: 'lemma', revision: 0, dependsOn: [],
    objective: 'Prove the assigned arithmetic interface.', theoremName: 'Original.bridge', proofPath: 'Submission.lean', type },
    status: 'pending', attempts: 0 };
  const action: CooperativeAction = { kind: 'task', task: record.task,
    assignment: { taskId: record.task.id, taskDigest: taskVersion(record.task), workerId: 'researcher', seedCommit: problem.baseCommit } };
  const cooperation: CooperationState = { canonicalCommit: problem.baseCommit, tasks: [record] };
  const access: ContextAccess = { root, worktree: receipt.workspaceRoot, retrievalRoot: receipt.projectRoot,
    environment: {}, taskText: 'Prove the addition identity.', assignment: action, installedLibrary: library };
  const state = { problem, cooperation, environmentDigest } as SolverRunState;
  return { root, receipt, problem, library, record, action, access, state };
}
const sections = (message: string) => message.split('\n\n').map(text => text.trimStart());
const packets = (message: string) => sections(message).filter(text => text.startsWith('Installed library candidates '))
  .map(text => JSON.parse(text.slice(text.indexOf('\n') + 1)));

describe('installed library retrieval in actual task context', () => {
  it.each([false, true])('recommends a qualified declaration and exact import without an external catalog (continuation=%s)', continuation => {
    const f = fixture(), context = finalizeResearchDispatch(buildResearchContext(f.problem, f.state, f.access), { continuation });
    expect(packets(context.message)).toHaveLength(1);
    expect(packets(context.message)[0]).toMatchObject({ searchSource: 'closed-task-type',
      evidence: 'current-frozen-source', requiresFreshApplicationCheck: true,
      consumer: { taskId: 'bridge', taskDigest: taskVersion(f.record.task) },
    });
    expect(packets(context.message)[0].candidates[0]).toMatchObject({ name: 'Frozen.Arithmetic.add_comm', kind: 'lemma', typeKind: 'source-header',
        import: 'import Submission.Library.Arithmetic.Commutativity', check: '#check Frozen.Arithmetic.add_comm',
        source: { file: path.join(f.problem.projectRelative, file), declaration: 'Frozen.Arithmetic.add_comm',
          commit: f.problem.baseCommit, sha256: mathDigest(sources[file]) } });
    expect(context.instructions).toContain('before proposing a new helper');
    expect(context.knowledgeRetrievals).toBeUndefined();
    expect(context.manifest!.included).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^installed-library:/u), required: false }));
    expect(f.record.status).toBe('pending');
    expect(f.record.integratedCheck).toBeUndefined();
  });

  it('indexes only pinned library modules, keeping namespace and definition interfaces', () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.receipt.projectRoot, file), 'def liveEditMarker := 99\n');
    fs.writeFileSync(path.join(f.receipt.projectRoot, 'Submission/Library/Extra.lean'), 'def unselectedModuleMarker := 1\n');
    fs.writeFileSync(path.join(f.receipt.projectRoot, 'Submission.lean'), 'def mutableHelperMarker := 3\n');
    const again = readInstalledLibrarySnapshot(f.problem, environmentDigest)!;
    expect(again).toEqual(f.library);
    expect(again.base.entries.find(entry => entry.name === 'Frozen.Arithmetic.double')).toMatchObject({ kind: 'definition' });
    for (const marker of ['liveEditMarker', 'unselectedModuleMarker', 'mutableHelperMarker', 'Original.target'])
      expect(JSON.stringify(again)).not.toContain(marker);
    expect(() => readInstalledLibrarySnapshot({ ...f.problem, frozenFiles: { [file]: 'b'.repeat(64) } }, environmentDigest))
      .toThrow('math_library_module_changed');
    expect(readInstalledLibrarySnapshot({ ...f.problem, frozenFiles: undefined }, environmentDigest)).toBeUndefined();
  });

  it('retrieves the current residual goal with its local variables instead of repeating the original search', () => {
    const f = fixture();
    const initial = finalizeResearchDispatch(buildResearchContext(f.problem, f.state, f.access), { continuation: true });
    expect(packets(initial.message)[0].candidates[0].name).toBe('Frozen.Arithmetic.add_comm');
    vi.spyOn(residualReader, 'readLeanResidualGoalSnapshot').mockReturnValue({ omissions: [], goals: [{
      authority: 'advisory-lean-process', consumer: { taskId: 'bridge', taskDigest: taskVersion(f.record.task),
        theoremName: 'Original.bridge', proofPath: 'Submission.lean' },
      goalText: 'xs : List Nat\n⊢ xs.reverse.reverse = xs', sourceDigest: mathDigest('residual-source'),
      environmentDigest, toolIdentity: 'fixture-lean', file: 'Submission.lean', line: 2, column: 0,
      artifact: { path: '.lake/diagnostic-artifacts/current.json', digest: mathDigest('current-diagnostic') },
    }] });
    const context = finalizeResearchDispatch(buildResearchContext(f.problem, f.state, f.access), { continuation: true });
    const packet = packets(context.message)[0];
    expect(packet).toMatchObject({ searchSource: 'residual-goal', diagnostic: { sourceDigest: mathDigest('residual-source') } });
    expect(packet.candidates[0]).toMatchObject({ name: 'Frozen.Lists.reverse_reverse', import: 'import Submission.Library.Lists.Reverse' });
  });

  it.each(['frozen-problem', 'additional-instructions', 'assigned-objective'] as const)(
    'uses an exact named request from %s in both the application pool and displayed context', origin => {
      const f = fixture(), name = 'Frozen.Lists.reverse_reverse';
      const baseline = installedLibraryRetrievals({ problem: f.problem, action: f.action, library: f.library, environmentDigest });
      const ordinaryFirst = baseline[0].searchCandidateIds![0];
      expect(f.library.base.entries.find(entry => entry.id === ordinaryFirst)?.name).toBe('Frozen.Arithmetic.add_comm');
      if (origin === 'assigned-objective') f.record.task.objective = `Use _root_.${name} and ${name}.`;
      const problem = origin === 'frozen-problem' ? { ...f.problem, contract: { ...f.problem.contract,
        informalStatement: `Use ${name} and ${name}.` } } : f.problem;
      const taskText = origin === 'additional-instructions' ? `Use _root_.${name} and ${name}.` : f.access.taskText;
      const action: CooperativeAction = { kind: 'task', task: f.record.task, assignment: { taskId: f.record.task.id,
        taskDigest: taskVersion(f.record.task), workerId: 'researcher', seedCommit: f.problem.baseCommit } };
      const retrievals = installedLibraryRetrievals({ problem, action,
        library: f.library, taskText, environmentDigest });
      const named = f.library.base.entries.find(entry => entry.name === name)!;
      expect(retrievals[0].searchCandidateIds?.[0]).toBe(named.id);
      expect(retrievals[0].candidateIds[0]).toBe(named.id);
      expect(retrievals[0].searchCandidateIds?.filter(id => id === named.id)).toHaveLength(1);
      expect(retrievals[0].searchCandidateIds).toContain(ordinaryFirst);
      expect(retrievals[0].searchInputDigest).not.toBe(baseline[0].searchInputDigest);
      const context = finalizeResearchDispatch(buildResearchContext(problem, { ...f.state, problem }, { ...f.access,
        assignment: action, taskText }), { continuation: true });
      expect(packets(context.message)[0].candidates[0]).toMatchObject({ name, import: 'import Submission.Library.Lists.Reverse' });
      expect(packets(context.message)[0].candidates.length).toBeLessThanOrEqual(3);
    });

  it('does not promote partial, unknown or unpinned references into installed candidates', () => {
    const f = fixture(), request = { problem: f.problem, action: f.action, library: f.library, environmentDigest };
    const baseline = installedLibraryRetrievals(request);
    expect(installedLibraryRetrievals({ ...request,
      taskText: 'reverse_reverse Lists.reverse_reverse Wrong.Frozen.Lists.reverse_reverse Frozen.Lists.reverse_reverse.child' })).toEqual(baseline);
    for (const missing of [false, true]) {
      const library = structuredClone(f.library);
      for (const context of Object.values(library.base.contexts)) {
        if (missing) delete context[otherFile];
        else context[otherFile] = mathDigest('different-proof-bytes');
      }
      expect(installedLibraryRetrievals({ ...request, library, taskText: 'Use Frozen.Lists.reverse_reverse.' }))
        .toEqual(installedLibraryRetrievals({ ...request, library }));
    }
  });

  it('keeps an exact application handoff when named requests rewrite the retrieval section identity', () => {
    const f = fixture(), id = f.library.base.entries.find(entry => entry.name === 'Frozen.Lists.reverse_reverse')!.id;
    const task = { ...f.record.task, type: 'WantedResult' };
    const action: CooperativeAction = { ...f.action, task };
    const retrieval = { sectionId: 'knowledge-application-hints:exact-scope', catalogDigest: f.library.digest,
      searchInputDigest: mathDigest('exact-application-handoff'), consumer: {},
      searchCandidateIds: [], candidateIds: [id], routeFindingIds: [] };
    vi.spyOn(knowledgeContext, 'knowledgeContextSections').mockReturnValue([
      { id: retrieval.sectionId, kind: 'sources', text: '', knowledge: retrieval },
    ]);
    const application = installedLibraryRetrievals({ problem: f.problem, action, library: f.library,
      environmentDigest, forApplication: true, taskText: 'Use Frozen.Arithmetic.add_comm.' })[0]!;
    expect(application.searchCandidateIds).toEqual([
      f.library.base.entries.find(entry => entry.name === 'Frozen.Arithmetic.add_comm')!.id, id,
    ]);
  });

  it('shares the twelve-candidate and three-display budgets between named and goal candidates', () => {
    const f = fixture(), library = structuredClone(f.library);
    const template = library.base.entries.find(entry => entry.name === 'Frozen.Lists.reverse_reverse')!;
    const named = Array.from({ length: 13 }, (_, i) => ({ ...template,
      name: `Frozen.Explicit.reference_${i}`, id: mathDigest(`named-entry-${i}`) }));
    library.base.entries.push(...named);
    const taskText = named.map(entry => entry.name).join(' ');
    const first = installedLibraryRetrievals({ problem: f.problem, action: f.action, library, taskText, environmentDigest })[0];
    expect(first.searchCandidateIds).toEqual(named.slice(0, 12).map(entry => entry.id));
    expect(first.candidateIds).toEqual(named.slice(0, 3).map(entry => entry.id));
    const context = installedLibraryContextSections({ problem: f.problem, action: f.action, library, taskText, environmentDigest });
    expect(context).toHaveLength(1);
    expect(Buffer.byteLength(context[0].text)).toBeLessThanOrEqual(4096);
  });

  it.each([false, true])('finds an applicable lemma beyond twelve definitions before truncation (named definitions=%s)', named => {
    const definitions = Array.from({ length: 12 }, (_, i) => `Frozen.Nat_0_predicate_${i}`);
    const f = fixture({ source: 'theorem target (n : Nat) : n + 0 = n := by sorry\n', sources: {
      [file]: 'namespace Frozen\n' + definitions.map(name =>
        `def ${name.slice('Frozen.'.length)} (n : Nat) : Prop := n + 0 = n\n`).join('') +
        'theorem usable (n : Nat) : n = n := rfl\nend Frozen\n',
    } });
    const input = { problem: f.problem, library: f.library, environmentDigest,
      ...(named ? { taskText: definitions.join(' ') } : {}) };
    const entry = new Map(f.library.base.entries.map(entry => [entry.id, entry]));
    const normal = installedLibraryRetrievals(input);
    expect(normal[0].searchCandidateIds).toHaveLength(12);
    if (named) expect(normal[0].searchCandidateIds!.every(id => entry.get(id)?.kind === 'definition')).toBe(true);
    else expect(normal[0].searchCandidateIds![0]).toBe(f.library.base.entries.find(entry => entry.name === 'Frozen.usable')!.id);
    const application = installedLibraryRetrievals({ ...input, forApplication: true });
    expect(application[0].searchCandidateIds!.map(id => entry.get(id)?.name)).toEqual(['Frozen.usable']);
    expect(application[0].catalogDigest).toBe(f.library.digest);
    const context = installedLibraryContextSections(input);
    expect(context).toHaveLength(1);
    const packet = JSON.parse(context[0].text.slice(context[0].text.indexOf('\n') + 1));
    if (named) expect(packet.candidates.every(candidate => candidate.kind === 'definition')).toBe(true);
    else expect(packet.candidates[0].name).toBe('Frozen.usable');
    expect(installedLibraryRetrievals(input)).toEqual(normal);
  });

  it('reuses the filtered metadata index without altering the frozen snapshot or ordinary definition hints', () => {
    const f = fixture(), before = JSON.stringify(f.library);
    const input = { problem: f.problem, library: f.library, action: f.action, environmentDigest,
      taskText: 'Use Frozen.Arithmetic.double.' };
    const index = vi.spyOn(knowledgeContext, 'indexKnowledgeContextSnapshot');
    const ordinary = installedLibraryRetrievals(input), application = installedLibraryRetrievals({ ...input, forApplication: true });
    expect(ordinary[0].candidateIds[0]).toBe(f.library.base.entries.find(entry => entry.name === 'Frozen.Arithmetic.double')!.id);
    expect(application[0].searchCandidateIds).not.toContain(ordinary[0].candidateIds[0]);
    expect(index).toHaveBeenCalledOnce();
    expect(installedLibraryRetrievals({ ...input, forApplication: true })).toEqual(application);
    expect(index).toHaveBeenCalledOnce();
    expect(installedLibraryRetrievals(input)).toEqual(ordinary);
    expect(JSON.stringify(f.library)).toBe(before);
  });

  it.each([true, false])('recalls a premise constructor only from a pinned module (pinned=%s)', pinned => {
    const f = fixture({ source: 'theorem target (n : Nat) (h : n = 0) : Nat.succ n = 1 := by sorry\n', sources: {
      [file]: 'namespace Frozen\nstructure IsZero (n : Nat) : Prop where\n  eq_zero : n = 0\n' +
        'theorem succ_eq_one (n : Nat) (h : IsZero n) : Nat.succ n = 1 := congrArg Nat.succ h.eq_zero\n' +
        Array.from({ length: 12 }, (_, index) =>
          `theorem blocked_${String.fromCharCode(97 + index)} (n : Nat) (h : False) : Nat.succ n = 1 := h.elim\n`).join('') + 'end Frozen\n',
      [otherFile]: 'import Submission.Library.Arithmetic.Commutativity\nnamespace Frozen\n' +
        'theorem isZero_of_eq (n : Nat) (h : n = 0) : IsZero n := ⟨h⟩\nend Frozen\n',
    } });
    const problem = pinned ? f.problem : { ...f.problem, frozenFiles: { [file]: f.problem.frozenFiles![file]! } };
    const action: CooperativeAction = { ...f.action, task: { ...f.action.task, ...f.problem.targets[0]!, kind: 'goal' } };
    const input = { problem, action, library: f.library, environmentDigest };
    const auxiliary = f.library.base.entries.find(entry => entry.name === 'Frozen.isZero_of_eq')!.id;
    const before = JSON.stringify(f.library), ordinary = installedLibraryRetrievals(input)[0]!;
    expect(ordinary.searchCandidateIds![0]).toBe(f.library.base.entries.find(entry => entry.name === 'Frozen.succ_eq_one')!.id);
    expect(ordinary.searchCandidateIds).not.toContain(auxiliary);
    const index = vi.spyOn(knowledgeContext, 'indexKnowledgeContextSnapshot');
    const application = installedLibraryRetrievals({ ...input, forApplication: true })[0]!;
    expect(application.searchCandidateIds).toHaveLength(12);
    expect(application.searchCandidateIds!.includes(auxiliary)).toBe(pinned);
    expect(application.searchCandidateIds![0]).toBe(ordinary.searchCandidateIds![0]);
    expect(installedLibraryRetrievals({ ...input, forApplication: true })[0]).toEqual(application);
    expect(index).not.toHaveBeenCalled();
    expect(JSON.stringify(f.library)).toBe(before);
    const named = ordinary.searchCandidateIds!.map(id => f.library.base.entries.find(entry => entry.id === id)!.name);
    const explicit = installedLibraryRetrievals({ ...input, forApplication: true, taskText: named.join(' ') })[0]!;
    expect(explicit.searchCandidateIds).toEqual(ordinary.searchCandidateIds);
  });

  it.each([false, true])('keeps a late main theorem and shares premise queries across seeds (long first seed=%s)', longFirst => {
    const f = fixture({ source: 'theorem target (n : Nat) (h : n = 0) : Nat.succ n = 1 := by sorry\n', sources: {
      [file]: 'namespace Frozen\nstructure IsZero (n : Nat) : Prop where\n  eq_zero : n = 0\n' +
        'theorem succ_eq_one (n : Nat) (h : IsZero n) : Nat.succ n = 1 := congrArg Nat.succ h.eq_zero\n' +
        Array.from({ length: 11 }, (_, index) =>
          `theorem blocked_${index} (n : Nat) (h : False) ` +
          (longFirst && index === 0 ? Array.from({ length: 8 }, (_, i) => `(h${i} : n = ${i + 2}) `).join('') : '') +
          ': Nat.succ n = 1 := h.elim\n').join('') +
        'theorem isZero_of_eq (n : Nat) (h : n = 0) : IsZero n := ⟨h⟩\nend Frozen\n',
    } });
    const id = (name: string) => f.library.base.entries.find(entry => entry.name === `Frozen.${name}`)!.id;
    const main = id('succ_eq_one'), auxiliary = id('isZero_of_eq');
    const primary = [...Array.from({ length: 11 }, (_, index) => id(`blocked_${index}`)), main];
    const action: CooperativeAction = { ...f.action, task: { ...f.action.task, ...f.problem.targets[0]!, kind: 'goal' } };
    const retrieval = { sectionId: 'tail-seed', catalogDigest: f.library.digest, searchInputDigest: mathDigest('tail-seed'),
      consumer: {}, searchCandidateIds: primary, candidateIds: primary.slice(0, 3), routeFindingIds: [] };
    // Exercise the truncation boundary independently of lexical tie-breaking among identical conclusions.
    vi.spyOn(knowledgeContext, 'knowledgeContextSections').mockReturnValue([
      { id: 'tail-seed', kind: 'sources', text: '', knowledge: retrieval },
    ]);
    const search = vi.spyOn(knowledgeContext, 'searchKnowledgeContextSnapshot');
    const input = { problem: f.problem, action, library: f.library, environmentDigest };
    const application = installedLibraryRetrievals({ ...input, forApplication: true })[0]!;
    expect(application.searchCandidateIds).toHaveLength(12);
    expect(application.searchCandidateIds!.slice(0, 3)).toEqual(primary.slice(0, 3));
    expect(application.searchCandidateIds).toEqual(expect.arrayContaining([main, auxiliary]));
    expect(search).toHaveBeenCalledOnce();
    const requests = search.mock.calls[0]![1];
    expect(requests).toHaveLength(longFirst ? 8 : 2);
    expect(requests[1]!.goal).toContain('IsZero _');
    expect(installedLibraryRetrievals(input)[0]).toEqual(retrieval);
    expect(installedLibraryRetrievals({ ...input, forApplication: true,
      taskText: primary.map(id => f.library.base.entries.find(entry => entry.id === id)!.name).join(' ') })[0]!.searchCandidateIds)
      .toEqual(primary);
    for (const count of [10, 11]) {
      const named = primary.slice(0, count);
      const constrained = installedLibraryRetrievals({ ...input, forApplication: true,
        taskText: named.map(id => f.library.base.entries.find(entry => entry.id === id)!.name).join(' ') })[0]!;
      expect(constrained.searchCandidateIds).toHaveLength(12);
      expect(constrained.searchCandidateIds!.slice(0, count)).toEqual(named);
      expect(constrained.searchCandidateIds!.includes(auxiliary)).toBe(count === 10);
      expect(constrained.searchCandidateIds).toContain(main);
    }
  });

  it.each([false, true])('retains a direct main candidate when auxiliary results fill the pool (local premise=%s)', premise => {
    const f = fixture({ source: 'theorem target (n : Nat) (h : n = 0) : Nat.succ n = 1 := by sorry\n', sources: {
      [file]: 'namespace Frozen\nstructure Bad (n : Nat) : Prop where\n  impossible : False\n' +
        Array.from({ length: 11 }, (_, index) =>
          `theorem blocked_${index} (n : Nat) (h : Bad n) : Nat.succ n = 1 := h.impossible.elim\n`).join('') +
        (premise ? 'theorem direct (n : Nat) (h : n = 0) : n + 1 = 1 := congrArg (fun k : Nat => k + 1) h\n' :
          'theorem direct (n : Nat) : n + 0 = n := Nat.add_zero n\n') +
        Array.from({ length: 3 }, (_, index) =>
          `theorem makeBad_${index} (n : Nat) (h : False) : Bad n := ⟨h⟩\n`).join('') + 'end Frozen\n',
    } });
    const id = (name: string) => f.library.base.entries.find(entry => entry.name === `Frozen.${name}`)!.id;
    const direct = id('direct'), primary = [...Array.from({ length: 11 }, (_, index) => id(`blocked_${index}`)), direct];
    const retrieval = { sectionId: 'direct-seed', catalogDigest: f.library.digest, searchInputDigest: mathDigest('direct-seed'),
      consumer: {}, searchCandidateIds: primary, candidateIds: primary.slice(0, 3), routeFindingIds: [] };
    vi.spyOn(knowledgeContext, 'knowledgeContextSections').mockReturnValue([
      { id: 'direct-seed', kind: 'sources', text: '', knowledge: retrieval },
    ]);
    const action: CooperativeAction = { ...f.action, task: { ...f.action.task, ...f.problem.targets[0]!, kind: 'goal' } };
    const application = installedLibraryRetrievals({ problem: f.problem, action, library: f.library, environmentDigest,
      forApplication: true })[0]!;
    expect(application.searchCandidateIds).toHaveLength(12);
    expect(application.searchCandidateIds!.slice(0, 3)).toEqual(primary.slice(0, 3));
    expect(application.searchCandidateIds).toEqual(expect.arrayContaining([direct, id('makeBad_0'), id('makeBad_1'), id('makeBad_2')]));
  });

  it.each([
    { label: 'Iff.mp', conclusion: 'n = 0 ↔ Nat.succ n = 1', local: 'n = 0', ownPremise: true, retain: true },
    { label: 'Iff.mpr', conclusion: 'Nat.succ n = 1 ↔ n = 0', local: 'n = 0', ownPremise: true, retain: true },
    { label: 'missing opposite side', conclusion: 'n = 0 ↔ Nat.succ n = 1', local: 'm = 0', ownPremise: true, retain: false },
    { label: 'different companion binder', conclusion: 'm = 0 ↔ Nat.succ n = 1', local: 'n = 0', ownPremise: true, retain: false },
    { label: 'missing theorem premise', conclusion: 'n = 0 ↔ Nat.succ n = 1', local: 'n = 0', ownPremise: false, retain: false },
    { label: 'nested iff', conclusion: '(n = 0 ↔ Nat.succ n = 1) ∧ True', local: 'n = 0', ownPremise: true, retain: false },
  ])('retains a late iff only when both sides match the current locals ($label)', test => {
    const f = fixture({
      source: `theorem target (n m : Nat) (h : ${test.local}) ${test.ownPremise ? '(hb : False) ' : ''}` +
        ': Nat.succ n = 1 := by sorry\n',
      sources: { [file]: 'namespace Frozen\nstructure Bad (n : Nat) : Prop where\n  impossible : False\n' +
        'theorem unrelated (n : Nat) : n = n := rfl\n' +
        Array.from({ length: 10 }, (_, index) =>
          `theorem blocked_${index} (n : Nat) (h : Bad n) : n + 2 = 0 := h.impossible.elim\n`).join('') +
        `theorem direct (n m : Nat) (hb : False) : ${test.conclusion} := hb.elim\n` +
        Array.from({ length: 3 }, (_, index) =>
          `theorem makeBad_${index} (n : Nat) (h : False) : Bad n := ⟨h⟩\n`).join('') + 'end Frozen\n' },
    });
    const id = (name: string) => f.library.base.entries.find(entry => entry.name === `Frozen.${name}`)!.id;
    const direct = id('direct'), primary = [id('unrelated'), ...Array.from({ length: 9 }, (_, index) => id(`blocked_${index}`)),
      direct, id('blocked_9')];
    const retrieval = { sectionId: 'iff-seed', catalogDigest: f.library.digest, searchInputDigest: mathDigest('iff-seed'),
      consumer: {}, searchCandidateIds: primary, candidateIds: primary.slice(0, 3), routeFindingIds: [] };
    vi.spyOn(knowledgeContext, 'knowledgeContextSections').mockReturnValue([
      { id: 'iff-seed', kind: 'sources', text: '', knowledge: retrieval },
    ]);
    const action: CooperativeAction = { ...f.action, task: { ...f.action.task, ...f.problem.targets[0]!, kind: 'goal' } };
    const application = installedLibraryRetrievals({ problem: f.problem, action, library: f.library, environmentDigest,
      forApplication: true })[0]!;
    expect(application.searchCandidateIds).toHaveLength(12);
    expect(application.searchCandidateIds!.slice(0, 3)).toEqual(primary.slice(0, 3));
    expect(application.searchCandidateIds).toEqual(expect.arrayContaining([id('makeBad_0'), id('makeBad_1'), id('makeBad_2')]));
    expect(application.searchCandidateIds!.includes(direct)).toBe(test.retain);
    if (test.retain) expect(application.searchCandidateIds![3]).toBe(direct);
  });

  it('keeps installed recommendations alongside a separately pinned historical catalog', () => {
    const f = fixture(), history = { ...f.library, digest: mathDigest('external-catalog') };
    const context = finalizeResearchDispatch(buildResearchContext(f.problem, { ...f.state, knowledgeDigest: history.digest }, { ...f.access,
      knowledgeFile: path.join(f.root, 'catalog.json'), knowledgeDigest: history.digest, knowledgeSnapshot: history }), { continuation: true });
    expect(packets(context.message)).toHaveLength(1);
    expect(context.message).toContain('Saved theorem candidates');
    expect(context.knowledgeRetrievals).toEqual([expect.objectContaining({ catalogDigest: history.digest, included: true })]);
    expect(packets(context.message)[0]).not.toHaveProperty('catalogDigest');
    const saved = sections(context.message).find(text => text.startsWith('Saved theorem candidates '))!;
    const packet = JSON.parse(saved.slice(saved.indexOf('\n') + 1));
    expect(packet.candidates[0].installation).toEqual({ status: 'installed-frozen', file,
      import: 'import Submission.Library.Arithmetic.Commutativity' });
    expect(context.instructions).toContain('never copy or redeclare it');
  });

  it.each([false, true])('does not label a same-named historical declaration with different bytes as installed (missing=%s)', missing => {
    const f = fixture(), history = structuredClone(f.library);
    history.digest = mathDigest('different-historical-source');
    for (const context of Object.values(history.base.contexts)) {
      if (missing) delete context[file];
      else context[file] = mathDigest('same-name-different-proof');
    }
    const context = buildResearchContext(f.problem, { ...f.state, knowledgeDigest: history.digest }, { ...f.access,
      knowledgeFile: path.join(f.root, 'historical.json'), knowledgeDigest: history.digest, knowledgeSnapshot: history });
    const saved = sections(context.message).find(text => text.startsWith('Saved theorem candidates '))!;
    const packet = JSON.parse(saved.slice(saved.indexOf('\n') + 1));
    expect(packet.candidates[0].name).toBe('Frozen.Arithmetic.add_comm');
    expect(packet.candidates[0]).not.toHaveProperty('installation');
  });

  it.each([false, true])('recommends only importable names while leaving archived source interfaces intact (module=%s)', module => {
    const f = fixture(), source = [module ? 'module' : '', 'namespace Visibility',
      'private theorem hidden : True := trivial', 'private noncomputable def secret : Nat := 1',
      'theorem defaultVisibility : True := trivial', 'public theorem explicitPublic : True := trivial',
      'public section', 'protected theorem exported : True := trivial', 'private', '/- visibility modifier on its own line -/',
      'theorem stillHidden : True := trivial', 'end', 'theorem afterSection : True := trivial', 'end Visibility', ''].join('\n');
    const provenance = f.library.base.entries[0]!.provenance[0]!;
    const files = { [file]: source };
    const publicNames = libraryKnowledgeCandidates(files, provenance, { publicOnly: true }).candidates.map(entry => entry.name);
    expect(publicNames).toEqual(module ? ['Visibility.explicitPublic', 'Visibility.exported'] :
      ['Visibility.defaultVisibility', 'Visibility.explicitPublic', 'Visibility.exported', 'Visibility.afterSection']);
    expect(libraryKnowledgeCandidates(files, provenance).candidates.map(entry => entry.name)).toContain('Visibility.hidden');
  });

  it('keeps relevant imports ahead of old findings, while honoring a zero optional context budget', () => {
    const f = fixture();
    f.state.cooperation!.history = [{ task: { ...f.record.task, id: 'old_bridge' }, finding: 'old route notes '.repeat(300),
      producer: 'researcher' }];
    const context = buildResearchContext(f.problem, f.state, { ...f.access, maxOptionalContextBytes: 4200 });
    expect(packets(context.message)).toHaveLength(1);
    expect(context.manifest!.omitted).toContainEqual(expect.objectContaining({ id: expect.stringMatching(/^history:/u), reason: 'optional-budget' }));
    const omitted = buildResearchContext(f.problem, f.state, { ...f.access, maxOptionalContextBytes: 0 });
    expect(packets(omitted.message)).toHaveLength(0);
    expect(omitted.manifest!.omitted).toContainEqual(expect.objectContaining({
      id: expect.stringMatching(/^installed-library:/u), reason: 'optional-budget' }));
    expect(omitted.message).toContain(JSON.stringify(type));
  });

  it.each(['review', 'assemble'] as const)('does not add installed candidates to %s dispatches', kind => {
    const f = fixture();
    const action = { kind } as CooperativeAction;
    expect(installedLibraryContextSections({ problem: f.problem, cooperation: f.state.cooperation, action,
      library: f.library, taskText: 'Use Frozen.Arithmetic.add_comm.', environmentDigest })).toEqual([]);
  });

  it.each([false, true])('keeps complete read-only library and knowledge retrieval in Lead planning (continuation=%s)', continuation => {
    const f = fixture(), history = { ...f.library, digest: mathDigest('lead-historical-catalog') };
    const assignment: Extract<CooperativeAction, { kind: 'lead' }> = { kind: 'lead', seedCommit: f.problem.baseCommit,
      planVersion: 'current-plan', planNonce: 'lead-dispatch' };
    const context = finalizeResearchDispatch(buildResearchContext(f.problem, { ...f.state, knowledgeDigest: history.digest }, {
      ...f.access, assignment, knowledgeFile: path.join(f.root, 'historical.json'), knowledgeDigest: history.digest,
      knowledgeSnapshot: history, libraryCatalog: { file: path.join(f.root, 'library-catalog.json'), digest: f.library.digest },
    }), { continuation });
    expect(context.instructions).toContain('knowledge search --catalog');
    expect(context.instructions).toContain('knowledge get --catalog');
    expect(context.instructions).toContain('knowledge dependencies --catalog');
    expect(context.instructions).toContain('knowledge consumers --catalog');
    expect(context.instructions).toContain('knowledge source --catalog');
    expect(context.instructions).toContain(path.join(f.root, 'historical.json'));
    expect(context.instructions).toContain(history.digest);
    expect(context.instructions).toContain("--field 'FIELD_NAME' --offset OFFSET");
    expect(context.instructions).toContain('following nextOffset until truncated:false');
    expect(context.instructions).toContain('library search --worktree');
    expect(context.instructions).toContain('library get --worktree');
    expect(context.instructions).toContain('Follow source.nextOffset with --offset until source.complete is true');
    expect(context.instructions).toContain('Do not adapt, import or redeclare them during planning');
    expect(context.instructions).toContain('do not import, request or copy modules during planning');
    expect(context.instructions).toContain('assigned workers perform source adaptation and Lean application checks');
    expect(context.instructions).toContain('respect the frozen assumptions');
    expect(context.instructions).toContain('intended consumer and exact remaining inference');
    for (const writableAdvice of ['library request --worktree', 'adapt only needed declarations',
      'You may add explicit Mathlib.* imports', 'Add helpers in owned modules', 'check-lean --workspace',
      'add application:{expression:']) expect(context.instructions).not.toContain(writableAdvice);
    expect(context.instructions.split('\n').find(line => line.startsWith('Edit only ')))
      .toBe(`Edit only ${path.join(f.receipt.workspaceRoot, 'RESEARCH.md')}, ${path.join(f.receipt.workspaceRoot, leadPlanDeliveryFile(assignment)!)}.`);
    expect(packets(context.message)).toHaveLength(1);
    expect(packets(context.message)[0].candidates[0]).toMatchObject({ name: 'Frozen.Arithmetic.add_comm',
      import: 'import Submission.Library.Arithmetic.Commutativity', check: '#check Frozen.Arithmetic.add_comm' });
    expect(context.assignment).toEqual(assignment);
    expect(context.workContract).toMatchObject({ stage: 'route-planning', sourcePolicy: 'host-checks-any-source-repair' });
  });

  it('keeps complete pinned knowledge and library reads available to a fixed reviewer without proof-writing instructions', () => {
    const f = fixture(), history = { ...f.library, digest: mathDigest('review-historical-catalog') };
    const assignment: CooperativeAction = { kind: 'review', seedCommit: f.problem.baseCommit,
      sourceDigest: mathDigest('fixed-review-candidate') };
    const context = finalizeResearchDispatch(buildResearchContext(f.problem, { ...f.state, knowledgeDigest: history.digest }, {
      ...f.access, assignment, knowledgeFile: path.join(f.root, 'historical.json'), knowledgeDigest: history.digest,
      knowledgeSnapshot: history, libraryCatalog: { file: path.join(f.root, 'library-catalog.json'), digest: f.library.digest },
    }), { continuation: true });
    expect(context.instructions).toContain('knowledge get --catalog');
    expect(context.instructions).toContain('knowledge source --catalog');
    expect(context.instructions).toContain(path.join(f.root, 'historical.json'));
    expect(context.instructions).toContain(history.digest);
    expect(context.instructions).toContain("--field 'FIELD_NAME' --offset OFFSET");
    expect(context.instructions).toContain('following nextOffset until truncated:false');
    expect(context.instructions).toContain('library search --worktree');
    expect(context.instructions).toContain('library get --worktree');
    expect(context.instructions).toContain('Follow source.nextOffset with --offset until source.complete is true');
    expect(context.instructions).toContain('Do not adapt, import or redeclare them during review');
    expect(context.instructions).toContain('do not import, request or copy modules during review');
    expect(context.instructions).not.toContain('library request --worktree');
    expect(context.instructions).not.toContain('adapt only needed declarations');
    expect(context.instructions).not.toContain('You may add explicit Mathlib.* imports');
    expect(context.instructions).not.toContain('Add helpers in owned modules');
    expect(context.instructions.split('\n').find(line => line.startsWith('Edit only ')))
      .toBe(`Edit only ${path.join(f.receipt.workspaceRoot, 'RESEARCH.md')}.`);
    expect(context.instructions).toContain('Your verdict does not replace host checks or the independent S3');
    expect(context.assignment).toEqual(assignment);
    expect(packets(context.message)).toEqual([]);
    expect(context.continuationMessage).toBeUndefined();
  });

  it('keeps candidate and adaptation hints out of real final-candidate reviews, including continuations', () => {
    const f = fixture(), task = { ...f.record.task, kind: 'research' as const, reviewScope: 'final-candidate' as const };
    const action: CooperativeAction = { ...f.action, kind: 'task', task,
      assignment: { ...f.action.assignment, taskDigest: taskVersion(task) } };
    f.state.cooperation!.tasks = [{ ...f.record, task }];
    const applications = vi.spyOn(knowledgeApplications, 'knowledgeApplicationContextSections').mockReturnValue([
      { id: 'knowledge-application:historical', kind: 'sources', text: 'Historical adaptation must stay outside fixed review.' },
    ]);
    for (const assignment of [action, { kind: 'review', seedCommit: f.problem.baseCommit, sourceDigest: mathDigest('fixed-proof') },
      { kind: 'assemble', seedCommit: f.problem.baseCommit }] as CooperativeAction[]) {
      const context = buildResearchContext(f.problem, { ...f.state, knowledgeDigest: f.library.digest }, { ...f.access,
        assignment, taskText: 'Use Frozen.Arithmetic.add_comm.', knowledgeFile: path.join(f.root, 'catalog.json'),
        knowledgeDigest: f.library.digest, knowledgeSnapshot: f.library });
      for (const continuation of [false, true]) {
        const dispatch = finalizeResearchDispatch(context, { continuation });
        expect(packets(dispatch.message)).toEqual([]);
        expect(dispatch.message).not.toContain('Saved theorem candidates');
        expect(dispatch.message).not.toContain('Historical adaptation must stay outside fixed review.');
      }
    }
    expect(applications).not.toHaveBeenCalled();
  });

  it('bounds local candidate packets even for very large source headers', () => {
    const f = fixture(), library = structuredClone(f.library);
    for (const entry of library.base.entries) entry.type += ' ' + 'ℝ'.repeat(10000);
    const sections = installedLibraryContextSections({ problem: f.problem, action: f.action, library, environmentDigest,
      taskText: 'Use Frozen.Arithmetic.add_comm.' });
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      expect(Buffer.byteLength(section.text)).toBeLessThanOrEqual(4096);
      expect(section.text).not.toContain('\uFFFD');
    }
  });
});
