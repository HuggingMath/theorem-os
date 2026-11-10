import type { ResearchAssetKind, ResearchReleaseRef, FrozenResearchConfiguration } from './researchAssetTypes';

export type ResearchBookmarkTarget =
  | { kind: 'theorem'; projectId: string; statementVersionId?: string }
  | { kind: 'run'; runId: string; projectId?: string }
  | { kind: 'task'; runId: string; taskId: string; taskVersion: string; commit: string; projectId?: string }
  | { kind: 'release'; assetId: string; version: string; digest?: string };
export type ResearchBookmark = {
  id: string; target: ResearchBookmarkTarget; note: string; createdAt: string; updatedAt: string;
  available: boolean; title?: string; href?: string; assetType?: ResearchAssetKind;
};
export type ResearchCollection = {
  id: string; title: string; description: string; revision: number; createdAt: string; updatedAt: string; items: ResearchBookmark[];
};
export type ResearchCollectionPreparation = { refs: ResearchReleaseRef[]; configuration: FrozenResearchConfiguration };
export type ResearchAssetFollow = { assetId: string; available: boolean; title?: string; version?: string };
export type ResearchAssetUpdate = { assetId: string; title: string; fromVersion: string; toVersion: string; digest: string; releaseNotes?: string; createdAt: string };
export type ResearchAssetFollows = { items: ResearchAssetFollow[]; updates: ResearchAssetUpdate[] };
