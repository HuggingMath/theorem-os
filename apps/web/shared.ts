import type { ResearchModulePlan, ResearchModuleSlot } from '../../src/solver/modules/policy';
import type { WebObservation, WebArchive } from './collaboration';
import type { WebFormalizationBackgroundReview } from './formalizationTypes';
import type { ResearchLibraryProposalOrigin } from './researchLibraryProposalOrigin';
import { webTaskEnvironment } from './environment';

export type WebEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type WebCoordination = 'cooperative' | 'independent';
export type WebRunStatus = 'queued' | 'running' | 'completed' | 'cancelled' | 'error';
export type WebEnvironment = 'standard' | 'mathlib';
/** What one web run may ask for; the server enforces these, and the workbench reads them to know when a limit is already at its highest. */
/** `maxRuns` is how many run records one owner may keep; the composer warns before the server refuses the next one. */
export const webLimits = Object.freeze({ maxTurns: 20, maxRunSeconds: 900, maxWorkers: 4, maxTotalTokens: 100_000_000,
  maxSourceBytes: 128 * 1024, maxTaskBytes: 8_000, maxRuns: 20 });
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
/** Omitted budgets normalize to 0 (unlimited); `saveKey` stays with this account and never reaches the run. */
export type WebRunRequest = Omit<WebRunInput, 'maxTurns' | 'maxRunSeconds'> & {
  maxTurns?: number; maxRunSeconds?: number; saveKey?: boolean; requestId?: string };
/** A private attempt prepared against a project's budget. This reference grants no project access or sharing. */
export type WebProjectBudgetOrigin = { runId: string; projectId: string };
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
  /** Provider-reported token cap for the whole run; absent or 0 means unlimited, as for the time and turn caps. */
  maxTotalTokens?: number;
  workers: number;
  coordination: WebCoordination;
  /** Hold every Agent after the first plan until the person who started the run approves it. */
  planApproval?: boolean;
  modulePlan?: ResearchModulePlan;
  /** Omitted: choose the owner's latest reusable catalog; null: explicitly use no history. */
  knowledgeDigest?: string | null;
  continueFrom?: WebContinuation;
  /** Owned verified evidence, accepted manually or through an explicitly requested automatic solve workflow. */
  formalizationId?: string;
  /** References only. The server resolves and freezes all contents before starting work. */
  researchSelection?: import('./researchAssetTypes').ResearchConfigurationSelection;
  budgetOrigin?: WebProjectBudgetOrigin;
  libraryProposalOrigin?: ResearchLibraryProposalOrigin;
};
/**
 * A version recorded in one of the account's runs that a new run starts from: its code reaches every Agent as an
 * advisory attachment, never as the problem or as evidence. `label` names it for people (「zero_add · 第 2 次」).
 */
