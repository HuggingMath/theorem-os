import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapLocalExample } from '../src/math/localExample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { SolverRunState } from '../src/solver/archive';
import { frozenSourceContext } from '../src/solver/contextCompiler';
import { freezeContinuationInput, readContinuationInput, readContinuationPage,
  type ContinuationIdentity, type ContinuationSnapshot } from '../src/solver/continuationInput';
import { referencePassages, referenceTerms, searchContinuation } from '../src/solver/continuationSearch';
import { buildResearchContext, type ContextBundle } from '../src/solver/modules/context';
import { readSolverProblem, type SolverProblem } from '../src/solver/problem';
import { taskVersion, type CooperativeAction, type CooperativeTask } from '../src/solver/tasks';

type Attachment = { id: string; kind: string; text: string };

/** Writes one manifest beside its attachment files and freezes it under a fresh runtime directory. */
function freezeAttachments(root: string, identity: ContinuationIdentity, attachments: Attachment[], name = 'runtime'): ContinuationSnapshot {
  const input = path.join(root, `${name}-input.json`);
  for (const item of attachments) fs.writeFileSync(path.join(root, `${name}-${item.id}.txt`), item.text);
  fs.writeFileSync(input, JSON.stringify({ schema: 'theorem-os.continuation-input.v1', ...identity,
    attachments: attachments.map(item => ({ id: item.id, kind: item.kind, path: `${name}-${item.id}.txt`,
      bytes: Buffer.byteLength(item.text), sha256: mathDigest(item.text) })) }));
  return freezeContinuationInput(readContinuationInput(input, identity), path.join(root, name));
}

const filler = (word: string) => Array.from({ length: 150 }, (_, index) => `${word} ${index}`).join(' ') + '.';
const book = [
  `Chapter 1. Groups. ${filler('associativity')}`,
  `Theorem 2.1 (Sylow). Every finite group whose order is divisible by a prime power has a Sylow subgroup of that order. ${filler('counting')}`,
  `Chapter 3. Measure. ${filler('sigma')} The Lebesgue integral of a nonnegative function is a supremum over simple functions.`,
  '有限群的西罗定理给出子群的存在性。' + '证明使用群作用与轨道计数。'.repeat(20),
].join('\n\n');
const notes = 'An earlier run tried Sylow counting and stalled.';

