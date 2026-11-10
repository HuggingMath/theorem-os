import type { WebInspectedTask, WebProofRoute } from './collaboration';
import type { WebExplanationDocument } from './shared';

export type WebShareExplanation = Pick<WebExplanationDocument, 'target' | 'language' | 'overview' | 'axioms' | 'sections' | 'metrics'> & { proofSha256: string };
export type WebShareReadingTask = {
  id: string; version: string; title: string; kind: WebInspectedTask['kind']; status: string;
  statement?: string; leanStatement?: string; reasoning?: string; finding?: string;
  premises: string[]; dependencies: string[]; conditions: { taskId: string; version: string }[];
  proof?: { commit: string; sourceDigest: string; receiptIds: string[] };
  source?: { file: string; code: string; commit: string; sha256: string; environmentDigest: string };
};
export type WebShareReading = {
  conditions: string[]; tasks: WebShareReadingTask[]; routes: WebProofRoute[];
  explanations: WebShareExplanation[];
};
export type WebShareReadingInput = { explanations?: readonly WebExplanationDocument[] };
