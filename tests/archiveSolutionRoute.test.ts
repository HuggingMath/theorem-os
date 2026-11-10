import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { archiveSolutionRoutes } from '../docs/web/archiveSolutionRoute';
import { buildArchiveSourceRoute, withArchiveSourceRoute } from '../docs/web/archiveSourceRoute';
import { archiveIndex, buildSiteCatalog } from '../docs/web/catalog';
import { renderArchiveProcess, emptyProcessSelection } from '../docs/web/process';
import { inspectLeanDeclarationRegions } from '../src/math/leanSource';
import type { ArchiveProcess, ArchiveRecord } from '../docs/web/types';

type Run = ArchiveProcess['runs'][number];
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
const proof = 'namespace NewProblem\ndef seed : Nat := 1\ntheorem first : seed = 1 := by rfl\ntheorem finish : seed = 1 := by exact first\nend NewProblem\n';
const run = (runId: string): Run => ({ runId, phase: 'finished', resultStatus: 'evaluated_passed', turns: 3, workers: 1, tasks: [], events: [] });
function record(code = proof): ArchiveRecord {
  return { id: 'openai_never_registered_before', title: 'A new problem', subtitle: '新题', area: '数学', summary: '证明新的目标。',
    en: { subtitle: 'New problem', area: 'Mathematics', summary: 'Prove the new target.' }, status: 'locally_verified', model: 'saved fixture',
    updatedAt: '2026-11-08T08:00:00Z', archiveUrl: 'data/proofs/new/',
    sources: [{ name: 'Submission.lean', path: 'new/Submission.lean', url: 'data/proofs/new/Submission.lean', sha256: hash(code), lines: code.split('\n').length - 1, code }] };
}
function campaignRecord(code = proof): ArchiveRecord {
  const value = record(code), accepted = run('accepted-run');
  value.campaign = { target: 'NewProblem', runId: accepted.runId, targets: ['NewProblem.finish'], proofCommit: 'a'.repeat(40),
    proofSha256: hash(code), kernelReceiptIds: ['final-receipt'], comparatorExitCode: 0, attribution: 'Saved fixture', evidenceUrl: 'verification.json' };
  accepted.checks = [{ id: 'final-check', at: value.updatedAt, scope: 'original', status: 'kernel_verified', receiptIds: ['final-receipt'], sourceDigest: hash(code) }];
  value.process = { runs: [accepted], sources: { [hash(code)]: { path: 'Submission.lean', code, sha256: hash(code) } } };
  return value;
}