export type WebContinuation = {
  runId: string; taskId: string; commit: string; label: string;
  /** Frozen by the web host from the source actually selected for this continuation. Legacy runs may lack them. */
  taskVersion?: string; sourceDigest?: string; environmentDigest?: string; file?: string;
};
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
  formalizationId?: string;
  formalization?: { id: string; evidenceSha256?: string; original: string; confirmedAt?: string; candidateDigest?: string;
    confirmation?: 'automatic' | 'manual' | 'pending' | 'rejected' | 'interrupted' | 'superseded'; reviewMode?: 'direct' };
  /** Host-declared solver attempt; observation sequences continue across library restarts. */
  solverAttempt?: { solverRunId: string; round: number; sequence: number };
  observation?: WebObservation;
  archives?: WebArchive[];
  knowledgeCatalogDigest?: string;
  moduleConfiguration?: WebFrozenModuleConfiguration;
  researchConfiguration?: import('./researchAssetTypes').FrozenResearchConfiguration;
  budgetOrigin?: WebProjectBudgetOrigin;
  libraryProposalOrigin?: ResearchLibraryProposalOrigin;
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
  /** Stable opaque owner identity for account-bound browser recovery. */
  draftOwner?: string;
  csrfToken: string;
  /** `email` means the workbench needs a login; `account` is set once this session has one. */
  auth: 'none' | 'email';
  /** `open` means anyone with a working inbox may register; absent means only allowlisted addresses sign in. */
  signup?: 'open';
  /** Terms shown by the login page, and whether an existing account must accept that version before continuing. */
  termsVersion?: string;
  termsRequired?: boolean;
  maintenance?: boolean;
  /** What this account has used in the current window of its per-account allowance; absent without an account. */
  quota?: WebQuotaView;
  /** `admin` accounts may manage the allowlist; they see no other account's runs. */
  /** `completionEmail: false` means the account turned off the mail sent when one of its runs ends; absent means on. */
  /** `serverKeys` lists the providers whose key the server fills in for this admin account when the field is left empty. */
  /** `keyVault` means this account may save its own keys; `savedKeys` names them by provider and last four characters. */
  account?: { email: string; admin?: boolean; completionEmail?: boolean; passwordSet?: boolean; passwordResetAllowed?: boolean;
    serverKeys?: string[]; keyVault?: boolean; savedKeys?: WebSavedKey[] };
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
  /** With `?runs`, the run list and its ETag (as GET /api/runs), so a first load needs one round trip; absent without an owner. */
  runs?: { runs: WebRun[]; version: string };
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
  researchConfiguration?: import('./researchAssetTypes').FrozenResearchConfiguration;
  /** Validated server-side artifact; never supplied directly by the browser. */
  formalization?: unknown;
  /** Host-compiled statement; its semantic review may still be running. Never supplied by the browser. */
  compiledFormalization?: unknown;
  /** The saved file of `input.continueFrom`, read by the server from the account's own run. */
  continuation?: WebContinuation & { file: string; source: string } };
/**
 * One thing an Agent did inside its session, as Codex reported it: a command with the end of its output, a file
 * change with its diff, its reasoning, a message or plan, a search or a tool call. The worker writes these after
 * removing credentials and the host's own paths; `withheld` means a command touched host files, so only the command
 * itself is kept. Lean checks, Mathlib searches and library tools keep bounded reports (`lean`, `found`, `library`)
 * in place of their JSON; a tool report never means the proof applied a declaration or passed acceptance.
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
/** A library tool's own report. Installation and queued requests say nothing about proof applicability or acceptance. */
export type WebAgentLibraryDeclaration = { name: string; installation: 'installed-frozen' | 'not-installed' };
export type WebAgentLibraryAction = { library: { id: string; revision: string; catalogDigest: string } } & (
  | { operation: 'search'; query: string; goal?: string; hits: WebAgentLibraryDeclaration[]; namedReferences: WebAgentLibraryDeclaration[];
      omittedHits?: number; omittedReferences?: number }
  | { operation: 'get'; declaration: WebAgentLibraryDeclaration; source: { offset: number; nextOffset: number | null; complete: boolean } }
  | { operation: 'request'; status: 'queued' | 'already-installed'; declarations: WebAgentLibraryDeclaration[]; omittedDeclarations?: number }
);
export type WebAgentActionBody = {
  workerId: string; itemId: string; phase: 'started' | 'completed'; kind: WebAgentActionKind;
  status: 'running' | 'done' | 'failed' | 'declined';
  command?: string; intents?: WebAgentActionIntent[]; output?: string; outputClipped?: boolean; withheld?: boolean;
  exitCode?: number; durationMs?: number; lean?: WebAgentLeanCheck; found?: WebAgentLeanSearch; library?: WebAgentLibraryAction;
  changes?: WebAgentFileChange[]; omittedChanges?: number;
  text?: string; textClipped?: boolean;
  /** Explicit public provenance; absent on older records and final assistant output. */
  textSource?: 'summary' | 'commentary';
  query?: string; url?: string; tool?: string; arguments?: string;
};
export type WebAgentAction = WebAgentActionBody & { sequence: number; at: string };
/** Per action field and per run; encoded allows JSON's six-character escapes, including long Lean diagnostics and paths. */
export const webAgentActionLimits = Object.freeze({ perRun: 3_000, page: 500, command: 8_192, output: 32_768, outputHead: 8_192,
  diff: 32_768, diffs: 65_536, changes: 20, text: 32_768, intents: 8, query: 400, arguments: 8_192, encoded: 1536 * 1024,
  leanMessages: 64, leanMessage: 2_000, queries: 8, names: 8, name: 200 });
