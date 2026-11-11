import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchPersonal } from '../apps/web/researchPersonal';
import type { WebResearchProblems } from '../apps/web/researchProblems';
import type { WebJobs } from '../apps/web/jobs';
import type { ProblemDraftValue } from '../apps/web/problemDraftTypes';
import type { TaskDraft } from '../apps/web/client/draft';
import { leanProblemDraft, problemDraftSignature } from '../apps/web/client/problemDrafts';
import { accountDraftHref } from '../apps/web/client/researchPersonal';
import { mathDigest } from '../src/math/mathRuntimeIo';
import type { WebRun } from '../apps/web/shared';
import type { WebFormalization } from '../apps/web/formalizationTypes';
import { matchesProblemRun } from '../apps/web/problemDraftSubmission';
import { captureProblemDraftSubmission, completeProblemDraftSubmission, readProblemDraftBinding, rememberProblemDraftBinding,
  resetProblemDraftBinding, problemDraftSyncPending, syncProblemDraftSubmissions, type ProblemDraftRequest } from '../apps/web/client/problemDraftLifecycle';

const alice = 'account:alice@example.org', bob = 'account:bob@example.org';
const natural: ProblemDraftValue = { mode: 'natural', text: '  设 $n\\in\\mathbb{N}$。\n证明 $n+0=n$。\n',
  settings: { providerId: 'fixture', model: 'draft-model', environment: 'standard', effort: 'high', participation: 'guided',
    maxRunSeconds: 120, maxTotalTokens: 20000, research: { maxRunSeconds: 480, maxTotalTokens: 40000, maxTurns: 5 } } };
const lean: TaskDraft = { providerId: 'fixture', model: 'lean-model', environment: 'mathlib', effort: 'max',
  source: 'import Mathlib\n\ntheorem draft (n : ℕ) : n + 0 = n := by\n  sorry\n', task: '用归纳法，并保留未完成的推导。',
  maxTurns: '7', maxRunSeconds: '900', maxTotalTokens: '12.5', workers: '3', coordination: 'cooperative', planApproval: true,
  templateId: '', modulePlan: { scheduler: 'critical-path', context: 'essential', custom: [] }, knowledgeDigest: null };
function fixture() {
  const storage = new WebStorage(), projects = new WebResearchProjects(storage), get = vi.fn(() => { throw new Error('No run access for an unsent problem'); });
  return { get, storage, personal: new WebResearchPersonal({ storage, projects, jobs: { get } as unknown as WebJobs, problems: {} as WebResearchProblems }) };
}
const input = (draftKey: string, value: ProblemDraftValue = natural, requestId = 'save', expectedRevision = 0) => ({
  scope: { kind: 'problem', draftKey }, value, requestId, expectedRevision, summary: '未完成的加法证明', deviceId: 'desktop', deviceName: 'Desktop', clientUpdatedAt: '2026-11-10T12:00:00.000Z',
});

