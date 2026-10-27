import type { ResearchModulePlan, ResearchModuleSlot } from '../../src/solver/modules/policy';
import type { WebObservation, WebArchive } from './collaboration';

export type WebEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type WebCoordination = 'cooperative' | 'independent';
export type WebRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
export type WebEnvironment = 'standard' | 'mathlib';
/** Why a run stopped without an accepted proof. Categories carry no provider text. */
export const webFailureKinds = ['authentication', 'rate_limit', 'network', 'budget', 'time_limit', 'environment',
  'source', 'protocol', 'interrupted', 'unknown'] as const;
export type WebFailureKind = typeof webFailureKinds[number];
export type WebFailure = { kind: WebFailureKind; reason?: string };
export const webFailureReason = /^(?:math|lean_task)_[a-z0-9_]{1,80}$/u;
/** Accept a failure only in the shape the worker produces. */
export function parseWebFailure(value: unknown): WebFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { kind, reason, ...rest } = value as Record<string, unknown>;
  if (Object.keys(rest).length || typeof kind !== 'string' || !(webFailureKinds as readonly string[]).includes(kind)) return;
  if (reason !== undefined && (typeof reason !== 'string' || !webFailureReason.test(reason))) return;
  return { kind: kind as WebFailureKind, ...(typeof reason === 'string' ? { reason } : {}) };
}
export type WebQueuePosition = { position: number; ahead: number; running: number; slots: number };
export type WebFrozenModuleConfiguration = {
  registryVersion: 'theorem-os.web-module-registry.v1'; id: string; versions: Record<string, string>; methodDigest: string;
  coordination: WebCoordination; workers: number;
  selection: { scheduler: ResearchModulePlan['scheduler']; context: ResearchModulePlan['context'];
    implementations: { slot: string; id: string; version: string }[] };
};

export type WebProvider = { id: string; name: string; baseUrl: string };
export type WebEnvironmentOption = { id: WebEnvironment; name: string; description: string;
  toolchain: string; mathlibRevision?: string };
export type WebTemplate = { id: string; name: string; environment: WebEnvironment; source: string; task: string };
export type WebRunInput = {
  providerId: string;
  apiKey: string;
  model: string;
  effort: WebEffort;
  environment?: WebEnvironment;
  source: string;
  task: string;
  maxTurns: number;
  maxRunSeconds: number;
  /** Provider-reported token cap for the whole run; absent means unlimited. */
  maxTotalTokens?: number;
  workers: number;
  coordination: WebCoordination;
  modulePlan?: ResearchModulePlan;
  knowledgeDigest?: string;
};
export type WebModuleId = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'S3';
export type WebEventDetails = {
  workerId?: string;
  turn?: number;
  passed?: boolean;
  conditional?: boolean;
  reused?: boolean;
  operation?: 'direct' | 'decompose' | 'bridge' | 'prove-lemma' | 'integrate-lemma';
  usedBytes?: number;
  maxBytes?: number;
  status?: string;
  taskId?: string;
  role?: 'lead' | 'researcher' | 'prover' | 'engineer' | 'reviewer';
  moduleId?: string;
  slot?: ResearchModuleSlot;
  mode?: 'append' | 'replace';
};
export type WebEvent = { sequence: number; at: string; type: string; message: string; details?: WebEventDetails };
export type WebModuleSnapshot = { eventCount: number; firstAt: string; lastEvent: WebEvent; activeWorkers: string[] };
export const webArtifactMaxBytes = 128 * 1024;
export type WebArtifact = {
  source: string;
  workerId: string;
  capturedAt: string;
  status: 'candidate';
};
export type WebResult = {
  status: string;
  proof: string;
  report: Record<string, unknown>;
};
export type WebRun = {
  id: string;
  title: string;
  status: WebRunStatus;
  phase: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
  timings?: { preparing?: string; solving?: string; evaluating?: string };
  providerId: string;
  model: string;
  effort: WebEffort;
  environment: WebEnvironment;
  source: string;
  task: string;
  maxTurns: number;
  maxRunSeconds: number;
  /** Provider-reported token cap for the whole run; absent means unlimited. */
  maxTotalTokens?: number;
  workers: number;
  coordination: WebCoordination;
  modulePlan?: ResearchModulePlan;
  knowledgeDigest?: string;
  observation?: WebObservation;
  archives?: WebArchive[];
  knowledgeCatalogDigest?: string;
  moduleConfiguration?: WebFrozenModuleConfiguration;
  events: WebEvent[];
  modules?: Partial<Record<WebModuleId, WebModuleSnapshot>>;
  moduleApplications?: Record<string, WebModuleSnapshot>;
  artifact?: WebArtifact;
  result?: WebResult;
  error?: string;
  failure?: WebFailure;
  /** Present while queued; recomputed by the job queue, never restored. */
  queue?: WebQueuePosition;
};
export type WebSession = {
  csrfToken: string;
  /** `email` means the workbench needs a login; `account` is set once this session has one. */
  auth: 'none' | 'email';
  /** `admin` accounts may manage the allowlist; they see no other account's runs. */
  /** `completionEmail: false` means the account turned off the mail sent when one of its runs ends; absent means on. */
  /** `serverKeys` lists the providers whose key the server fills in for this admin account when the field is left empty. */
  account?: { email: string; admin?: boolean; completionEmail?: boolean; serverKeys?: string[] };
  providers: WebProvider[];
  environments: WebEnvironmentOption[];
  templates: WebTemplate[];
  defaults: Pick<WebRunInput, 'model' | 'effort' | 'maxTurns' | 'maxRunSeconds' | 'workers' | 'coordination'> & { environment: WebEnvironment };
  limits: { maxTurns: number; maxRunSeconds: number; maxWorkers: number; maxTotalTokens: number; maxSourceBytes: number; maxTaskBytes: number };
  runtime: { ready: boolean; message: string };
  /** A recorded read-only run that needs no API key; absent when the image ships without one. */
  sample?: { id: string; title: string };
  /** Set when the service can compile a statement before submission (POST /api/precheck). */
  precheck?: boolean;
};
/**
 * One finding from the statement check. `code` marks a structural check (shown in the interface language); otherwise
 * `message` is Lean's own text. Lines count from 1, columns are code points from 0, as Lean reports them.
 */