export type WorkerMessage =
  | { type: 'progress'; event: string; message: string; details?: WebEventDetails }
  | { type: 'action'; action: WebAgentActionBody }
  | { type: 'artifact'; artifact: WebArtifact }
  | { type: 'library_restart'; previousSolverRunId: string; solverRunId: string; round: number }
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
/** Relations from strongest to weakest; merged or grouped correspondences show the weakest. */
export const webFormalizationRelationRank = { direct: 0, equivalent: 1, unresolved: 2, mismatch: 3 } as const;
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
  /** Absent on legacy independently reviewed reports. Direct compilation does not assess natural-language meaning. */
  semanticReview?: 'not-performed';
  backgroundReview?: WebFormalizationBackgroundReview;
  backtranslation: { mathematics: string; assumptions: string[]; definitions: string[]; targets: { name: string; mathematics: string }[] } | null;
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
/** The proof id `informalize` uses when none is given: the target with every other character run as `_`. */
export const defaultProofId = (target: string) => target.replace(/[^A-Za-z0-9_-]+/gu, '_').slice(0, 128);
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
/** A Lean check that passed afresh, or a checked result joining the main line: what a reader counts as progress. */
export function isProgressEvent(type: string, details?: WebEventDetails): boolean {
  if (type === 'task_integrated') return true;
  if (type === 'task_checked' || type === 'task_recheck_finished') return details?.passed === true;
  return type === 'proof_checked' && details?.passed === true && details.reused !== true;
}

/** One kind of the per-account allowance: how much of it the current window used, and the limit it is used against. */
export type WebQuotaUsage = { used: number; limit: number };
/** The per-account allowance as the account's session shows it, one entry per kind plus the window's end. */
export type WebQuotaView = { windowHours: number; windowEndsAt: string; runs: WebQuotaUsage; formalizations: WebQuotaUsage; explanations: WebQuotaUsage };
/** The admin dialog: who may sign in, which accounts exist with their beta milestones, and the funnel totals. */
/** The per-account allowance as the admin list shows it: the window, and what each account used in it. */
export type WebAdminQuota = { windowHours: number; limits: { research: number; formalizations: number; explanations: number } };
export type WebAdminUsage = { research: number; formalizations: number; explanations: number };
export type WebAdminOverview = {
  allowlist: { email: string; source: 'admin' | 'config' | 'file'; account: boolean }[];
  accounts: { email: string; admin: boolean; createdAt: string; firstRunAt?: string; firstAcceptedAt?: string; allowed: boolean; suspended?: boolean;
    /** Absent without a quota configuration (an anonymous loopback preview). */
    usage?: WebAdminUsage }[];
  funnel: { step: string; count: number; ofPrevious?: number }[];
  /** False when the service has no allowlist file, so only the deployment configuration can change who signs in. */
  editable: boolean;
  signup?: 'open' | 'allowlist';
  /** The allowance every account shares; absent when the service has none. */
  quota?: WebAdminQuota;
};

/** The run or conversation a workbench address names (`?run=<id>` or `?chat=<id>`), kept through the login page so signing
 * in returns to it. Anything else, or a malformed id, returns to the plain workbench. */