describe('unsubmitted account problem drafts', () => {
  it('recognizes a restored value after storage has reordered nested object keys while detecting real edits', () => {
    const { personal } = fixture(), saved = personal.saveDraft(alice, input('ordered-value'));
    const restored = personal.draft(alice, saved.draft.id).version.value as ProblemDraftValue;
    expect(problemDraftSignature(restored, saved.version.summary)).toBe(problemDraftSignature(natural, saved.version.summary));
    expect(problemDraftSignature({ ...natural, text: natural.text + '\nnew step' }, saved.version.summary)).not.toBe(problemDraftSignature(natural, saved.version.summary));
    expect(problemDraftSignature(natural, 'renamed draft')).not.toBe(problemDraftSignature(natural, saved.version.summary));
  });
  it('keeps independently named problems with exact text and safe settings without a project or run', () => {
    const { personal, get } = fixture();
    const first = personal.saveDraft(alice, input('natural-one'));
    const second = personal.saveDraft(alice, { ...input('natural-two'), summary: '第二份原题' });
    expect(first.draft.id).not.toBe(second.draft.id);
    expect(personal.draft(alice, first.draft.id).version.value).toEqual(natural);
    expect(personal.drafts(alice, undefined, 'problem').items).toHaveLength(2);
    expect(personal.drafts(bob, undefined, 'problem').items).toEqual([]);
    expect(() => personal.draft(bob, first.draft.id)).toThrow('不存在');
    expect(() => personal.saveDraft('anonymous', input('unauthenticated'))).toThrow('登录账号');
    expect(get).not.toHaveBeenCalled();
    expect(accountDraftHref(first.draft, first.version.id)).toBe(`./?accountDraft=${first.draft.id}&draftVersion=${first.version.id}`);
  });

  it('keeps parallel device versions, retries idempotently, and restores a selected archived version', () => {
    const { personal } = fixture(), original = input('same-problem');
    const first = personal.saveDraft(alice, original), retry = personal.saveDraft(alice, original);
    expect(retry.version.id).toBe(first.version.id); expect(retry.draft.revision).toBe(1);
    const desktop = personal.saveDraft(alice, input('same-problem', { ...natural, text: 'Desktop derivation' }, 'desktop-2', 1));
    const phone = personal.saveDraft(alice, { ...input('same-problem', { ...natural, text: 'Phone derivation' }, 'phone-2', 1), deviceId: 'phone' });
    expect(desktop.conflict).toBe(false); expect(phone.conflict).toBe(true);
    expect(personal.draft(alice, first.draft.id, desktop.version.id).version.value).toEqual({ ...natural, text: 'Desktop derivation' });
    expect(personal.draft(alice, first.draft.id, phone.version.id).version.value).toEqual({ ...natural, text: 'Phone derivation' });
    personal.updateDraft(alice, first.draft.id, { requestId: 'archive', versionId: phone.version.id, action: 'discard' });
    expect(personal.drafts(alice, undefined, 'problem').items[0].versions).toHaveLength(2);
    personal.updateDraft(alice, first.draft.id, { requestId: 'restore', versionId: phone.version.id, action: 'restore' });
    expect(personal.drafts(alice, undefined, 'problem').items[0].versions).toHaveLength(3);
    expect(() => personal.saveDraft(alice, { ...original, value: { ...natural, text: 'different retry body' } })).toThrow('另一份账号草稿');
  });

  it('preserves Lean configuration and exact selected releases while excluding secrets and execution identities', () => {
    const { personal } = fixture();
    const value = leanProblemDraft({ ...lean, apiKey: 'never-save-this', formalization: { id: crypto.randomUUID(), evidenceSha256: 'a'.repeat(64) },
      continueFrom: { runId: crypto.randomUUID(), taskId: 'task', commit: 'a'.repeat(40), label: 'old accepted result' }, problemBudget: { runId: crypto.randomUUID() } } as TaskDraft,
      [{ assetId: 'math-library', version: '1.2.0', digest: 'b'.repeat(64) }]);
    expect(value.draft).toEqual(lean); expect(JSON.stringify(value)).not.toMatch(/never-save-this|formalization|continueFrom|problemBudget/);
    const saved = personal.saveDraft(alice, input('lean-one', value));
    expect(personal.draft(alice, saved.draft.id).version.value).toEqual(value);
    expect(leanProblemDraft({ ...lean, source: 'x'.repeat(40000) }).draft.source).toHaveLength(40000);
    for (const forbidden of ['apiKey', 'formalization', 'continueFrom', 'problemBudget']) {
      expect(() => personal.saveDraft(alice, { ...input('reject-key'), value: { ...value, draft: { ...lean, [forbidden]: 'unsafe' } } })).toThrow('请求格式无效');
    }
    expect(() => personal.saveDraft(alice, { ...input('natural-secret'), value: { ...natural, settings: { ...natural.settings, apiKey: 'secret' } } })).toThrow('请求格式无效');
    expect(() => personal.saveDraft(alice, { ...input('no-project'), scope: { kind: 'problem', draftKey: 'no-project', projectId: 'project' } })).toThrow('新题草稿范围无效');
    expect(() => personal.saveDraft(alice, { ...input('missing-id'), scope: { kind: 'problem' } })).toThrow('新题草稿范围无效');
    expect(() => personal.saveDraft(alice, { ...input('other-kind'), scope: { kind: 'review', draftKey: 'other-kind' }, value: { text: 'wrong scope' } })).toThrow('新题草稿范围无效');
  });
  it('keeps recipient-owned source references across account draft versions without carrying a share capability or proof acceptance', () => {
    const { personal } = fixture();
    const origin = { readingId: 'shared_recipient_reference', title: 'A proof to revisit', digest: 'c'.repeat(64) };
    const value = leanProblemDraft({ ...lean, sharedProofOrigin: origin });
    const saved = personal.saveDraft(alice, input('shared-problem', value));
    const restored = personal.draft(alice, saved.draft.id).version.value;
    expect(restored).toMatchObject({ mode: 'lean', draft: { sharedProofOrigin: origin, source: lean.source } });
    expect(JSON.stringify(restored)).not.toMatch(/shareToken|continueFrom|proofDigest|acceptance/);
    for (const patch of [{ digest: 'invalid' }, { readingId: '../foreign' }, { token: 'a'.repeat(32) }, { href: 'https://unrelated.invalid' }]) {
      expect(() => personal.saveDraft(alice, input('invalid-reference', { ...value, draft: { ...value.draft, sharedProofOrigin: { ...origin, ...patch } } }))).toThrow('请求格式无效');
    }
    expect(() => personal.draft(bob, saved.draft.id)).toThrow('不存在');
  });
  it('preserves a complete classic original and its source reference in an account draft', () => {
    const { personal } = fixture();
    const origin = { id: 'classic-original', title: 'A classic certificate problem', sourceSha256: 'a'.repeat(64) };
    const source = `${lean.source}\n${'-- recorded certificate data\n'.repeat(3000)}`;
    const value = leanProblemDraft({ ...lean, source, classicOrigin: origin });
    const saved = personal.saveDraft(alice, input('classic-problem', value));
    expect(personal.draft(alice, saved.draft.id).version.value).toMatchObject({ mode: 'lean', draft: { source, classicOrigin: origin } });
    expect(() => personal.draft(bob, saved.draft.id)).toThrow('不存在');
  });
  it('preserves a fixed Library proposal reference without carrying approval or execution state', () => {
    const { personal } = fixture();
    const origin = { projectId: 'project-one', feedbackId: 'feedback-one', trialDigest: 'c'.repeat(64) };
    const value = leanProblemDraft({ ...lean, libraryProposalOrigin: origin });
    const saved = personal.saveDraft(alice, input('proposal-problem', value));
    expect(personal.draft(alice, saved.draft.id).version.value).toMatchObject({ mode: 'lean', draft: { libraryProposalOrigin: origin } });
    for (const patch of [{ trialDigest: 'bad' }, { projectId: '../foreign' }, { approved: true }]) {
      expect(() => personal.saveDraft(alice, input('invalid-proposal', { ...value, draft: { ...value.draft, libraryProposalOrigin: { ...origin, ...patch } } }))).toThrow('请求格式无效');
    }
    expect(() => personal.draft(bob, saved.draft.id)).toThrow('不存在');
  });
});


