import type { WebFormalization, WebFormalizationRequest, WebResearchBudget } from '../formalizationTypes';
import type { WebRun } from '../shared';
import type { WebGuidanceInput } from '../collaboration';
import { webConversationLimits } from '../conversationTypes';
import { decodeLibraryReferences, type ChatLibraryReference } from './chatReference';
import { webTaskEnvironment } from '../environment';

const schema = 'theorem-os.chat-draft.v1';
export type ChatDraftSettings = Required<Pick<WebFormalizationRequest,
  'providerId' | 'model' | 'environment' | 'effort' | 'maxRunSeconds' | 'maxTotalTokens' | 'research'>> & {
    participation: 'guided' | 'automatic'; research: WebResearchBudget; researchEffort?: WebFormalizationRequest['effort'];
    autoExplain?: boolean; explanationLanguage?: 'zh' | 'en';
  };
export type ChatGuidanceDraft = {
  text: string; active: boolean; references?: ChatLibraryReference[];
  runId: string; taskRef?: { id: string; version: string };
};
export type ChatPendingMessage = { requestId: string; text: string };
export type ChatPendingGuidance = { runId: string; input: WebGuidanceInput; draft: { text: string; locale: 'zh' | 'en' } };
export type ChatOriginalBackup = { text: string; settings?: ChatDraftSettings };
export type ChatDraft = { text: string; settings?: ChatDraftSettings; guidanceDraft?: ChatGuidanceDraft; pendingGuidance?: ChatPendingGuidance; pendingMessage?: ChatPendingMessage; references?: ChatLibraryReference[]; originalBackup?: ChatOriginalBackup };
/** History and an uncertain POST retain their settings; a new original uses the shared mathematics environment. */
export function editableChatSettings(settings: ChatDraftSettings, preserve = false): ChatDraftSettings {
  return preserve || settings.environment === webTaskEnvironment ? settings : { ...settings, environment: webTaskEnvironment };
}
export function readEditedProblemId(parameters: URLSearchParams): string {
  const id = parameters.get('editProblem') ?? '';
  return /^[A-Za-z0-9_-]{1,128}$/u.test(id) ? id : '';
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const budget = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const reference = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;

/** Old records may omit budgets; use the editable settings only for fields never recorded. */
export function historicalChatSettings(formalization: WebFormalization | undefined, run: WebRun | undefined, fallback: ChatDraftSettings): ChatDraftSettings {
  const research = formalization?.research ?? (run ? { maxRunSeconds: run.maxRunSeconds,
    maxTotalTokens: run.maxTotalTokens ?? 0, maxTurns: run.maxTurns } : fallback.research);
  const effort = formalization?.effort ?? (run && ['low', 'high', 'max'].includes(run.effort) ? run.effort as ChatDraftSettings['effort'] : fallback.effort);
  const researchEffort = formalization?.researchEffort ?? formalization?.effort
    ?? (run && ['low', 'high', 'max'].includes(run.effort) ? run.effort as ChatDraftSettings['effort'] : fallback.researchEffort ?? fallback.effort);
  const autoExplain = formalization?.autoExplain ?? run?.autoExplain ?? fallback.autoExplain;
  const explanationLanguage = formalization?.explanationLanguage ?? run?.explanationLanguage ?? fallback.explanationLanguage;
  return { providerId: formalization?.providerId ?? run?.providerId ?? fallback.providerId,
    model: formalization?.model ?? run?.model ?? fallback.model,
    environment: formalization?.environment ?? run?.environment ?? fallback.environment,
    effort, ...(researchEffort !== effort ? { researchEffort } : {}),
    ...(autoExplain === undefined ? {} : { autoExplain }), ...(explanationLanguage ? { explanationLanguage } : {}),
    participation: formalization ? formalization.humanReview ? 'guided' : 'automatic' : run ? run.planApproval ? 'guided' : 'automatic' : fallback.participation,
    maxRunSeconds: formalization?.maxRunSeconds ?? fallback.maxRunSeconds,
    maxTotalTokens: formalization?.maxTotalTokens ?? fallback.maxTotalTokens, research: { ...research } };
}

function guidance(value: unknown, legacy?: Pick<ChatGuidanceDraft, 'text' | 'references'>): ChatGuidanceDraft | undefined {
  if (!record(value) || !reference(value.runId)) return;
  const text = legacy ? legacy.text : value.text;
  if (typeof text !== 'string') return;
  let taskRef: ChatGuidanceDraft['taskRef'];
  if (value.taskRef !== undefined) {
    const task = value.taskRef;
    if (!record(task) || !reference(task.id) || !reference(task.version)) return;
    taskRef = { id: task.id, version: task.version };
  }
  const references = legacy ? legacy.references ?? [] : decodeLibraryReferences(value.references);
  return { text, active: Boolean(legacy) || value.active === true, runId: value.runId,
    ...(taskRef ? { taskRef } : {}),
    ...(references.length ? { references } : {}) };
}
function pendingMessage(value: unknown): ChatPendingMessage | undefined {
  if (!record(value) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value.requestId)
    || typeof value.text !== 'string' || !value.text.trim() || value.text.trim().length > webConversationLimits.question) return;
  return { requestId: value.requestId, text: value.text };
}

