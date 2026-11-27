import { describe, expect, it } from 'vitest';
import { readIssueExecutionNotes } from '../apps/web/client/researchIssueExecutionDraft';
import { completeIssueReply, type IssueReplyDraft } from '../apps/web/client/researchIssueReplyDraft';

describe('historical issue drafts', () => {
  const scope = { owner: 'alice', projectId: 'project', issueId: 'issue' };
  const key = (kind: string) => 'theoremos:issue-execution-' + kind + ':v1:' + encodeURIComponent(JSON.stringify(['alice', 'project', 'issue']));

  it('reads the local draft and original submission within their account and issue', () => {
    const records = new Map([
      [key('draft'), JSON.stringify({ text: 'Updated instructions', objective: 'Show the witness', dependencies: 'lemma-a' })],
      [key('pending'), JSON.stringify({ input: { text: 'Original instructions', issueSource: { issueId: 'issue' } }, draft: { objective: 'Show the witness' } })],
    ]);
    const storage = { getItem: (name: string) => records.get(name) ?? null };
    expect(readIssueExecutionNotes(storage, scope)).toEqual(['Updated instructions', 'Show the witness', 'lemma-a', 'Original instructions']);
    expect(readIssueExecutionNotes(storage, { ...scope, owner: 'bob' })).toEqual([]);
    expect(readIssueExecutionNotes(storage, { ...scope, issueId: 'another' })).toEqual([]);
  });

  it('still reads a valid draft if the original attempt refers to a different issue', () => {
    const draft = JSON.stringify({ text: 'Keep this draft' });
    const pending = JSON.stringify({ input: { text: 'Other issue', issueSource: { issueId: 'other' } } });
    const storage = { getItem: (name: string) => name === key('draft') ? draft : pending };
    expect(readIssueExecutionNotes(storage, scope)).toEqual(['Keep this draft']);
  });
});

describe('issue contribution completion', () => {
  const reply = (): IssueReplyDraft => ({ text: 'Reply to A', kind: 'comment', replyTo: 'proposal-a', proposalId: '', feedbackId: '', revision: 2 });
  it('clears only an unchanged submitted snapshot', () => {
    expect(completeIssueReply(reply(), reply(), 3)).toEqual({ ...reply(), text: '', replyTo: '', revision: 3 });
  });
  it('preserves the complete later reply, including a different target with the same body', () => {
    for (const newer of [{ ...reply(), text: 'New argument for B', replyTo: 'proposal-b' }, { ...reply(), replyTo: 'proposal-b' },
      { ...reply(), kind: 'proposal', feedbackId: 'feedback-b', proposalId: 'proposal-b' }])
      expect(completeIssueReply(newer, reply(), 3)).toEqual({ ...newer, revision: 3 });
  });
});
