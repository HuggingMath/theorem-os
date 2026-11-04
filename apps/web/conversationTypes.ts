import type { WebGuidanceInput } from './collaboration';

/** Chat history is independent of the proof/formalization task it discusses. */
export type WebConversationMessage = {
  id: string; role: 'user' | 'assistant'; kind: 'text' | 'task' | 'guidance'; text: string; createdAt: string;
  status: 'complete' | 'pending' | 'error' | 'interrupted'; replyTo?: string; error?: string; truncated?: true;
  guidance?: { runId: string; input: WebGuidanceInput; receipt?: { id: string; status: string; reason?: string; deliveredTo?: string[] } };
};
export type WebConversation = {
  id: string; title: string; createdAt: string; updatedAt: string;
  formalizationId?: string; runId?: string; messages: WebConversationMessage[];
};
export type WebConversationSummary = Omit<WebConversation, 'messages'> & { answering: boolean };
export const webConversationLimits = { question: 4_000, historyTurns: 8, messages: 202 } as const;