function storeFormalization(storage: WebStorage, owner: string, id: string, value: Extract<ProblemDraftValue, { mode: 'natural' }> = natural as Extract<ProblemDraftValue, { mode: 'natural' }>) {
  const { participation, ...settings } = value.settings;
  storage.saveRecord(['owners', mathDigest(owner), 'formalizations', id, 'record.json'], { owner, formalization: {
    id, original: value.text, ...settings, model: settings.model.trim(), workflow: 'solve', humanReview: participation === 'guided',
    status: 'review', createdAt: '2026-11-10T12:00:00.000Z', updatedAt: '2026-11-10T12:00:00.000Z',
  } satisfies WebFormalization });
}
function stubTab() {
  const values = new Map<string, string>();
  vi.stubGlobal('sessionStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) });
  return values;
}
afterEach(() => vi.unstubAllGlobals());

describe('problem draft submission lifecycle', () => {
  it('stores separate proof effort and archives only a formalization with matching proof settings', () => {
    const { personal, storage } = fixture();
    const separate = { ...natural, settings: { ...natural.settings, effort: 'high' as const, researchEffort: 'max' as const } };
    const first = personal.saveDraft(alice, input('separate-proof-effort', separate));
    expect(first.version.value).toEqual(separate);
    storeFormalization(storage, alice, 'wrong-proof-effort', { ...separate, settings: { ...separate.settings, researchEffort: 'high' } });
    const complete = (id: string) => personal.updateDraft(alice, first.draft.id, { requestId: id, versionId: first.version.id,
      action: 'submitted', submission: { kind: 'formalization', id } });
    expect(() => complete('wrong-proof-effort')).toThrow();
    storeFormalization(storage, alice, 'matching-proof-effort', separate);
    expect(complete('matching-proof-effort').version.status).toBe('submitted');
  });
  it('archives only the confirmed natural branch and links its actual formalization', () => {
    const { personal, storage } = fixture();
    const first = personal.saveDraft(alice, input('submitted-natural'));
    const changed = { ...natural, text: 'Submitted exact original' };
    const submitted = personal.saveDraft(alice, input('submitted-natural', changed, 'desktop', 1));
    const parallel = personal.saveDraft(alice, input('submitted-natural', { ...natural, text: 'Phone edits' }, 'phone', 1));
    storeFormalization(storage, alice, 'accepted-original', changed);
    personal.updateDraft(alice, first.draft.id, { requestId: 'complete', versionId: submitted.version.id, action: 'submitted', submission: { kind: 'formalization', id: 'accepted-original' } });
    expect(personal.drafts(alice, undefined, 'problem').items[0].versions.map(item => item.id)).toEqual([parallel.version.id]);
    const archived = personal.draft(alice, first.draft.id, submitted.version.id).version;
    expect(archived.submission).toEqual({ kind: 'formalization', id: 'accepted-original', href: 'formalize.html?id=accepted-original' });
    expect(personal.draft(alice, first.draft.id, first.version.id).version.status).toBe('submitted');
  });
  it('refuses foreign, missing, mismatched original and mismatched settings records without changing the draft', () => {
    const { personal, storage } = fixture(), first = personal.saveDraft(alice, input('refused-natural'));
    const complete = (id: string) => personal.updateDraft(alice, first.draft.id, { requestId: id, versionId: first.version.id, action: 'submitted', submission: { kind: 'formalization', id } });
    storeFormalization(storage, bob, 'foreign');
    storeFormalization(storage, alice, 'wrong-text', { ...natural, text: 'Different problem' });
    storeFormalization(storage, alice, 'wrong-budget', { ...natural, settings: { ...natural.settings, maxTotalTokens: 100 } });
    for (const id of ['missing', 'foreign', 'wrong-text', 'wrong-budget']) expect(() => complete(id)).toThrow();
    expect(personal.drafts(alice, undefined, 'problem').items[0].versions).toHaveLength(1);
  });
  it('matches Lean source, instructions, budget, plan and library versions to the actual owned run', () => {
    const { personal, get } = fixture();
    const value = leanProblemDraft(lean);
    const run = { id: 'lean-run', ...lean, source: lean.source.trim(), task: lean.task.trim(), maxTurns: 7, maxRunSeconds: 900, maxTotalTokens: 125000, workers: 3, knowledgeDigest: undefined } as unknown as WebRun;
    get.mockImplementation(() => run as never);
    const saved = personal.saveDraft(alice, input('submitted-lean', value));
    const archived = personal.updateDraft(alice, saved.draft.id, { requestId: 'lean-complete', versionId: saved.version.id, action: 'submitted', submission: { kind: 'run', id: run.id } });
    expect(archived.version.submission?.href).toBe('./?run=lean-run');
    expect(get).toHaveBeenCalledWith(alice, run.id);
    for (const patch of [{ source: 'different source' }, { task: 'other instructions' }, { model: 'other-model' }, { maxTotalTokens: 12000 }, { workers: 2 }, { planApproval: false }, { knowledgeDigest: 'unexpected' }, { modulePlan: { scheduler: 'plan', context: 'full', custom: [] } }]) {
      expect(matchesProblemRun(value, { ...run, ...patch } as WebRun)).toBe(false);
    }
    expect(matchesProblemRun({ ...value, libraries: [{ assetId: 'missing-library', version: '1' }] }, run)).toBe(false);
    expect(matchesProblemRun(natural, run)).toBe(false);
  });
  it('matches endpoint whitespace normalization while keeping internal source and instruction changes distinct', () => {
    const value = leanProblemDraft({ ...lean, source: '  theorem target : True := by\n  sorry\n', task: '  Prove True\n' });
    const run = { ...lean, source: value.draft.source.trim(), task: value.draft.task.trim(), maxTurns: 7, maxRunSeconds: 900, maxTotalTokens: 125000, workers: 3, knowledgeDigest: undefined } as unknown as WebRun;
    expect(matchesProblemRun(value, run)).toBe(true);
    expect(matchesProblemRun(value, { ...run, source: run.source.replace('\n  sorry', '\nsorry') })).toBe(false);
    expect(matchesProblemRun(value, { ...run, task: 'Prove  True' })).toBe(false);
  });
  it('keeps the baseline through tab reload and resets explicit new problems independently', () => {
    stubTab(); const owner = crypto.randomUUID();
    const first = readProblemDraftBinding(owner, 'natural');
    const savedSignature = problemDraftSignature(natural, 'Saved name');
    rememberProblemDraftBinding(owner, 'natural', { ...first, revision: 1, title: 'Renamed locally', savedSignature });
    const restored = readProblemDraftBinding(owner, 'natural');
    expect(restored.savedSignature).toBe(savedSignature);
    expect(problemDraftSignature(natural, restored.title)).not.toBe(savedSignature);
    resetProblemDraftBinding(owner, 'natural');
    const next = readProblemDraftBinding(owner, 'natural');
    expect(next.draftKey).not.toBe(first.draftKey); expect(next.title).toBe(''); expect(next.revision).toBe(0);
    expect(captureProblemDraftSubmission(owner, natural)).toBeUndefined();
  });
  it('saves and archives the submitted snapshot after edits, preserving a later parallel version and idempotent archive retries', async () => {
    stubTab(); const owner = `account:${crypto.randomUUID()}@example.org`;
    const { personal, storage } = fixture(), saved = personal.saveDraft(owner, input('edited-submit'));
    rememberProblemDraftBinding(owner, 'natural', { draftKey: 'edited-submit', revision: 1, title: 'Renamed submitted original', draftId: saved.draft.id, versionId: saved.version.id, savedSignature: problemDraftSignature(natural, saved.version.summary) });
    const changed = { ...natural, text: 'Exact submitted change' }, snapshot = captureProblemDraftSubmission(owner, changed)!;
    changed.text = 'Later editor content';
    const parallel = personal.saveDraft(owner, input('edited-submit', { ...natural, text: 'Parallel phone version' }, 'phone', 1));
    storeFormalization(storage, owner, 'confirmed-snapshot', snapshot.value as Extract<ProblemDraftValue, { mode: 'natural' }>);
    let loseSaveReply = true;
    const request: ProblemDraftRequest = async <T>(url: string, init?: RequestInit) => {
      const parsed = new URL(url, 'http://fixture'), id = parsed.pathname.split('/').at(-1)!;
      if (init?.method === 'POST') { const item = personal.saveDraft(owner, JSON.parse(String(init.body))); if (loseSaveReply) { loseSaveReply = false; throw new TypeError('reply lost'); } return { item } as T; }
      if (init?.method === 'PATCH') return { item: personal.updateDraft(owner, id, JSON.parse(String(init.body))) } as T;
      return { item: personal.draft(owner, id, parsed.searchParams.get('version') ?? undefined) } as T;
    };
    expect(await completeProblemDraftSubmission(snapshot, { kind: 'formalization', id: 'confirmed-snapshot' }, request)).toBe(false);
    expect(problemDraftSyncPending(owner)).toBe(true);
    expect(personal.drafts(owner, undefined, 'problem').items[0].versions).toHaveLength(3);
    expect(await syncProblemDraftSubmissions(owner, request)).toBe(true);
    const all = personal.drafts(owner, undefined, 'problem', 'all').items[0];
    expect(all.versions).toHaveLength(3);
    expect(all.versions[0]).toMatchObject({ summary: 'Renamed submitted original', status: 'submitted', submission: { id: 'confirmed-snapshot' } });
    expect(personal.draft(owner, all.id, all.versions[0].id).version.value).toEqual(snapshot.value);
    expect(personal.drafts(owner, undefined, 'problem').items[0].versions.map(item => item.id)).toEqual([parallel.version.id]);
    expect(problemDraftSyncPending(owner)).toBe(false);
    expect(readProblemDraftBinding(owner, 'natural').revision).toBe(0);
  });
  it('does not create account versions for never-saved problems and preserves saved versions until a task is confirmed', async () => {
    stubTab(); const owner = crypto.randomUUID(), request = vi.fn();
    expect(await completeProblemDraftSubmission(captureProblemDraftSubmission(owner, natural), { kind: 'formalization', id: 'accepted' }, request)).toBe(true);
    expect(request).not.toHaveBeenCalled();
    rememberProblemDraftBinding(owner, 'natural', { draftKey: 'unknown-send', revision: 2, title: 'Unconfirmed' });
    expect(captureProblemDraftSubmission(owner, natural)?.binding.revision).toBe(2);
    expect(problemDraftSyncPending(owner)).toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(readProblemDraftBinding(owner, 'natural').revision).toBe(2);
  });
});
