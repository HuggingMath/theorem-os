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
  /** `keyVault` means this account may save its own keys; `savedKeys` names them by provider and last four characters. */
  account?: { email: string; admin?: boolean; completionEmail?: boolean; serverKeys?: string[]; keyVault?: boolean; savedKeys?: WebSavedKey[] };
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
/**
 * A natural-language proof of one accepted target (docs/informalization.md), written and audited by models from the
 * Lean proof. Lines count from 1 in the run's proof file; a section covers one declaration, a step the lines it quotes.
 */
export type WebExplanationLanguage = 'zh' | 'en';
export type WebExplanationStatus = 'queued' | 'running' | 'approved' | 'exhausted' | 'cancelled' | 'error';
export const webExplanationPhases = ['queued', 'preparing', 'extracting', 'writing', 'auditing', 'revising', 'retrying', 'finishing'] as const;
export type WebExplanationPhase = typeof webExplanationPhases[number];
export type WebExplanationLines = { start: number; end: number };
/** Where in the proof file a cited name is written: a line and its UTF-16 columns, end exclusive. */
export type WebExplanationSpan = { line: number; start: number; end: number };
/**
 * A cited declaration and where it is written: in the step's own quoted Lean, elsewhere in the declaration, or nowhere,
 * as when notation (`^`, `ℂ`) or automation (simp) uses it. Every cited name is a dependency Lean checked.
 */
export type WebExplanationUse = { name: string; place: 'step' | 'declaration' | 'implicit'; spans: WebExplanationSpan[] };
/**
 * A phrase of the prose (UTF-16 offsets into its text, end exclusive) and where the Lean it translates is written; each
 * pair was checked verbatim on both sides by the host and judged by the auditors (phrase alignment).
 */
export type WebExplanationLink = { start: number; end: number; lean: WebExplanationSpan[] };
/** Auditor explanations of a statement or step; empty ones are left out. */
export type WebExplanationStep = { text: string; uses: WebExplanationUse[]; lines: WebExplanationLines[]; reviews: string[];
  /** Lean's goals around the tactics the step quotes, when the evidence recorded goal states. */ goals?: WebExplanationGoals;
  links?: WebExplanationLink[];
  /** With phrase alignment and goals: how many auditors checked the step against those goals (all found it consistent). */
  goalsChecked?: number };
/**
 * Goals before the first and after the last of the outermost tactics a step quotes, as Lean printed them (at most 4 per
 * state; the counts give all). An empty `after` means those tactics closed their goal. `lines` are the tactics' lines.
 */
export type WebExplanationGoals = { before: string[]; beforeCount: number; after: string[]; afterCount: number; lines: WebExplanationLines };
export type WebExplanationSection = {
  name: string; kind: 'theorem' | 'definition' | 'instance' | 'opaque' | 'axiom' | 'inductive' | 'structure' | 'class';
  /** Marks the main theorem; sections follow the proof file's order. */ target: boolean;
  title: string; statement: string; lines: WebExplanationLines;
  /** The lines the statement explains: a theorem's signature, or the whole of any other declaration. */ signature: WebExplanationLines;
  /** Proof-body lines with code that no step quotes. */ unexplained: number[];
  statementReviews: string[]; steps: WebExplanationStep[]; statementLinks?: WebExplanationLink[];
};
export const webFormalizationAspects = ['domains', 'assumptions', 'conclusions', 'definitions', 'quantifierScope', 'instanceCoherence'] as const;
/**
 * How a fragment of the original problem corresponds to the Lean statement, as the formalization reviewers recorded it
 * (merged when several quote the same pair). `lean` is where the Lean fragment is written; empty when it was quoted from
 * Lean's elaborated types rather than the source.
 */
export type WebFormalizationCorrespondence = { aspect: typeof webFormalizationAspects[number];
  relation: 'direct' | 'equivalent' | 'mismatch' | 'unresolved'; original: string;
  /** UTF-16 offsets of the first occurrence in the original problem; null when it does not occur verbatim. */
  originalStart: number | null; originalEnd: number | null; leanText: string; lean: WebExplanationSpan[];
  reviewers: number; explanations: string[] };
/** The original problem a proof was formalized from (formalization evidence bound to the explained proof). */
export type WebExplanationProblem = { problemId: string; original: string; correspondences: WebFormalizationCorrespondence[] };
/**
 * An approved formalization, for the offline comparison page: the frozen Lean statement beside the original problem, what
 * its reviewers matched, the blind back-translation and the plan. Lines count from 1 in Statement.lean.
 */
