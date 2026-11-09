import type { WebFormalizationRequest } from '../formalizationTypes';

const schema = 'theorem-os.chat-draft.v1';
export type ChatDraftSettings = Required<Pick<WebFormalizationRequest,
  'providerId' | 'model' | 'environment' | 'effort' | 'maxRunSeconds' | 'maxTotalTokens' | 'research'>> & {
    participation: 'guided' | 'automatic';
  };
export type ChatDraft = { text: string; settings?: ChatDraftSettings };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const budget = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function settings(value: unknown): ChatDraftSettings | undefined {
  if (!record(value) || typeof value.providerId !== 'string' || typeof value.model !== 'string'
    || !['standard', 'mathlib'].includes(String(value.environment)) || !['low', 'high', 'max'].includes(String(value.effort))
    || !['guided', 'automatic'].includes(String(value.participation)) || !budget(value.maxRunSeconds) || !budget(value.maxTotalTokens)
    || !record(value.research) || !budget(value.research.maxRunSeconds) || !budget(value.research.maxTotalTokens) || !budget(value.research.maxTurns)) return;
  // Pick the nonsecret fields even when an older or extended object supplies extra properties.
  return { providerId: value.providerId, model: value.model, environment: value.environment as ChatDraftSettings['environment'],
    effort: value.effort as ChatDraftSettings['effort'], participation: value.participation as ChatDraftSettings['participation'],
    maxRunSeconds: value.maxRunSeconds, maxTotalTokens: value.maxTotalTokens,
    research: { maxRunSeconds: value.research.maxRunSeconds, maxTotalTokens: value.research.maxTotalTokens, maxTurns: value.research.maxTurns } };
}

export function encodeChatDraft(draft: ChatDraft): string {
  return JSON.stringify({ schema, text: draft.text, ...(draft.settings ? { settings: settings(draft.settings) } : {}) });
}

export function decodeChatDraft(raw: string): ChatDraft {
  try {
    const value: unknown = JSON.parse(raw);
    if (record(value) && value.schema === schema && typeof value.text === 'string') {
      const restored = settings(value.settings);
      return { text: value.text, ...(restored ? { settings: restored } : {}) };
    }
  } catch { /* Before this schema a draft was the exact original text. */ }
  return { text: raw };
}