/** The chat composer sends only text to a Lead or a pinned task. */
function pendingGuidance(value: unknown): ChatPendingGuidance | undefined {
  if (!record(value) || !reference(value.runId) || !record(value.input) || !record(value.draft)) return;
  const { id, text, recipient, taskRef, observationRef } = value.input;
  const { text: draftText, locale } = value.draft;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(id) || typeof text !== 'string' || !text.trim()
    || typeof draftText !== 'string' || (locale !== 'zh' && locale !== 'en') || !record(recipient)
    || !record(observationRef) || typeof observationRef.sequence !== 'number' || !Number.isInteger(observationRef.sequence)
    || observationRef.sequence <= 0 || typeof observationRef.stateDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(observationRef.stateDigest)) return;
  const input = { id, text, observationRef: { sequence: observationRef.sequence, stateDigest: observationRef.stateDigest } };
  const draft = { text: draftText, locale } as const;
  if (recipient.kind === 'lead' && taskRef === undefined) return { runId: value.runId, draft, input: { ...input, recipient: { kind: 'lead' } } };
  if (recipient.kind === 'task' && record(taskRef) && typeof taskRef.id === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(taskRef.id)
    && recipient.id === taskRef.id && reference(taskRef.version) && taskRef.version.length <= 128) {
    return { runId: value.runId, draft, input: { ...input, recipient: { kind: 'task', id: taskRef.id }, taskRef: { id: taskRef.id, version: taskRef.version } } };
  }
}

function settings(value: unknown): ChatDraftSettings | undefined {
  if (!record(value) || typeof value.providerId !== 'string' || typeof value.model !== 'string'
    || !['standard', 'mathlib'].includes(String(value.environment)) || !['low', 'high', 'max'].includes(String(value.effort))
    || value.researchEffort !== undefined && !['low', 'high', 'max'].includes(String(value.researchEffort))
    || value.autoExplain !== undefined && typeof value.autoExplain !== 'boolean'
    || value.explanationLanguage !== undefined && !['zh', 'en'].includes(String(value.explanationLanguage))
    || !['guided', 'automatic'].includes(String(value.participation)) || !budget(value.maxRunSeconds) || !budget(value.maxTotalTokens)
    || !record(value.research) || !budget(value.research.maxRunSeconds) || !budget(value.research.maxTotalTokens) || !budget(value.research.maxTurns)) return;
  // Pick the nonsecret fields even when an older or extended object supplies extra properties.
  return { providerId: value.providerId, model: value.model, environment: value.environment as ChatDraftSettings['environment'],
    effort: value.effort as ChatDraftSettings['effort'], participation: value.participation as ChatDraftSettings['participation'],
    ...(value.researchEffort === undefined ? {} : { researchEffort: value.researchEffort as ChatDraftSettings['effort'] }),
    ...(value.autoExplain === undefined ? {} : { autoExplain: value.autoExplain as boolean }),
    ...(value.explanationLanguage === undefined ? {} : { explanationLanguage: value.explanationLanguage as 'zh' | 'en' }),
    maxRunSeconds: value.maxRunSeconds, maxTotalTokens: value.maxTotalTokens,
    research: { maxRunSeconds: value.research.maxRunSeconds, maxTotalTokens: value.research.maxTotalTokens, maxTurns: value.research.maxTurns } };
}

export function encodeChatDraft(draft: ChatDraft): string {
  const references = decodeLibraryReferences(draft.references);
  return JSON.stringify({ schema, text: draft.text, ...(draft.settings ? { settings: settings(draft.settings) } : {}),
    ...(draft.guidanceDraft ? { guidanceDraft: guidance(draft.guidanceDraft) } : {}),
    ...(draft.pendingGuidance ? { pendingGuidance: pendingGuidance(draft.pendingGuidance) } : {}),
    ...(draft.pendingMessage ? { pendingMessage: pendingMessage(draft.pendingMessage) } : {}),
    ...(references.length ? { references } : {}),
    ...(draft.originalBackup ? { originalBackup: { text: draft.originalBackup.text,
      ...(draft.originalBackup.settings ? { settings: settings(draft.originalBackup.settings) } : {}) } } : {}) });
}

export function decodeChatDraft(raw: string, onLegacyGuidance?: () => void): ChatDraft {
  try {
    const value: unknown = JSON.parse(raw);
    if (record(value) && value.schema === schema && typeof value.text === 'string') {
      const restored = settings(value.settings);
      const references = decodeLibraryReferences(value.references);
      // A saved draft from the shared editor belonged to the destination that was active.
      const splitGuidance = guidance(value.guidanceDraft);
      const legacy = splitGuidance ? undefined : guidance(value.guidance, { text: value.text, references });
      if (legacy) onLegacyGuidance?.();
      const guidanceDraft = splitGuidance ?? legacy, pending = pendingMessage(value.pendingMessage), guidanceAttempt = pendingGuidance(value.pendingGuidance);
      return { text: legacy ? '' : value.text, ...(restored ? { settings: restored } : {}),
        ...(guidanceDraft ? { guidanceDraft } : {}), ...(pending ? { pendingMessage: pending } : {}),
        ...(guidanceAttempt ? { pendingGuidance: guidanceAttempt } : {}),
        ...(!legacy && references.length ? { references } : {}),
        ...(record(value.originalBackup) && typeof value.originalBackup.text === 'string' ? { originalBackup: { text: value.originalBackup.text,
          ...(settings(value.originalBackup.settings) ? { settings: settings(value.originalBackup.settings) } : {}) } } : {}) };
    }
  } catch { /* Before this schema a draft was the exact original text. */ }
  return { text: raw };
}
