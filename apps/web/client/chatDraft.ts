import type { WebFormalizationRequest, WebResearchBudget } from '../formalizationTypes';
import { webConversationLimits } from '../conversationTypes';
import { decodeLibraryReferences, type ChatLibraryReference } from './chatReference';

const schema = 'theorem-os.chat-draft.v1';
export type ChatDraftSettings = Required<Pick<WebFormalizationRequest,
  'providerId' | 'model' | 'environment' | 'effort' | 'maxRunSeconds' | 'maxTotalTokens' | 'research'>> & {
    participation: 'guided' | 'automatic'; research: WebResearchBudget;
  };
export type ChatGuidanceDraft = { runId: string; taskRef?: { id: string; version: string } };
export type ChatPendingMessage = { requestId: string; text: string };
export type ChatDraft = { text: string; settings?: ChatDraftSettings; guidance?: ChatGuidanceDraft; pendingMessage?: ChatPendingMessage; references?: ChatLibraryReference[] };
export function readEditedProblemId(parameters: URLSearchParams): string {
  const id = parameters.get('editProblem') ?? '';
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const budget = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;

function guidance(value: unknown): ChatGuidanceDraft | undefined {
  if (!record(value) || !reference(value.runId)) return;
  if (value.taskRef === undefined) return { runId: value.runId };
  if (!record(value.taskRef) || !reference(value.taskRef.id) || !reference(value.taskRef.version)) return;
  return { runId: value.runId, taskRef: { id: value.taskRef.id, version: value.taskRef.version } };
}
function pendingMessage(value: unknown): ChatPendingMessage | undefined {
  if (!record(value) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.trim().length > webConversationLimits.question) return;
  return { requestId: value.requestId, text: value.text };
}

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
  const references = decodeLibraryReferences(draft.references);
  return JSON.stringify({ schema, text: draft.text, ...(draft.settings ? { settings: settings(draft.settings) } : {}),
    ...(draft.guidance ? { guidance: guidance(draft.guidance) } : {}),
    ...(draft.pendingMessage ? { pendingMessage: pendingMessage(draft.pendingMessage) } : {}),
    ...(references.length ? { references } : {}) });
}

export function decodeChatDraft(raw: string): ChatDraft {
  try {
    const value: unknown = JSON.parse(raw);
    if (record(value) && value.schema === schema && typeof value.text === 'string') {
      const restored = settings(value.settings);
      const references = decodeLibraryReferences(value.references);
      const restoredGuidance = guidance(value.guidance), pending = pendingMessage(value.pendingMessage);
      return { text: value.text, ...(restored ? { settings: restored } : {}),
        ...(restoredGuidance ? { guidance: restoredGuidance } : {}), ...(pending ? { pendingMessage: pending } : {}), ...(references.length ? { references } : {}) };
    }
  } catch { /* Before this schema a draft was the exact original text. */ }
  return { text: raw };
}
