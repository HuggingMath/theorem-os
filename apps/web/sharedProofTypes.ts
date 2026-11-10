import type { WebEnvironment } from './shared';
import type { WebShareSnapshot } from './shareTypes';

/** This ID is private to the recipient; it never identifies the author's private run or contains the share token. */
export type SharedProofReading = { id: string; digest: string; share: WebShareSnapshot };
export type SharedProofPreparation = {
  id: string; title: string; source: string; task: string; environment: WebEnvironment; preparedAt: string;
  origin: { kind: 'shared-proof'; readingId: string; title: string; sharedAt: string; digest: string;
    sourceDigest: string; proofDigest: string; href: string };
};