describe('frozen continuation passage search', () => {
  let root: string;
  const identity: ContinuationIdentity = { taskDigest: mathDigest('task'), problemReceiptDigest: mathDigest('receipt') };
  const reference = () => freezeAttachments(root, identity, [{ id: 'book', kind: 'reference', text: book },
    { id: 'notes', kind: 'research-notes', text: notes }]);
  beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-search-'))); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('cuts contiguous paragraph-aligned passages without splitting a surrogate pair', () => {
    const paragraphs = referencePassages(book);
    expect(paragraphs.map(range => book.slice(range.start, range.end).slice(0, 12)))
      .toEqual(['Chapter 1. G', 'Theorem 2.1 ', 'Chapter 3. M', '有限群的西罗定理给出子群']);
    expect(referencePassages('')).toEqual([]);
    for (const text of ['a' + '\u{1f642}'.repeat(5000), 'x'.repeat(9000) + '\n\n' + 'word '.repeat(3000), book]) {
      const ranges = referencePassages(text);
      expect(ranges[0]!.start).toBe(0); expect(ranges.at(-1)!.end).toBe(text.length);
      for (const [index, range] of ranges.entries()) {
        if (index) expect(range.start).toBe(ranges[index - 1]!.end);
        expect(range.end - range.start).toBeLessThanOrEqual(4000);
        expect(text.slice(range.start, range.end)).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/u);
      }
    }
  });

  it('indexes lowercase words, identifier parts, digits and Han bigrams', () => {
    expect(referenceTerms('The Nat.add_zero ContinuousOn x 2 ﬁnite 西罗定理 群').map(item => item.term)).toEqual(
      ['nat', 'add', 'zero', 'continuouson', 'continuous', '2', 'finite', '西罗', '罗定', '定理', '群']);
    const text = 'see Sylow';
    expect(referenceTerms(text)).toEqual([{ term: 'see', offset: 0 }, { term: 'sylow', offset: 4 }]);
  });

  it('ranks the rare passage first and returns offsets that continuation read pages exactly', () => {
    const snapshot = reference(), start = book.indexOf('Theorem 2.1'), end = book.indexOf('Chapter 3');
    const result = searchContinuation(snapshot.file, snapshot.digest, 'Sylow subgroup', { kinds: ['reference'] });
    expect(result).toMatchObject({ schema: 'theorem-os.continuation-search.v1', authority: 'advisory-continuation',
      proofAcceptance: 'not-assessed', snapshotDigest: snapshot.digest, ranking: 'bm25-lexical', kinds: ['reference'],
      offsetEncoding: 'utf16-code-unit', passages: 4, queryTerms: ['sylow', 'subgroup'] });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]).toMatchObject({ id: 'book', kind: 'reference', evidence: 'unverified', startOffset: start, endOffset: end,
      matchedTerms: ['sylow', 'subgroup'] });
    expect(result.hits[0]!.snippet.text).toContain('Theorem 2.1 (Sylow)');
    const page = readContinuationPage(snapshot.file, snapshot.digest, 'book', { offset: start });
    expect(page.text.slice(0, end - start)).toBe(book.slice(start, end));
    const all = searchContinuation(snapshot.file, snapshot.digest, 'Sylow subgroup');
    expect(all.kinds).toEqual(['proof-source', 'research-notes', 'diagnostics', 'reference']);
    expect(all.hits.map(hit => hit.id)).toEqual(['book', 'notes']);
    expect(searchContinuation(snapshot.file, snapshot.digest, 'Sylow subgroup')).toEqual(all);
  });

  it('centres snippets on the first match and searches Han text by bigrams', () => {
    const snapshot = reference(), start = book.indexOf('Chapter 3'), end = book.indexOf('有限群');
    const lebesgue = searchContinuation(snapshot.file, snapshot.digest, 'Lebesgue integral').hits[0]!;
    expect(lebesgue).toMatchObject({ startOffset: start, endOffset: end });
    expect(lebesgue.snippet.text).toContain('The Lebesgue integral');
    expect(lebesgue.snippet.endOffset - lebesgue.snippet.startOffset).toBeLessThanOrEqual(400);
    expect(lebesgue.snippet.text).toBe(book.slice(lebesgue.snippet.startOffset, lebesgue.snippet.endOffset));
    const han = searchContinuation(snapshot.file, snapshot.digest, '西罗定理');
    expect(han.hits.map(hit => [hit.startOffset, hit.matchedTerms])).toEqual([[end, ['西罗', '罗定', '定理']]]);
    expect(searchContinuation(snapshot.file, snapshot.digest, 'unrelated wording').hits).toEqual([]);
  });

  it('breaks equal scores by manifest attachment order, then offset', () => {
    const text = 'Zorn lemma applies to chains.';
    const snapshot = freezeAttachments(root, identity, [{ id: 'ref-b', kind: 'reference', text },
      { id: 'ref-a', kind: 'reference', text }]);
    const result = searchContinuation(snapshot.file, snapshot.digest, 'Zorn chains');
    expect(result.hits.map(hit => hit.id)).toEqual(['ref-b', 'ref-a']);
    expect(result.hits[0]!.score).toBe(result.hits[1]!.score);
  });

  it.each([
    { query: 'x1', limit: 0 }, { query: 'x1', limit: 21 }, { query: 'x1', limit: 1.5 }, { query: 'x1', limit: NaN },
    { query: 'x1', maxBytes: 1023 }, { query: 'x1', maxBytes: 16001 }, { query: '   ' }, { query: 'q'.repeat(4001) },
    { query: 'x1', kinds: ['instructions'] },
  ])('rejects invalid search options before reading files: %j', ({ query, ...options }) => {
    expect(() => searchContinuation('missing', mathDigest('missing'), query, options)).toThrow('math_continuation_search_options_invalid');
  });

  it('re-verifies the frozen snapshot on every search, including after an index was cached', () => {
    const snapshot = reference(), item = snapshot.manifest.attachments.find(entry => entry.id === 'book')!;
    expect(searchContinuation(snapshot.file, snapshot.digest, 'Sylow').hits.length).toBeGreaterThan(0);
    expect(() => searchContinuation(snapshot.file, mathDigest('other'), 'Sylow')).toThrow('math_continuation_identity_changed');
    const blob = path.join(path.dirname(snapshot.file), item.contentPath);
    fs.unlinkSync(blob); fs.writeFileSync(blob, 'x'.repeat(item.bytes), { mode: 0o400 });
    expect(() => searchContinuation(snapshot.file, snapshot.digest, 'Sylow')).toThrow('math_continuation_content_changed');
  });

  it('keeps the complete JSON line within --max-bytes by omitting lower-ranked hits', () => {
    const corpus = Array.from({ length: 12 }, (_, index) => `Section ${index}. Galois correspondence. ${filler('field')}`).join('\n\n');
    const snapshot = freezeAttachments(root, identity, [{ id: 'galois', kind: 'reference', text: corpus }]);
    const full = searchContinuation(snapshot.file, snapshot.digest, 'Galois correspondence', { limit: 12 });
    expect(full.hits).toHaveLength(12); expect(full.omittedHits).toBeUndefined();
    const bounded = searchContinuation(snapshot.file, snapshot.digest, 'Galois correspondence', { limit: 12, maxBytes: 2048 });
    expect(Buffer.byteLength(JSON.stringify(bounded)) + 1).toBeLessThanOrEqual(2048);
    expect(bounded.hits.length).toBeGreaterThan(0);
    expect(bounded.hits).toEqual(full.hits.slice(0, bounded.hits.length));
    expect(bounded.omittedHits).toBe(12 - bounded.hits.length);
    const wide = Array.from({ length: 300 }, (_, index) => `q${String.fromCharCode(97 + index % 26)}${String.fromCharCode(97 + Math.floor(index / 26))}x`).join(' ');
    expect(() => searchContinuation(snapshot.file, snapshot.digest, wide, { maxBytes: 1024 })).toThrow('math_continuation_search_budget_too_small');
  });

  it('exposes search through the continuation CLI and rejects malformed requests', () => {
    const snapshot = reference();
    const cli = (args: string[]) => spawnSync('bun', ['scripts/mathematics/readContinuation.ts', ...args], { encoding: 'utf8', timeout: 10_000 });
    const args = ['search', '--snapshot', snapshot.file, '--sha256', snapshot.digest, '--query', 'Sylow subgroup', '--kind', 'reference', '--limit', '3'];
    const result = cli(args);
    expect(result.status, result.stderr).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16000);
    expect(JSON.parse(result.stdout)).toMatchObject({ kinds: ['reference'], hits: [{ id: 'book', startOffset: book.indexOf('Theorem 2.1') }] });
    for (const bad of [args.map(value => value === 'reference' ? 'instructions' : value), args.filter((_, index) => ![5, 6].includes(index)),
      [...args.slice(0, -1), '0'], [...args, '--id', 'book']]) {
      const failed = cli(bad); expect(failed.status).toBe(1); expect(failed.stdout).toBe('');
    }
    expect(cli(['--help']).stdout).toContain('continuation search');
  });
});