describe('universal archive solution routes', () => {
  it('gives an unregistered problem a recorded route and complete source structure without handwritten walkthrough data', () => {
    const value = withArchiveSourceRoute(campaignRecord()), process = value.process!;
    const original = JSON.stringify({ runs: process.runs, sources: process.sources });
    for (const locale of ['zh', 'en'] as const) {
      const routes = archiveSolutionRoutes(value, process, undefined, locale);
      expect(routes.map(route => route.basis)).toEqual(['recorded', 'source']);
      const source = routes[1];
      expect(source.nodes.filter(node => node.kind === 'declaration').map(node => node.title)).toEqual(['NewProblem.seed', 'NewProblem.first', 'NewProblem.finish']);
      const first = source.nodes.find(node => node.title === 'NewProblem.first')!, finish = source.nodes.find(node => node.title === 'NewProblem.finish')!;
      expect(source.edges).toContainEqual({ from: first.id, to: finish.id, kind: 'reference' });
      expect(source.edges.some(edge => edge.kind === 'dependency')).toBe(false);
      for (const node of source.nodes.filter(node => node.kind === 'declaration')) {
        expect(node.source?.sha256).toBe(hash(proof));
        const excerpt = node.sections!.find(section => section.code && section.text.includes(':= by'));
        if (node.title !== 'NewProblem.seed') expect(excerpt?.text).toContain(node.title.split('.').at(-1));
        expect(JSON.parse(node.action!.target)).toMatchObject({ run: 'accepted-run', step: 'check:final-check',
          sourceName: node.source!.name, sourceDigest: hash(proof), sourceLine: node.source!.line, sourceEndLine: node.source!.endLine, code: 'source' });
      }
    }
    expect(process.sourceRoute!.files[0]).not.toHaveProperty('code');
    expect(process).not.toHaveProperty('walkthrough');
    expect(JSON.stringify({ runs: process.runs, sources: process.sources })).toBe(original);
  });

  it('offers non-campaign records a source route without inventing a run, check or acceptance', () => {
    const value = withArchiveSourceRoute({ ...record(), status: 'official_accepted' }), process = value.process!;
    expect(value.processSummary).toEqual({ runs: 0, tasks: 0 });
    expect(process.runs).toEqual([]);
    expect(process.sources).toBeUndefined();
    expect(process.sourceRoute!.files[0].code).toBe(proof);
    const routes = archiveSolutionRoutes(value, process, undefined, 'zh');
    expect(routes.map(route => route.basis)).toEqual(['source']);
    expect(routes[0].nodes.some(node => ['check', 'acceptance', 'outcome'].includes(node.kind))).toBe(false);
    const index = archiveIndex({ schema: 'theoremos.public-archive.v1', repository: '', archiveRevision: '', snapshotAt: '', records: [value] }).records[0];
    const output = renderArchiveProcess(index, process, emptyProcessSelection(), 'zh');
    expect(output).toContain('data-solution-route-record="openai_never_registered_before"');
    expect(output).toContain('data-solution-route-run=""');
    expect(output).toContain('data-solution-route-mode="source"');
    expect(output).not.toContain('global-final-badge');
  });

  it('uses a historical run’s checked bytes, preserves all failed versions, and leaves final acceptance on the accepted run', () => {
    const value = campaignRecord(), process = value.process!;
    const oldCode = 'namespace Historical\ntheorem old_goal : True := by trivial\nend Historical\n';
    const failedCode = 'namespace Historical\ntheorem old_goal : True := by sorry\nend Historical\n';
    const history: Run = { ...run('history'), resultStatus: 'limit_reached', reason: 'The time budget ended.',
      tasks: [{ id: 'a', objective: 'Prove the first statement.', theorem: 'Historical.old_goal', status: 'integrated', attempts: 2, dependencies: [], receiptIds: ['a-receipt'] },
        { id: 'b', objective: 'Use a to finish.', status: 'blocked', attempts: 3, dependencies: ['a'], receiptIds: [] }],
      events: [{ at: '2026-11-07T08:00:00Z', kind: 'plan-edit', status: 'applied', message: 'Keep the first lemma and revise the second task.' }],
      deliveries: [{ id: 'research-body', at: '2026-11-07T08:01:00Z', kind: 'research', status: 'accepted', taskId: 'a', summary: 'The full saved argument explains why the construction reduces to a finite sum.' }],
      checks: [{ id: 'failed-1', at: '2026-11-07T08:02:00Z', scope: 'task', taskId: 'b', status: 'failed', receiptIds: [], sourceDigest: hash(failedCode), diagnostics: 'error: first unsuccessful version\nunsolved goals' },
        { id: 'failed-2', at: '2026-11-07T08:03:00Z', scope: 'task', taskId: 'b', status: 'failed', receiptIds: [], sourceDigest: hash(oldCode), diagnostics: 'error: second unsuccessful version\na different goal remains' }] };
    process.runs.unshift(history);
    process.sources![hash(oldCode)] = { path: 'Submission/Library/Historical.lean', code: oldCode, sha256: hash(oldCode) };
    process.sources![hash(failedCode)] = { path: 'Submission/Library/Historical.lean', code: failedCode, sha256: hash(failedCode) };
    const prepared = withArchiveSourceRoute(value), routes = archiveSolutionRoutes(prepared, prepared.process!, history, 'en');
    const saved = routes[0], structure = routes[1];
    expect(saved.edges.filter(edge => edge.kind === 'dependency')).toEqual([{ from: 'task:a', to: 'task:b', kind: 'dependency' }]);
    expect(saved.nodes.find(node => node.id === 'event:0')).toMatchObject({ kind: 'plan', summary: history.events[0].message });
    expect(saved.nodes.some(node => node.kind === 'decision')).toBe(false);
    expect(saved.nodes.find(node => node.id === 'delivery:research-body')?.sections).toContainEqual({ title: 'Complete saved research record', text: history.deliveries![0].summary });
    expect(saved.nodes.filter(node => node.kind === 'check').map(node => node.id)).toEqual(['check:failed-1', 'check:failed-2']);
    for (const check of history.checks!) {
      const node = saved.nodes.find(node => node.id === `check:${check.id}`)!;
      expect(node.status).toBe('failed');
      expect(node.sections).toContainEqual({ title: 'Complete check feedback', text: check.diagnostics, code: true });
      expect(JSON.parse(node.action!.target)).toMatchObject({ run: 'history', node: 'task:b', step: `check:${check.id}`, code: 'source' });
    }
    expect(saved.nodes.some(node => node.kind === 'acceptance')).toBe(false);
    expect(saved.nodes.find(node => node.id === 'end')?.summary).toBe(history.reason);
    expect(structure.nodes.filter(node => node.kind === 'declaration').map(node => node.title)).toEqual(['Historical.old_goal']);
    expect(structure.nodes.filter(node => node.source).every(node => node.source!.sha256 === hash(oldCode))).toBe(true);
    for (const node of structure.nodes.filter(node => node.source?.line))
      expect(JSON.parse(node.action!.target)).toMatchObject({ run: 'history', node: 'task:b', step: 'check:failed-2', code: 'source',
        sourceName: 'Submission/Library/Historical.lean', sourceDigest: hash(oldCode), sourceLine: node.source!.line, sourceEndLine: node.source!.endLine });
    expect(structure.nodes.some(node => node.title === 'NewProblem.finish')).toBe(false);
    const final = archiveSolutionRoutes(prepared, prepared.process!, process.runs.at(-1), 'en')[0];
    expect(final.nodes.find(node => node.kind === 'acceptance')?.sections?.some(section => section.text === hash(proof))).toBe(true);
  });

  it('keeps empty and source-free historical records readable without borrowing the final proof', () => {
    const empty = withArchiveSourceRoute({ ...record(), sources: [] });
    const route = archiveSolutionRoutes(empty, empty.process!, undefined, 'en')[0];
    expect(route.partial).toBe(true);
    expect(route.nodes.map(node => node.kind)).toEqual(['problem']);
    expect(route.edges).toEqual([]);
    const value = withArchiveSourceRoute(campaignRecord()), history = { ...run('no-source'), checks: [] };
    value.process!.runs.unshift(history);
    const historicalSource = archiveSolutionRoutes(value, value.process!, history, 'en')[1];
    expect(historicalSource.partial).toBe(true);
    expect(historicalSource.nodes.some(node => node.kind === 'declaration')).toBe(false);
    expect(historicalSource.nodes[0].sections!.at(-1)?.text).toBe('No checked source was saved for this run.');
  });

  it('keeps host-stopped tasks recorded unless their current check establishes a proof result', () => {
    const value = campaignRecord(), accepted = value.process!.runs[0];
    accepted.tasks = ['unchecked', 'checked', 'later-failure'].map(id => ({ id, objective: id, status: 'completed', attempts: 1,
      dependencies: [], receiptIds: [], ...(id === 'checked' ? { checkStatus: 'kernel_verified' } : {}) }));
    accepted.checks!.push({ id: 'earlier-pass', at: '2026-11-08T07:00:00Z', scope: 'task', taskId: 'later-failure', status: 'kernel_verified', receiptIds: ['old'] },
      { id: 'later-failed-check', at: '2026-11-08T07:01:00Z', scope: 'task', taskId: 'later-failure', status: 'failed', receiptIds: [], diagnostics: 'A later version did not check.' });
    const prepared = withArchiveSourceRoute(value), route = archiveSolutionRoutes(prepared, prepared.process!, accepted, 'en')[0];
    expect(route.nodes.find(node => node.id === 'task:unchecked')?.status).toBe('recorded');
    expect(route.nodes.find(node => node.id === 'task:checked')?.status).toBe('passed');
    expect(route.nodes.find(node => node.id === 'task:later-failure')?.status).toBe('failed');
    for (const node of route.nodes.filter(node => node.kind === 'task'))
      expect(node.sections!.some(section => section.title === 'Saved task state' && section.text.startsWith('completed'))).toBe(true);
  });

  it('binds the source index to its bytes and ignores names mentioned only in comments or strings', () => {
    const code = 'namespace References\ndef base : Nat := 1\ndef ignored : Nat := 2\ntheorem finish : base = 1 := by\n  -- ignored should never create a reference\n  have note := "ignored"\n  rfl\nend References\n';
    const value = record(code), index = buildArchiveSourceRoute(value, { runs: [] });
    const [base, ignored, finish] = index.files[0].declarations;
    expect(finish.references).toContain(base.id);
    expect(finish.references).not.toContain(ignored.id);
    const changed = structuredClone(value); changed.sources[0].code += '-- changed bytes\n';
    expect(() => buildArchiveSourceRoute(changed, { runs: [] })).toThrow('source checksum mismatch');
    expect(() => buildArchiveSourceRoute(value, { runs: [], sources: { [hash(code)]: { path: 'Submission.lean', code, sha256: 'b'.repeat(64) } } })).toThrow('source identity mismatch');
  });

  it('splits a new multiline proof into real outer source blocks while preserving nested code, literals, comments and CRLF bytes', () => {
    const code = ['namespace SourceSteps', 'theorem long_new_problem : ∀ n : Nat, n = n := by',
      '  intro n', '  let note := "ignored', '  exact fake_from_string', '  intro fake_from_string"',
      '  /- exact fake_from_comment', '  intro fake_from_comment -/',
      '  have h : n = n := by', '    have inner : n = n := by', '      rfl', '    exact inner',
      '  have pair : n = n ∧ n = n := by', '    constructor', '    · exact h', '    · exact h',
      '  simpa only [', '    and_self', '  ] using pair', 'end SourceSteps', ''].join('\r\n');
    const value = withArchiveSourceRoute({ ...record(code), id: 'a_new_id_without_a_walkthrough' });
    const declaration = value.process!.sourceRoute!.files[0].declarations[0], steps = declaration.steps;
    expect(steps.map(step => [step.line, step.endLine])).toEqual([[2, 3], [4, 8], [9, 12], [13, 16], [17, 19]]);
    expect(steps[1].code).toContain('  exact fake_from_string\r\n');
    expect(steps[1].code).toContain('  intro fake_from_comment -/\r\n');
    expect(steps[2].code).toBe('  have h : n = n := by\r\n    have inner : n = n := by\r\n      rfl\r\n    exact inner\r\n');
    expect(steps[3].code).toContain('    · exact h\r\n    · exact h\r\n');
    expect(steps[4].code).toBe('  simpa only [\r\n    and_self\r\n  ] using pair\r\n');
    const region = inspectLeanDeclarationRegions(code)[0];
    expect(steps.map(step => step.code).join('')).toBe(code.slice(region.bodyOffset, region.endOffset));
    const route = archiveSolutionRoutes(value, value.process!, undefined, 'en')[0];
    const projected = route.nodes.filter(node => node.kind === 'derivation');
    expect(projected.map(node => node.id)).toEqual(steps.map(step => step.id));
    expect(projected.every(node => node.parentId === declaration.id && node.status === 'recorded')).toBe(true);
    expect(route.edges.filter(edge => edge.kind === 'sequence')).toEqual(steps.slice(1).map((step, index) => ({ from: steps[index].id, to: step.id, kind: 'sequence' })));
    expect(route.edges.some(edge => edge.kind === 'dependency')).toBe(false);
    for (const [index, node] of projected.entries()) {
      expect(node.sections![0]).toEqual({ title: 'Source step', text: steps[index].code, code: true });
      expect(node.sections![1].text).toContain('source reading order');
      expect(node.source).toMatchObject({ sha256: hash(code), line: steps[index].line, endLine: steps[index].endLine });
      expect(JSON.parse(node.action!.target)).toEqual({ sourceName: 'Submission.lean', sourceDigest: hash(code),
        sourceLine: steps[index].line, sourceEndLine: steps[index].endLine });
    }
  });

  it('retains single-line proofs and direct terms and keeps bracketed multiline continuations in one step', () => {
    const code = ['theorem inline_proof : True := by trivial', 'theorem term_proof : True := True.intro',
      'def literal_term : String := "by exact fake_tactic"', 'theorem bracketed : True := by',
      '  exact (', '    True.intro', '  )', ''].join('\n');
    const files = buildArchiveSourceRoute(record(code), { runs: [] }).files;
    const declarations = files[0].declarations;
    expect(declarations.map(declaration => declaration.steps.length)).toEqual([1, 1, 1, 1]);
    expect(declarations[0].steps[0]).toMatchObject({ line: 1, endLine: 1, code: ' by trivial\n' });
    expect(declarations[1].steps[0].code).toBe(' True.intro\n');
    expect(declarations[2].steps[0].code).toBe(' "by exact fake_tactic"\n');
    expect(declarations[3].steps[0]).toMatchObject({ line: 4, endLine: 7, code: ' by\n  exact (\n    True.intro\n  )\n' });
  });

  it('groups large source files without dropping declarations, source steps or lexical references', () => {
    const code = [...Array.from({ length: 81 }, (_, index) => `def helper_${index} : Nat := ${index}`),
      'theorem many_helpers : helper_80 = 80 := by', '  have h : helper_80 = 80 := by rfl', '  exact h', ''].join('\n');
    const value = withArchiveSourceRoute(record(code)), file = value.process!.sourceRoute!.files[0];
    const route = archiveSolutionRoutes(value, value.process!, undefined, 'en')[0];
    const declarations = route.nodes.filter(node => node.kind === 'declaration'), steps = route.nodes.filter(node => node.kind === 'derivation');
    expect(declarations).toHaveLength(82);
    const groups = route.nodes.filter(node => node.kind === 'group');
    expect(groups).toHaveLength(2);
    expect(groups.every(node => node.parentId === `source:${file.sha256}`)).toBe(true);
    expect(declarations.every(node => groups.some(group => group.id === node.parentId))).toBe(true);
    expect(groups.map(group => declarations.filter(node => node.parentId === group.id).length)).toEqual([80, 2]);
    for (const group of groups) expect(JSON.parse(group.action!.target)).toEqual({ sourceName: file.name, sourceDigest: file.sha256,
      sourceLine: group.source!.line, sourceEndLine: group.source!.endLine });
    expect(steps).toHaveLength(83);
    const theorem = declarations.find(node => node.title === 'many_helpers')!, helper = declarations.find(node => node.title === 'helper_80')!;
    expect(steps.filter(node => node.parentId === theorem.id)).toHaveLength(2);
    expect(route.edges).toContainEqual({ from: helper.id, to: theorem.id, kind: 'reference' });
    const small = withArchiveSourceRoute(record());
    expect(archiveSolutionRoutes(small, small.process!, undefined, 'en')[0].nodes.filter(node => node.kind === 'declaration').every(node => !node.parentId)).toBe(true);
  });

  it('publishes a source projection and unified entry for every real archive record while preserving non-campaign evidence', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const catalog = buildSiteCatalog(root, 'a'.repeat(40));
    expect(catalog.records.length).toBeGreaterThan(0);
    const nonCampaign = catalog.records.filter(value => !value.campaign);
    expect(nonCampaign.length).toBeGreaterThan(0);
    for (const value of catalog.records) {
      expect(value.process?.sourceRoute?.files.length, value.id).toBeGreaterThan(0);
      expect(value.processSummary, value.id).toBeDefined();
      const routes = archiveSolutionRoutes(value, value.process!, undefined, 'en');
      const source = routes.find(route => route.basis === 'source')!;
      expect(source.nodes.some(node => node.source), value.id).toBe(true);
      for (const route of routes.filter(item => item.basis === 'source' || item.basis === 'explanation')) {
        for (const node of route.nodes.filter(item => item.source?.line && item.action)) {
          expect(JSON.parse(node.action!.target), `${value.id}: ${node.id}`).toMatchObject({ sourceName: node.source!.name,
            sourceDigest: node.source!.sha256, sourceLine: node.source!.line, sourceEndLine: node.source!.endLine });
        }
      }
    }
    for (const value of nonCampaign) {
      expect(value.process!.runs, value.id).toEqual([]);
      expect(value.process!.walkthrough, value.id).toBeUndefined();
      expect(value.processSummary, value.id).toEqual({ runs: 0, tasks: 0 });
    }
  });
});
