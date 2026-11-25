import type { PaperDraft, PaperLanguage } from '../../src/math/paperDraft';
import type { PaperPhase } from '../../src/solver/paperDraft';

export type WebPaperDraftJob = {
  id: string;
  runId: string;
  target: string;
  language: PaperLanguage;
  leanSha256: string;
  templateVersion: string;
  createdAt: string;
  providerId?: string;
  model?: string;
  status: PaperPhase | 'done' | 'error';
  draft?: PaperDraft;
  error?: string;
};

export type WebPaperProvider = {
  id: string;
  name: string;
  defaultModel: string;
  key: 'required' | 'saved' | 'server';
};

export type WebPaperOverview = {
  title: string;
  targets: string[];
  target: string;
  language: PaperLanguage;
  providers: WebPaperProvider[];
  defaultProviderId?: string;
  job?: WebPaperDraftJob;
};