export type WebPrecheckDiagnostic = { severity: 'error' | 'warning'; line: number; column: number; endLine?: number; endColumn?: number;
  code?: string; name?: string; message?: string };
/**
 * `invalid`: a structural check failed, Lean was not started. `errors`: Lean rejected the statement. `ready`: it compiles
 * and leaves `sorries` to prove. `complete`: it compiles with nothing left to prove. The rest say nothing about the
 * statement and never block a submission.
 */
export type WebPrecheckStatus = 'invalid' | 'errors' | 'ready' | 'complete' | 'timeout' | 'busy' | 'unavailable';
export type WebPrecheck = { status: WebPrecheckStatus; environment: WebEnvironment; targets: number; sorries: number;
  diagnostics: WebPrecheckDiagnostic[]; cached?: boolean };
/** A finished proof's declarations: the original targets and what the solver added. `uses` are kernel-recorded,
 * project-local and transitive; without that record (`unrecorded`) nothing is inferred from the text. */
export type WebProofOutlineDeclaration = {
  name: string; kind: 'theorem' | 'definition' | 'instance'; role: 'target' | 'helper'; type: string; typeTruncated?: boolean;
  uses?: string[]; usedBy?: string[]; axioms?: string[]; nonstandardAxioms?: string[];
};
export type WebProofOutline = { references: 'recorded' | 'unrecorded'; declarations: WebProofOutlineDeclaration[]; omitted: number };
/** Catalog payloads are opaque on the Web transport; worker/service consumers validate the full knowledge schema. */
export type WorkerInput = { id: string; input: WebRunInput; provider: WebProvider; knowledgeCatalog?: unknown };
export type WorkerMessage =
  | { type: 'progress'; event: string; message: string; details?: WebEventDetails }
  | { type: 'artifact'; artifact: WebArtifact }
  | { type: 'observation'; observation: WebObservation }
  | { type: 'catalog'; catalog: unknown }
  | { type: 'result'; result: WebResult }
  | { type: 'error'; message: string; failure?: WebFailure };
/** The id of the read-only sample run (apps/web/sample.ts); fixed so links and saved positions never collide with real runs. */
export const webSampleRunId = '00000000-0000-4000-8000-00000000a001';

/** The admin dialog: who may sign in, which accounts exist with their beta milestones, and the funnel totals. */
export type WebAdminOverview = {
  allowlist: { email: string; source: 'admin' | 'config' | 'file'; account: boolean }[];
  accounts: { email: string; admin: boolean; createdAt: string; firstRunAt?: string; firstAcceptedAt?: string; allowed: boolean }[];
  funnel: { step: string; count: number; ofPrevious?: number }[];
  /** False when the service has no allowlist file, so only the deployment configuration can change who signs in. */
  editable: boolean;
};
