import { decodeTaskDraft, encodeTaskDraft, type TaskDraft } from './draft';
import type { ResearchReleaseRef } from '../researchAssetTypes';

export const draftRecoveryStorageKey = 'theorem-os.web-draft-recovery.v1';
export const replacementReasons = ['template', 'reset', 'reuse', 'import', 'source', 'edit', 'paste'] as const;
export type ReplacementReason = typeof replacementReasons[number];
type Recovery = { draft: TaskDraft; libraries?: ResearchReleaseRef[]; reason: ReplacementReason; persisted: boolean };
type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Keep one replacement, including its fixed research context, independent of autosave.
function copyDraft(draft: TaskDraft): TaskDraft {
  return { providerId: draft.providerId, model: draft.model, source: draft.source, task: draft.task,
    maxTurns: draft.maxTurns, maxRunSeconds: draft.maxRunSeconds, workers: draft.workers,
    ...(draft.maxTotalTokens !== undefined ? { maxTotalTokens: draft.maxTotalTokens } : {}),
    effort: draft.effort, environment: draft.environment, coordination: draft.coordination, templateId: draft.templateId,
    ...(draft.researchMode ? { researchMode: draft.researchMode } : {}),
    ...(draft.skillLoading ? { skillLoading: draft.skillLoading } : {}),
    ...(draft.nativeTeamCapacity ? { nativeTeamCapacity: draft.nativeTeamCapacity } : {}),
    ...(draft.nativeTeamCapacity && draft.nativeTeamPreferredProfiles ? { nativeTeamPreferredProfiles: [...draft.nativeTeamPreferredProfiles] } : {}),
    ...(draft.planApproval ? { planApproval: true as const } : {}),
    ...(draft.formalization ? { formalization: { ...draft.formalization } } : {}),
    ...(draft.knowledgeDigest !== undefined ? { knowledgeDigest: draft.knowledgeDigest } : {}),
    ...(draft.continueFrom ? { continueFrom: { ...draft.continueFrom } } : {}),
    ...(draft.problemBudget ? { problemBudget: { ...draft.problemBudget } } : {}),
    ...(draft.sharedProofOrigin ? { sharedProofOrigin: { ...draft.sharedProofOrigin } } : {}),
    ...(draft.classicOrigin ? { classicOrigin: { ...draft.classicOrigin } } : {}),
    ...(draft.libraryProposalOrigin ? { libraryProposalOrigin: { ...draft.libraryProposalOrigin } } : {}),
    ...(draft.modulePlan ? { modulePlan: structuredClone(draft.modulePlan) } : {}) };
}

function copyLibraries(value: unknown): ResearchReleaseRef[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid recovery libraries');
  return value.map(ref => {
    if (!ref || typeof ref !== 'object' || typeof ref.assetId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(ref.assetId)
      || typeof ref.version !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/u.test(ref.version)
      || ref.digest !== undefined && (typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(ref.digest))) throw new Error('Invalid recovery libraries');
    return { assetId: ref.assetId, version: ref.version, ...(ref.digest ? { digest: ref.digest } : {}) };
  });
}

export class DraftRecovery {
  private value?: Recovery;

  constructor(private readonly storage: () => RecoveryStorage) {}

  get current(): Recovery | undefined {
    return this.value ? { ...this.value, draft: copyDraft(this.value.draft),
      ...(this.value.libraries ? { libraries: copyLibraries(this.value.libraries) } : {}) } : undefined;
  }

  load() {
    this.value = undefined;
    try {
      const stored = this.storage().getItem(draftRecoveryStorageKey);
      if (!stored) return;
      const envelope: unknown = JSON.parse(stored);
      if (!envelope || typeof envelope !== 'object' || !Object.hasOwn(envelope, 'schema')
        || !Object.hasOwn(envelope, 'reason') || !Object.hasOwn(envelope, 'task')) throw new Error('Invalid recovery');
      const item = envelope as Record<string, unknown>;
      if (item.schema !== draftRecoveryStorageKey || !replacementReasons.includes(item.reason as ReplacementReason)) throw new Error('Invalid recovery');
      this.value = { draft: decodeTaskDraft(item.task), reason: item.reason as ReplacementReason, persisted: true,
        ...(Object.hasOwn(item, 'libraries') ? { libraries: copyLibraries(item.libraries) } : {}) };
    } catch { this.removeStored(); }
  }

  remember(before: TaskDraft, after: TaskDraft, reason: ReplacementReason, libraries?: ResearchReleaseRef[]) {
    const draft = copyDraft(before);
    if (JSON.stringify(draft) === JSON.stringify(copyDraft(after))) return;
    this.value = { draft, reason, persisted: false, ...(libraries ? { libraries: copyLibraries(libraries) } : {}) };
    try {
      const task: unknown = JSON.parse(encodeTaskDraft(draft));
      this.storage().setItem(draftRecoveryStorageKey, JSON.stringify({ schema: draftRecoveryStorageKey, reason, task,
        ...(this.value.libraries ? { libraries: this.value.libraries } : {}) }));
      this.value.persisted = true;
    } catch { this.removeStored(); }
  }

  clear() {
    this.value = undefined;
    this.removeStored();
  }

  private removeStored() {
    try { this.storage().removeItem(draftRecoveryStorageKey); } catch { /* In-memory recovery remains usable. */ }
  }
}
