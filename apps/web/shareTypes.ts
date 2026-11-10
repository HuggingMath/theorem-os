import type { ReportTone } from './report';
import type { WebEffort, WebEnvironment, WebFormalizationReport } from './shared';
import type { WebShareReading } from './shareReadingTypes';

/** The public payload is frozen when its owner creates a link. */
export type WebShareSnapshot = {
  schema: 'theorem-os.web-share.v1'; title: string; task: string; source: string; proof: string;
  environment: WebEnvironment; model: string; effort: WebEffort; workers: number;
  createdAt: string; finishedAt?: string; sharedAt: string;
  reading?: WebShareReading;
  formalization?: { original: string; confirmation?: 'automatic' | 'manual'; evidenceSha256: string;
    reviewMode?: 'direct';
    review?: Pick<WebFormalizationReport, 'backtranslation' | 'correspondences'> };
  checks: { label: string; status: string; tone: ReportTone; method?: string;
    targets: { name: string; status: string; tone: ReportTone; sorryCount?: number; admitCount?: number }[] }[];
  metrics: { label: string; value: string }[]; identity: { label: string; value: string }[];
};
export type WebShareLink = { token: string; url: string; createdAt: string };
export const webShareToken = /^[A-Za-z0-9_-]{32}$/u;
