import { describe, expect, it } from 'vitest';
import { parseFeedbackDraft, serializeFeedbackDraft, type FeedbackDraft } from '../docs/web/feedbackDraft';

const draft: FeedbackDraft = { kind: 'question', area: 'workbench', subject: '如何比较两条路线？',
  description: '  保留空行与公式：\n\n$\\sum_{i=1}^n i$\n<script>plain text</script>  ', environment: 'Linux · 中文' };

describe('feedback drafts', () => {
  it('preserves editable content exactly, independent of the page language', () => {
    expect(parseFeedbackDraft(serializeFeedbackDraft(draft))).toEqual(draft);
  });
  it('rejects malformed, oversized or incompatible stored input', () => {
    for (const raw of [null, '{', 'null', '{}', JSON.stringify({ ...draft, schema: 'old' }),
      serializeFeedbackDraft({ ...draft, description: 'x'.repeat(10001) }),
      JSON.stringify({ ...draft, schema: 'theoremos.feedback-draft.v1', kind: 'unknown' })]) {
      expect(parseFeedbackDraft(raw)).toBeUndefined();
    }
  });
  it('does not restore unrelated fields or interpret markup', () => {
    expect(parseFeedbackDraft(JSON.stringify({ ...draft, schema: 'theoremos.feedback-draft.v1', url: 'unexpected', sent: true }))).toEqual(draft);
  });
});