describe('automatic reference passages in research context', () => {
  let directory: string, workspace: string, problem: SolverProblem, state: SolverRunState, identity: ContinuationIdentity;
  const taskText = 'Prove the zero laws for natural number addition.\n';
  const helper: CooperativeTask = { id: 'helper', kind: 'lemma', objective: 'Prove that adding zero on the right is the identity',
    dependsOn: [], revision: 0, proofPath: 'Submission.lean', theoremName: 'Tutorial.helper', type: 'True' };
  const zeroLaws = `Chapter 1. Adding zero on the right leaves a natural number unchanged; induction on n proves the law. ${filler('peano')}`;
  const unrelated = `Chapter 2. Compactness of ultrafilters. ${filler('ultrafilter')}`;
  const build = (action: CooperativeAction, continuation: ContinuationSnapshot) =>
    buildResearchContext(problem, { ...state, continuationDigest: continuation.digest }, {
      root: '/runtime', worktree: workspace, environment: {}, taskText, continuation, assignment: action, retrievalRoot: workspace,
      frozenContexts: Object.fromEntries(problem.ownedFiles.map(file => [file,
        frozenSourceContext(problem, file, fs.readFileSync(path.join(workspace, problem.projectRelative, file), 'utf8'))])),
    });
  const references = (bundle: ContextBundle) => {
    let offset = 0;
    for (const item of bundle.manifest!.included) {
      if (item.id.startsWith('continuation-references:'))
        return { item, text: Buffer.from(bundle.message).subarray(offset, offset + item.bytes).toString('utf8') };
      offset += item.bytes + 2;
    }
    return undefined;
  };
  beforeEach(() => {
    directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'continuation-references-')));
    workspace = path.join(directory, 'workspace');
    problem = readSolverProblem(workspace, bootstrapLocalExample(workspace).activeProblemPath);
    identity = { taskDigest: mathDigest(taskText), problemReceiptDigest: problem.receiptDigest };
    state = { schema: 'deepscientist.math.solver.v1', runId: 'reference-fixture', problem, taskDigest: identity.taskDigest,
      buildDigest: 'build', environmentDigest: 'environment', evaluatorDigest: 'evaluator', model: 'unused', effort: 'unused',
      worktree: workspace, phase: 'running', turns: 0,
      cooperation: { canonicalCommit: problem.baseCommit, tasks: [helper, ...problem.targets.map((target, index) => ({
        id: `goal_${index}`, kind: 'goal' as const, objective: 'Original goal', theoremName: target.theoremName,
        proofPath: target.proofPath, dependsOn: [], revision: 0 }))].map(task => ({ task, status: 'pending', attempts: 0 })) } };
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

  it('adds the ranked reference passage and its exact read command for the Lead and an assigned task', () => {
    const snapshot = freezeAttachments(directory, identity, [{ id: 'book', kind: 'reference', text: `${zeroLaws}\n\n${unrelated}` }]);
    const lead = build({ kind: 'lead', seedCommit: problem.baseCommit }, snapshot), found = references(lead);
    expect(found?.item).toMatchObject({ kind: 'continuation', required: false });
    expect(found!.text).toContain('not proof acceptance');
    const packet = JSON.parse(found!.text.slice(found!.text.indexOf('\n') + 1));
    expect(packet).toMatchObject({ schema: 'theorem-os.continuation-references.v1', snapshotDigest: snapshot.digest, ranking: 'bm25-lexical' });
    expect(packet.hits.map((hit: { id: string; startOffset: number }) => [hit.id, hit.startOffset])).toEqual([['book', 0]]);
    expect(packet.hits[0].readCommand).toContain(`continuation read --snapshot '${snapshot.file}'`);
    expect(packet.hits[0].readCommand).toContain('--offset 0');
    expect(lead.message).toContain('continuation search --snapshot');
    const task = build({ kind: 'task', task: helper,
      assignment: { taskId: helper.id, taskDigest: taskVersion(helper), workerId: 'helper', seedCommit: problem.baseCommit } }, snapshot);
    expect(JSON.parse(references(task)!.text.split('\n')[1]!).hits[0]).toMatchObject({ id: 'book', startOffset: 0,
      matchedTerms: ['adding', 'zero', 'right'] });
  });

  it('adds nothing without reference attachments, without a match, or for a review', () => {
    const plain = freezeAttachments(directory, identity, [{ id: 'notes', kind: 'research-notes', text: zeroLaws }], 'plain');
    const unmatched = freezeAttachments(directory, identity, [{ id: 'book', kind: 'reference', text: unrelated }], 'unmatched');
    const matched = freezeAttachments(directory, identity, [{ id: 'book', kind: 'reference', text: zeroLaws }], 'matched');
    const lead: CooperativeAction = { kind: 'lead', seedCommit: problem.baseCommit };
    for (const bundle of [build(lead, plain), build(lead, unmatched),
      build({ kind: 'review', seedCommit: problem.baseCommit, sourceDigest: 'fixed-source' }, matched)]) {
      expect(references(bundle)).toBeUndefined();
      expect(bundle.manifest!.omitted.some(item => item.id.startsWith('continuation-references:'))).toBe(false);
    }
  });
});
