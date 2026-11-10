import type { ProofWalkthrough } from './proofWalkthroughTypes';

export interface ArchiveSource {
  name: string;
  path: string;
  url: string;
  sha256: string;
  lines: number;
  code: string;
}

export interface ArchiveRecord {
  id: string;
  title: string;
  subtitle: string;
  area: string;
  summary: string;
  /** English display text; the default fields are Chinese. */
  en?: { subtitle: string; area: string; summary: string };
  status: 'official_accepted' | 'locally_verified' | 'in_progress_not_officially_accepted';
  model: string;
  updatedAt: string;
  archiveUrl: string;
  sources: ArchiveSource[];
  declaration?: string;
  campaign?: {
    target: string;
    runId: string;
    targets: string[];
    proofCommit: string;
    proofSha256: string;
    kernelReceiptIds: string[];
    comparatorExitCode: number;
    reviewStatus?: string;
    attribution: string;
    attributionEn?: string;
    evidenceUrl: string;
  };
  processSummary?: { runs: number; tasks: number; version?: string };
  process?: ArchiveProcess;
  official?: {
    statementRevision: number;
    submissionUrl: string;
    resultUrl: string;
    resultBody: string;
    sourceUrl: string;
    sourceCommit: string;
    checksums: Record<string, string>;
  };
  local?: {
    status: string;
    kernelVerified: boolean;
    comparator?: string;
    receipt?: string;
    sourceProofCommit?: string;
    sourceBinding: 'matches' | 'differs' | 'unrecorded';
    axioms: string[];
    production?: {
      mode: string;
      humanDirection?: string;
      freshFromZero?: boolean;
    };
    url: string;
  };
  snapshot?: {
    runId: string;
    phase: string;
    turns: number;
    workers: number;
    taskStatuses: Record<string, number>;
  };
}

/** Recorded research milestones, not a reconstructed mathematical explanation. */
export interface ArchiveSourceUse {
  deliveryId: string;
  deliveryStatus: string;
  kind: string;
  reference: string;
  locator: string;
  assumptions: string[];
  adaptation: string;
  consumer: { taskId: string; taskDigest: string };
  lemmaRequestIds: string[];
  remaining: string[];
}

export interface ArchiveKnowledgeApplication {
  deliveryId?: string;
  id: string;
  consumer: { taskId: string; taskDigest: string };
  declaration: { name: string; file: string };
  check: { status: string; reason?: string; authority?: string; proofAcceptance?: string;
    consumerCoverage?: string; commit?: string; selectedDeclarationUsed?: boolean } | null;
}

export interface ArchiveLibraryUsage {
  evidence: 'saved-imports-and-lexical-mentions';
  observedAt?: string;
  installed?: { name: string; file?: string }[];
  drafts?: { workerId: string; sourceDigest: string; checked: false;
    modules: { name: string; file: string; direct: boolean; mentioned: string[] }[] }[];
  canonical?: { commit: string; checked: false;
    modules: { name: string; file: string; direct: boolean; mentioned: string[] }[] } | null;
  checked?: { commit: string; checked: true;
    modules: { name: string; file: string; direct: boolean; mentioned: string[] }[] } | null;
}

/** A build-time index of archived source bytes. References are lexical, not proof dependencies. */
export interface ArchiveSourceRoute {
  files: {
    name: string;
    path: string;
    sha256: string;
    recordSource: boolean;
    /** Checked versions already live in ArchiveProcess.sources and are not copied here. */
    code?: string;
    declarations: {
      id: string;
      name: string;
      kind: 'theorem' | 'definition' | 'instance';
      type: string;
      line: number;
      endLine: number;
      references: string[];
      /** Contiguous original proof blocks; their order describes source reading only. */
      steps: { id: string; line: number; endLine: number; code: string }[];
    }[];
  }[];
}

export interface ArchiveProcess {
  walkthrough?: ProofWalkthrough;
  sourceRoute?: ArchiveSourceRoute;
  /** Exact checked files recovered from immutable archived commits, keyed by their SHA-256. */
  sources?: Record<string, { path: string; code: string; sha256: string }>;
  runs: {
    runId: string;
    startedAt?: string;
    finishedAt?: string;
    phase: string;
    resultStatus?: string;
    reason?: string;
    turns: number;
    workers: number;
    tasks: { id: string; theorem?: string; objective: string; status: string; attempts: number;
      dependencies: string[]; proofCommit?: string; checkStatus?: string; receiptIds: string[] }[];
    review?: { status: string; summary?: string };
    events: { at: string; kind: string; taskId?: string; status?: string; message?: string }[];
    checks?: { id: string; at: string; scope: 'task' | 'original'; taskId?: string; commit?: string;
      status: string; receiptIds: string[]; diagnostics?: string; sourceDigest?: string }[];
    deliveries?: { id: string; at: string; kind: string; status: string; taskId?: string; workerId?: string;
      role?: string; commit?: string; summary: string }[];
    sourceUses?: ArchiveSourceUse[];
    lemmaRequests?: { deliveryId: string; deliveryStatus: string; id: string; objective: string;
      theorem?: string; type?: string; proofPath?: string; dependencies: string[] }[];
    knowledgeApplications?: ArchiveKnowledgeApplication[];
    libraryUsage?: ArchiveLibraryUsage;
  }[];
}

export interface ArchiveCatalog {
  schema: 'theoremos.public-archive.v1';
  repository: string;
  archiveRevision: string;
  snapshotAt: string;
  records: ArchiveRecord[];
}

/** The archive page bundles this index; full Lean sources load per record from data/sources/<id>.js. */
export type ArchiveIndexSource = Omit<ArchiveSource, 'code'>;
export interface ArchiveIndexRecord extends Omit<ArchiveRecord, 'sources' | 'process'> {
  sources: ArchiveIndexSource[];
  /** Reading format of the exact accepted proof; full explanations stay lazy. */
  readingMode?: 'derivation' | 'source';
  /** The first lines of the target statement, shown in the overview without loading the full source. */
  excerpt: string;
}
export interface ArchiveIndex extends Omit<ArchiveCatalog, 'records'> {
  records: ArchiveIndexRecord[];
}
