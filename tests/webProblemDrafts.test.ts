import { describe, expect, it, vi } from 'vitest';
import { WebStorage } from '../apps/web/storage';
import { WebResearchProjects } from '../apps/web/researchProjects';
import { WebResearchPersonal } from '../apps/web/researchPersonal';
import type { WebResearchProblems } from '../apps/web/researchProblems';
import type { WebJobs } from '../apps/web/jobs';
import type { ProblemDraftValue } from '../apps/web/problemDraftTypes';
import type { TaskDraft } from '../apps/web/client/draft';
import { leanProblemDraft, problemDraftSignature } from '../apps/web/client/problemDrafts';
import { accountDraftHref } from '../apps/web/client/researchPersonal';

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
  return { get, personal: new WebResearchPersonal({ storage, projects, jobs: { get } as unknown as WebJobs, problems: {} as WebResearchProblems }) };
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
});