export function workbenchReturn(search: string): string {
  const params = new URLSearchParams(search), kept = new URLSearchParams(), run = params.get('run'), chat = params.get('chat');
  const destination = params.get('returnTo');
  if (destination === 'invite') {
    kept.set('returnTo', 'invite');
    const invite = params.get('invite'); if (invite && /^[A-Za-z0-9_-]{43}$/u.test(invite)) kept.set('invite', invite);
    const language = params.get('lang'); if (language === 'zh' || language === 'en') kept.set('lang', language);
    return `?${kept}`;
  }
  if (destination === 'problem' || destination === 'library' || destination === 'workspace' || destination === 'theorems') {
    kept.set('returnTo', destination);
    const retain = (key: string, pattern: RegExp) => { const value = params.get(key); if (value && pattern.test(value)) kept.set(key, value); };
    const identity = /^[A-Za-z0-9_.:-]{1,200}$/u, recordId = /^[A-Za-z0-9_-]{1,128}$/u;
    retain('run', /^[a-f0-9-]{1,36}$/u); retain('project', recordId);
    retain('task', identity); retain('taskVersion', identity); retain('commit', /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
    retain('accountDraft', recordId); retain('draftVersion', recordId);
    retain('annotation', recordId); retain('feedback', recordId);
    if (destination === 'problem') {
      retain('tab', /^(?:overview|route|compare|discussion|outcomes|stages|brief)$/u);
      retain('map', /^(?:global|attempt)$/u);
      retain('compare', /^[a-f0-9-]{1,36}$/u);
      retain('decision', identity);
      retain('snapshot', /^[a-f0-9]{64}$/u); retain('changeRecord', identity);
      retain('at', /^[1-9]\d{0,12}$/u); retain('atState', /^[a-f0-9]{64}$/u);
    } else if (destination === 'library') {
      retain('entry', recordId); retain('version', identity); retain('trial', recordId);
      retain('action', /^bookmark$/u);
      retain('type', /^(?:mathematics|agent|skill)$/u); retain('author', recordId);
      retain('environment', /^(?:all|target|standard|mathlib)$/u); retain('mine', /^1$/u);
      for (const [key, limit] of [['q', 128], ['area', 200]] as const) {
        const value = params.get(key); if (value && value.length <= limit) kept.set(key, value);
      }
    } else if (destination === 'theorems') {
      retain('id', recordId); retain('version', recordId); retain('revise', recordId);
      retain('reviewComment', recordId);
    } else {
      retain('tab', /^(?:inbox|search|usage|brief|collections|drafts|trials|help)$/u);
      retain('trial', recordId); retain('asset', recordId); retain('status', /^(?:prepared|checking|passed|failed)$/u);
      retain('inbox', /^(?:all|pending|unread|decision|reply|progress)$/u);
      retain('history', /^[a-f0-9]{64}$/u);
      retain('kind', /^(?:problem|conversation|lemma|route|library|history|decision|stage)$/u);
      const searchQuery = params.get('q'); if (searchQuery && searchQuery.length <= 128) kept.set('q', searchQuery);
      const searchOffset = params.get('offset');
      if (searchOffset && /^\d{1,6}$/u.test(searchOffset) && Number(searchOffset) <= 100_000) kept.set('offset', String(Number(searchOffset)));
    }
    const language = params.get('lang'); if (language === 'zh' || language === 'en') kept.set('lang', language);
    return `?${kept}`;
  }
  if (run && /^[a-f0-9-]{1,36}$/u.test(run)) {
    kept.set('run', run);
    const view = params.get('view'); if (view === 'route' || view === 'source') kept.set('view', view);
    const task = params.get('task'), version = params.get('taskVersion'), commit = params.get('commit');
    if (task && /^[A-Za-z0-9_.:-]{1,200}$/u.test(task)) kept.set('task', task);
    if (version && /^[A-Za-z0-9_.:-]{1,200}$/u.test(version)) kept.set('taskVersion', version);
    if (commit && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) kept.set('commit', commit);
    const recovery = params.get('recovery');
    if (recovery && /^(?:continue-checked|ask-failed|key|retry|budget|tokens|turns|workers|source|task)$/u.test(recovery)) kept.set('recovery', recovery);
  } else if (chat && /^[a-f0-9-]{36}$/u.test(chat)) {
    kept.set('chat', chat);
    const message = params.get('message'); if (message && /^[a-f0-9-]{36}$/u.test(message)) kept.set('message', message);
  } else if (params.has('researchAsset') && params.has('researchVersion')) {
    const asset = params.get('researchAsset')!, version = params.get('researchVersion')!;
    if (/^[A-Za-z0-9_-]{1,128}$/u.test(asset) && /^[A-Za-z0-9._-]{1,64}$/u.test(version)) {
      kept.set('researchAsset', asset); kept.set('researchVersion', version);
      const pending = params.get('libraryReturn'); if (pending && /^[a-f0-9-]{36}$/u.test(pending)) kept.set('libraryReturn', pending);
    }
  } else if (params.has('accountDraft')) {
    const draft = params.get('accountDraft')!, version = params.get('draftVersion');
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(draft)) {
      kept.set('accountDraft', draft);
      if (version && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(version)) kept.set('draftVersion', version);
    }
  } else if (params.has('sharedDraft')) {
    const id = params.get('sharedDraft')!; if (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id)) kept.set('sharedDraft', id);
  } else if (params.has('budgetRun')) {
    const budgetRun = params.get('budgetRun')!, tokens = params.get('budgetTokens') ?? '', project = params.get('project');
    if (/^[a-f0-9-]{1,36}$/u.test(budgetRun) && /^\d{1,13}$/u.test(tokens) && Number(tokens) > 0 && Number(tokens) <= 1e12) {
      kept.set('budgetRun', budgetRun); kept.set('budgetTokens', tokens);
      if (project && /^[A-Za-z0-9_-]{1,128}$/u.test(project)) kept.set('project', project);
    }
  } else if (params.has('libraryTrial') && params.has('trialDigest')) {
    const trial = params.get('libraryTrial')!, digest = params.get('trialDigest')!;
    if (/^[A-Za-z0-9_-]{1,128}$/u.test(trial) && /^[a-f0-9]{64}$/u.test(digest)) {
      kept.set('libraryTrial', trial); kept.set('trialDigest', digest);
    }
  } else if (params.has('libraryProposal') && params.has('project')) {
    const proposal = params.get('libraryProposal')!, project = params.get('project')!;
    if (/^[A-Za-z0-9_-]{1,128}$/u.test(proposal) && /^[A-Za-z0-9_-]{1,128}$/u.test(project)) {
      kept.set('libraryProposal', proposal); kept.set('project', project);
    }
  } else if (params.get('entry') === 'statement' || params.get('entry') === 'lean') {
    const entry = params.get('entry')!, template = entry === 'statement' ? 'add-zero' : 'polynomial', environment = webTaskEnvironment;
    if ((!params.has('template') || params.get('template') === template) && (!params.has('environment') || params.get('environment') === environment
      || entry === 'statement' && params.get('environment') === 'standard')) {
      kept.set('entry', entry); kept.set('template', template); kept.set('environment', environment);
    }
  } else {
    const formalization = params.get('formalization'); if (formalization && /^[a-f0-9-]{36}$/u.test(formalization)) kept.set('formalization', formalization);
  }
  const classic = params.get('fromClassic');
  if (classic && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(classic)) kept.set('fromClassic', classic);
  const shareReturn = params.get('shareReturn');
  if (shareReturn && /^[a-f0-9-]{36}$/u.test(shareReturn)) kept.set('shareReturn', shareReturn);
  const lang = params.get('lang'); if (lang === 'zh' || lang === 'en') kept.set('lang', lang);
  return kept.size ? `?${kept}` : '';
}
/** The login return target is an internal allowlisted page, never a supplied URL. */
export function workbenchDestination(search: string): string {
  const safe = workbenchReturn(search), params = new URLSearchParams(safe);
  const target = params.get('returnTo');
  if (!target || !['workspace', 'problem', 'library', 'theorems', 'invite'].includes(target)) return `./${safe}`;
  params.delete('returnTo'); return `${target}.html${params.size ? `?${params}` : ''}`;
}

