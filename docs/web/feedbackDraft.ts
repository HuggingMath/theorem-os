export const feedbackDraftKey = 'theoremos:feedback-draft:v1';
export type FeedbackDraft = {
  kind: 'bug' | 'feature' | 'question';
  area: '' | 'workbench' | 'website' | 'lean' | 'access' | 'other';
  subject: string;
  description: string;
  environment: string;
};

/** Only the form's bounded, plain-text fields belong in a feedback draft. */
export function parseFeedbackDraft(raw: string | null): FeedbackDraft | undefined {
  if (!raw) return;
  try {
    const value = JSON.parse(raw);
    if (!value || value.schema !== 'theoremos.feedback-draft.v1'
      || !['bug', 'feature', 'question'].includes(value.kind)
      || !['', 'workbench', 'website', 'lean', 'access', 'other'].includes(value.area)
      || typeof value.subject !== 'string' || value.subject.length > 100
      || typeof value.description !== 'string' || value.description.length > 10000
      || typeof value.environment !== 'string' || value.environment.length > 240) return;
    return { kind: value.kind, area: value.area, subject: value.subject, description: value.description, environment: value.environment };
  } catch { return; }
}

export const serializeFeedbackDraft = (value: FeedbackDraft) => JSON.stringify({ schema: 'theoremos.feedback-draft.v1', ...value });
