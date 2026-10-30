import type { ResearchModulePlan, ResearchModuleSlot } from '../../src/solver/modules/policy';
import type { WebObservation, WebArchive } from './collaboration';

export type WebEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type WebCoordination = 'cooperative' | 'independent';
export type WebRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
export type WebEnvironment = 'standard' | 'mathlib';
/** What one web run may ask for; the server enforces these, and the workbench reads them to know when a limit is already at its highest. */
/** `maxRuns` is how many run records one owner may keep; the composer warns before the server refuses the next one. */
export const webLimits = Object.freeze({ maxTurns: 20, maxRunSeconds: 900, maxWorkers: 4, maxTotalTokens: 100_000_000,
  maxSourceBytes: 32_768, maxTaskBytes: 8_000, maxRuns: 20 });
/** How long a run may spend preparing its proof environment; this is separate from the solve budget, which starts after it. */
export const webPreparationSeconds: Readonly<Record<WebEnvironment, number>> = { standard: 120, mathlib: 600 };
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
export type WebSavedKey = { providerId: string; ending: string };
/** What the browser posts: `saveKey` asks the server to keep the typed key for this account; it never reaches the run. */
export type WebRunRequest = WebRunInput & { saveKey?: boolean };
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
  /** Hold every Agent after the first plan until the person who started the run approves it. */
  planApproval?: boolean;
  modulePlan?: ResearchModulePlan;
  knowledgeDigest?: string;
  continueFrom?: WebContinuation;
};
/**
 * A version recorded in one of the account's runs that a new run starts from: its code reaches every Agent as an
 * advisory attachment, never as the problem or as evidence. `label` names it for people (「zero_add · 第 2 次」).
 */
export type WebContinuation = { runId: string; taskId: string; commit: string; label: string };
export const webContinuationLabelMax = 200;
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
  /** A runtime reason code such as math_delivery_invalid or no-durable-progress, never provider or Lean text. */
  reason?: string;
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
  /** When a Lean check last passed or a checked result was integrated; kept after the activity log rotates. */
  progressAt?: string;
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
  planApproval?: boolean;
  modulePlan?: ResearchModulePlan;
  knowledgeDigest?: string;
  continueFrom?: WebContinuation;
  observation?: WebObservation;
  archives?: WebArchive[];
  knowledgeCatalogDigest?: string;
  moduleConfiguration?: WebFrozenModuleConfiguration;
  events: WebEvent[];
  /** How many Agent actions are stored (read them from /actions) and how many arrived past the per-run limit. */
  actions?: { count: number; dropped?: number };
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
  /** `keyVault` means this account may save its own keys; `savedKeys` names them by provider and last four characters. */
  account?: { email: string; admin?: boolean; completionEmail?: boolean; serverKeys?: string[]; keyVault?: boolean; savedKeys?: WebSavedKey[] };
  providers: WebProvider[];
  environments: WebEnvironmentOption[];
  templates: WebTemplate[];
  defaults: Pick<WebRunInput, 'model' | 'effort' | 'maxTurns' | 'maxRunSeconds' | 'workers' | 'coordination'> & { environment: WebEnvironment };
  limits: { maxTurns: number; maxRunSeconds: number; maxWorkers: number; maxTotalTokens: number; maxSourceBytes: number; maxTaskBytes: number; maxRuns: number };
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
export type WorkerInput = { id: string; input: WebRunInput; provider: WebProvider; knowledgeCatalog?: unknown;
  /** The saved file of `input.continueFrom`, read by the server from the account's own run. */
  continuation?: WebContinuation & { file: string; source: string } };
/**
 * One thing an Agent did inside its session, as Codex reported it: a command with the end of its output, a file
 * change with its diff, its reasoning, a message or plan, a search or a tool call. The worker writes these after
 * removing credentials and the host's own paths; `withheld` means a command touched host files, so only the command
 * itself is kept. Lean checks and Mathlib searches keep what they reported (`lean`, `found`) in place of their JSON.
 * `sequence` and `at` are the server's, so actions order with the run's events.
 */
export const webAgentActionKinds = ['command', 'edit', 'reasoning', 'message', 'plan', 'search', 'tool', 'compaction'] as const;
export type WebAgentActionKind = typeof webAgentActionKinds[number];
export type WebAgentActionIntent = { type: 'read' | 'list' | 'search'; path?: string; query?: string };
export type WebAgentFileChange = { path: string; change: 'add' | 'delete' | 'update'; movedTo?: string; diff?: string; clipped?: boolean };
/** What `math check-lean` reported, read from its JSON instead of shown as it. */
export type WebAgentLeanCheck = {
  passed: boolean; timedOut?: boolean;
  messages: { severity: 'error' | 'warning' | 'info'; file?: string; line?: number; column?: number; text: string }[];
  omittedMessages?: number;
};
/** What `math search-lean` found, per query: how many matches and the first declaration names. */
export type WebAgentLeanSearch = { query: string; total: number; names: string[] }[];
export type WebAgentActionBody = {
  workerId: string; itemId: string; phase: 'started' | 'completed'; kind: WebAgentActionKind;
  status: 'running' | 'done' | 'failed' | 'declined';
  command?: string; intents?: WebAgentActionIntent[]; output?: string; outputClipped?: boolean; withheld?: boolean;
  exitCode?: number; durationMs?: number; lean?: WebAgentLeanCheck; found?: WebAgentLeanSearch;
  changes?: WebAgentFileChange[]; omittedChanges?: number;
  text?: string; textClipped?: boolean;
  query?: string; url?: string; tool?: string; arguments?: string;
};
export type WebAgentAction = WebAgentActionBody & { sequence: number; at: string };
/** Per action field and per run; a run past `perRun` keeps counting what it dropped. */
export const webAgentActionLimits = Object.freeze({ perRun: 3_000, page: 500, command: 2_000, output: 8_000, outputHead: 2_000,
  diff: 6_000, diffs: 24_000, changes: 20, text: 4_000, intents: 8, query: 400, arguments: 1_000, encoded: 64 * 1024,
  leanMessages: 12, leanMessage: 600, queries: 8, names: 8, name: 200 });
export type WorkerMessage =
  | { type: 'progress'; event: string; message: string; details?: WebEventDetails }
  | { type: 'action'; action: WebAgentActionBody }
  | { type: 'artifact'; artifact: WebArtifact }
  | { type: 'observation'; observation: WebObservation }
  | { type: 'catalog'; catalog: unknown }
  | { type: 'result'; result: WebResult }
  | { type: 'error'; message: string; failure?: WebFailure };
/** The id of the read-only sample run (apps/web/sample.ts); fixed so links and saved positions never collide with real runs. */
export const webSampleRunId = '00000000-0000-4000-8000-00000000a001';
/** A Lean check that passed afresh, or a checked result joining the main line: what a reader counts as progress. */
export function isProgressEvent(type: string, details?: WebEventDetails): boolean {
  if (type === 'task_integrated') return true;
  if (type === 'task_checked' || type === 'task_recheck_finished') return details?.passed === true;
  return type === 'proof_checked' && details?.passed === true && details.reused !== true;
}

/** The admin dialog: who may sign in, which accounts exist with their beta milestones, and the funnel totals. */
export type WebAdminOverview = {
  allowlist: { email: string; source: 'admin' | 'config' | 'file'; account: boolean }[];
  accounts: { email: string; admin: boolean; createdAt: string; firstRunAt?: string; firstAcceptedAt?: string; allowed: boolean }[];
  funnel: { step: string; count: number; ofPrevious?: number }[];
  /** False when the service has no allowlist file, so only the deployment configuration can change who signs in. */
  editable: boolean;
};
