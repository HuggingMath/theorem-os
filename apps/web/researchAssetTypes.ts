import type { ResearchModulePlan, ResearchModuleSlot } from '../../src/solver/modules/policy';

/** Browser-safe projection; all packages are still checked by parseLibraryPack before publication/use. */
export type ResearchLibraryPack = {
  schema: 'theorem-os.library-pack.v1';
  modules: { file: string; source: string; origin:
    | { kind: 'run'; runId: string; commit: string; file: string; receiptDigest?: string; environmentDigest?: string;
      dropped?: { name: string; reason: 'original' | 'unproved' | 'dependent' }[] }
    | { kind: 'upstream'; repository: string; commit: string; file: string } }[];
  requires?: { file: string; digest: string }[];
};
export type ResearchAssetKind = 'mathematics' | 'agent' | 'skill';
export type ResearchAssetVisibility = 'private' | 'public';
export type ResearchReleaseRef = { assetId: string; version: string; digest?: string };
export type ResearchLibraryProvenance = { kind: 'owner' | 'project' | 'public-result' | 'published'; href?: string };
export type ResearchMathSource =
  | { kind: 'knowledge'; catalogDigest: string; entryIds: string[] }
  | { kind: 'run'; runId: string; taskId?: string; taskVersion?: string; commit?: string;
    scope?: 'original-proof' | 'checked-task'; proofDigest?: string };
export type ResearchAssetPrefill = {
  name: string; description: string; source: ResearchMathSource; environment: 'standard' | 'mathlib';
  evidence: { scope: 'original-proof' | 'task'; commit: string; file: string; taskVersion?: string;
    sourceDigest: string; environmentDigest?: string; dependencyDigest?: string; proofDigest?: string; checkRefs: string[];
    declarations: ResearchMathDeclaration[] };
};
export type ResearchMathExample = {
  id: string; title: string; declaration: string; type: string; proof: string; argumentNotes: string;
};
export type ResearchMathUsage = { conditions: string; result: string; examples: ResearchMathExample[] };
export type ResearchMathExampleReceipt = {
  schema: 'theorem-os.research-library-example-check.v1'; exampleId: string; declaration: string;
  sourceDigest: string; libraryPackDigest: string; environment: 'standard' | 'mathlib'; environmentDigest: string;
  checkedDeclaration: string; passed: boolean; exitCode: number | null; timedOut: boolean;
  diagnostics: import('./shared').WebPrecheckDiagnostic[]; checkedAt: string;
};
export type ResearchCheckedMathExample = ResearchMathExample & { source: string; sourceDigest: string;
  check: { receiptId: string; receipt: ResearchMathExampleReceipt } };
export type ResearchMathDraft = { source: ResearchMathSource; usage?: ResearchMathUsage };
export type ResearchSkillDraft = {
  instructions: string;
  steps: string[];
  inputs: string[];
  outputs: string[];
  slots: ResearchModuleSlot[];
  roles: ('lead' | 'researcher' | 'engineer' | 'reviewer')[];
  mode: 'append' | 'replace';
  dependencies: ResearchReleaseRef[];
  examples: string[];
};
export type ResearchAgentDraft = {
  environment?: 'standard' | 'mathlib';
  providerId?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  workers?: number;
  coordination?: 'cooperative' | 'independent';
  modulePlan: ResearchModulePlan;
  skills: ResearchReleaseRef[];
  libraries: ResearchReleaseRef[];
};
export type ResearchAssetContent = ResearchMathDraft | ResearchAgentDraft | ResearchSkillDraft;
export type ResearchMathDeclaration = { name: string; type: string; file: string };
export type ResearchVerifiedMathematics = {
  environment: 'standard' | 'mathlib';
  environmentDigest: string;
  pack: ResearchLibraryPack;
  packDigest: string;
  declarations: ResearchMathDeclaration[];
  receiptRefs: string[];
  sourceReceiptRefs?: string[];
  source: ResearchMathSource;
  usage?: { conditions: string; result: string; examples: ResearchCheckedMathExample[] };
};
export type ResearchAssetRelease = {
  schema: 'theorem-os.research-asset-release.v1';
  assetId: string;
  type: ResearchAssetKind;
  authorId: string;
  version: string;
  digest: string;
  name: string;
  description: string;
  area: string;
  license: string;
  visibility: ResearchAssetVisibility;
  releaseNotes?: string;
  content: ResearchAssetContent;
  dependencies: ResearchReleaseRef[];
  mathematics?: ResearchVerifiedMathematics;
  derivedFrom?: ResearchReleaseRef;
  createdAt: string;
};
export type ResearchAssetReleaseInfo = Pick<ResearchAssetRelease, 'version' | 'digest' | 'createdAt' | 'license' | 'visibility'> & {
  withdrawn: boolean;
};
export type ResearchAsset = {
  id: string;
  type: ResearchAssetKind;
  authorId: string;
  name: string;
  description: string;
  area: string;
  visibility: ResearchAssetVisibility;
  revision: number;
  editable: boolean;
  draft?: ResearchAssetContent;
  release?: ResearchAssetRelease;
  releases: ResearchAssetReleaseInfo[];
  derivedFrom?: ResearchReleaseRef;
  createdAt: string;
  updatedAt: string;
};
export type ResearchAssetPreview = {
  type: ResearchAssetKind; name: string; description: string; revision: number; previewDigest: string;
  content?: ResearchAssetContent;
  mathematics?: Pick<ResearchVerifiedMathematics, 'pack' | 'environment' | 'environmentDigest' | 'declarations' | 'sourceReceiptRefs'>;
  mathematicsUsage?: ResearchMathUsage;
  validation: 'not-run';
};
export type ResearchPublication = {
  id: string;
  assetId: string;
  version: string;
  status: 'queued' | 'validating' | 'completed' | 'failed';
  reason?: string;
  release?: ResearchReleaseRef;
  createdAt: string;
  updatedAt: string;
};
export type ResearchConfigurationSelection = {
  agent?: ResearchReleaseRef;
  skills?: ResearchReleaseRef[];
  libraries?: ResearchReleaseRef[];
};
export type FrozenResearchConfiguration = {
  schema: 'theorem-os.research-configuration.v1';
  environment: 'standard' | 'mathlib';
  modulePlan: ResearchModulePlan;
  preferences: Pick<ResearchAgentDraft, 'providerId' | 'model' | 'effort' | 'workers' | 'coordination'>;
  agent?: { ref: ResearchReleaseRef; content: ResearchAgentDraft };
  skills: { ref: ResearchReleaseRef; content: ResearchSkillDraft }[];
  libraries: { ref: ResearchReleaseRef; mathematics: ResearchVerifiedMathematics }[];
  libraryPack?: ResearchLibraryPack;
  digest: string;
};

export type ResearchLibraryUse = ResearchReleaseRef & {
  runId: string; projectId?: string; theorem?: string;
  status: 'checked-reference'; evidence: 'recorded-not-replayed'; proofStatus: string;
  references: { name: string; file: string }[]; checkRefs: string[];
} & ({ scope: 'task'; taskId: string; taskVersion: string }
  | { scope: 'original-proof'; theorem: string; proofPath: string; commit: string; sourceDigest: string });