export type WebFormalizationReport = {
  schema: 'theorem-os.web-formalization-report.v1'; problemId: string; original: string; statement: string;
  environment: WebEnvironment; toolchain: string; mathlibRevision: string | null;
  targets: { name: string; lines: WebExplanationLines }[];
  correspondences: WebFormalizationCorrespondence[];
  backtranslation: { mathematics: string; assumptions: string[]; definitions: string[]; targets: { name: string; mathematics: string }[] };
  coverage: { original: string; originalStart: number | null; targets: string[]; explanation: string }[];
  plan?: { taskKind: string; conclusions: { mathematics: string; targets: string[]; quotes: string[] }[];
    assumptions: { mathematics: string; quotes: string[] }[]; definitions: { mathematics: string; names: string[]; quotes: string[] }[];
    unresolved: { description: string; quotes: string[] }[] };
  /** One per reviewer; `checks` are the six aspects for a structured review, the four booleans for an older one. */
  reviews: { reviewer: string; verdict: string; summary: string; checks: { name: string; value: string }[]; issues: string[];
    fidelity?: { target: string; original: string; sourceClaim: string; candidateClaim: string }[] }[];
  model: string; effort: string; rounds: number; evidenceSha256: string; approvedAt: string;
};
export type WebExplanationDocument = {
  schema: 'theorem-os.web-explanation.v1'; target: string; language: WebExplanationLanguage;
  toolchain: string; mathlibRevision: string | null; overview: string; axioms: string[];
  sections: WebExplanationSection[];
  /**
   * proofLines counts theorem body lines with code, explainedLines those some step quotes; ambiguousExcerpts counts
   * excerpts that occur more than once in their declaration (placed in step order).
   */
  metrics: { declarations: number; steps: number; citations: number; excerptCoverage: number; proofLines: number; explainedLines: number;
    ambiguousExcerpts: number };
  /** Writer and auditor configurations, without profiles or executables. */
  model: string; effort: string; auditors: number; rounds: number; tokens: number | null;
  /** Present when the explanation used phrase alignment. */ alignment?: string;
  /** Present when the proof was bound to an approved formalization. */ problem?: WebExplanationProblem;
};
/** The payload of an offline explanation report (informalize --phase report): the page with nothing to fetch. */
export type WebExplanationReport = { schema: 'theorem-os.web-explanation-report.v1'; title: string; environment: WebEnvironment;
  proof: string; document: WebExplanationDocument; markdown: string; filename: string };
export type WebExplanationProgress = { phase: WebExplanationPhase; batches?: number; approvedBatches?: number; round?: number;
  tokens?: number; updatedAt: string };
export type WebExplanation = {
  id: string; runId: string; target: string; language: WebExplanationLanguage; status: WebExplanationStatus;
  createdAt: string; updatedAt: string; finishedAt?: string; model: string; effort: 'low' | 'high' | 'max';
  maxRunSeconds: number; maxTotalTokens: number; progress?: WebExplanationProgress;
  /** An `explanation_*` or `informalization_*` code, never model or provider text. */ reason?: string;
  /** Present while queued: explanations generating or waiting before this one, from every account. */
  queue?: { position: number; ahead: number };
  /** Derived from the verified evidence each time one approved explanation is read; never stored or listed. */
  document?: WebExplanationDocument;
};
/** What the explanation page reads first: the proof, its targets and what can be generated. */
export type WebExplanationOverview = {
  run: { id: string; title: string; environment: WebEnvironment; providerId: string; model: string; effort: WebEffort; proof: string };
  targets: { name: string; declarations: number }[];
  explanations: WebExplanation[];
  generation: { available: true; model: string; effort: 'low' | 'high' | 'max'; key: 'saved' | 'server' | 'required';
    maxRunSeconds: number; maxTotalTokens: number; reference: { declarations: number; seconds: number; tokens: number } }
    | { available: false; reason: 'sample' | 'not_accepted' | 'provider' | 'model' | 'runtime' };
};
export type WorkerExplanationInput = { id: string; proof: string; target: string; language: WebExplanationLanguage;
  environment: WebEnvironment; model: string; effort: 'low' | 'high' | 'max'; apiKey: string; provider: WebProvider;
  maxRunSeconds: number; maxTotalTokens: number; maxRoundsPerBatch: number; auditors: number };
export type WorkerExplanationMessage =
  | { type: 'progress'; progress: Omit<WebExplanationProgress, 'updatedAt'> }
  | { type: 'result'; status: 'approved'; evidence: unknown }
  | { type: 'result'; status: 'exhausted' | 'error'; reason: string };
export const webExplanationReason = /^(?:explanation|informalization)_[a-z0-9_]{1,80}$/u;
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