const appReturnPaths = new Set(['/', '/index.html', '/people.html', '/theorems.html', '/library.html', '/formalize.html', '/formalization.html', '/explain.html', '/workspace.html', '/problem.html', '/practice.html', '/invite.html']);
/** Only app page paths may receive a login return; query strings and fragments remain exactly as supplied. */
export function safeAppReturn(value: string | null | undefined): string | undefined {
  if (!value || /[\p{Cc}\\]/u.test(value)) return;
  const target = value.startsWith('./') ? value.slice(1) : value.startsWith('/') ? value : `/${value}`;
  const pathname = target.split(/[?#]/u, 1)[0]!;
  if (!appReturnPaths.has(pathname)) return;
  return target;
}
/** A link to login retains intent in the address, without carrying out any action after authentication. */
export function loginHref(returnTo: string): string {
  const target = safeAppReturn(returnTo);
  return target ? `/login.html?${new URLSearchParams({ returnTo: target })}` : '/login.html';
}
/** New app-page returns take precedence; existing run/chat mail links continue to open the same workbench record. */
export function loginReturn(search: string): string {
  return safeAppReturn(new URLSearchParams(search).get('returnTo')) ?? workbenchDestination(search);
}
function researchContext(search: string, origin: 'research' | 'workbench' = 'research'): URLSearchParams {
  const params = new URLSearchParams(search), context = new URLSearchParams();
  const chat = params.get('workbenchChat') ?? (origin === 'workbench' ? params.get('chat') : null);
  const run = params.get('workbenchRun') ?? (origin === 'workbench' ? params.get('run') : null);
  const edit = params.get('workbenchEdit') ?? (origin === 'workbench' ? params.get('editProblem') : null);
  if (chat && /^[a-f0-9-]{36}$/u.test(chat)) context.set('workbenchChat', chat);
  if (run && /^[a-f0-9-]{1,36}$/u.test(run)) context.set('workbenchRun', run);
  if (edit && /^[A-Za-z0-9_-]{1,128}$/u.test(edit)) context.set('workbenchEdit', edit);
  return context;
}
/** Add only the explicit workbench source to an app link, keeping its own target, filters and fragment. */
export function researchContextHref(href: string, search: string): string {
  if (href.startsWith('#') || !safeAppReturn(href)) return href;
  const context = researchContext(search);
  if (!context.size) return href;
  const hashAt = href.indexOf('#'), fragment = hashAt < 0 ? '' : href.slice(hashAt), address = hashAt < 0 ? href : href.slice(0, hashAt);
  const queryAt = address.indexOf('?'), pathname = queryAt < 0 ? address : address.slice(0, queryAt);
  const parameters = new URLSearchParams(queryAt < 0 ? '' : address.slice(queryAt + 1));
  for (const [key, value] of context) parameters.set(key, value);
  return `${pathname}?${parameters}${fragment}`;
}
/** Research pages have target run ids of their own; only a workbench converts its chat/run into a return source. */
export function researchNavigation(search: string, origin: 'research' | 'workbench' = 'research'): { workbench: string; workspace: string; theorems: string; people: string; library: string } {
  const context = researchContext(search, origin);
  const suffix = context.size ? `?${context}` : '';
  const back = context.has('workbenchChat') ? `?${new URLSearchParams({ chat: context.get('workbenchChat')! })}`
    : context.has('workbenchEdit') ? `?${new URLSearchParams({ editProblem: context.get('workbenchEdit')! })}`
      : context.has('workbenchRun') ? `?${new URLSearchParams({ run: context.get('workbenchRun')! })}` : '';
  return { workbench: `./${back}`, workspace: `workspace.html${suffix}`, theorems: `theorems.html${suffix}`, people: `people.html${suffix}`, library: `library.html${suffix}` };
}
