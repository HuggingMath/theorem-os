import path from 'node:path';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { inspectLeanDeclarations, inspectLeanDeclarationRegions } from '../math/leanSource';
import { maskLeanCommentsAndStrings } from '../math/leanSyntax';
import type { CooperationState } from './cooperation';
import { deliveryFinding, type DeliveryRecord } from './deliveries';
import { originalDeclarationRegions, type SolverProblem } from './problem';
import { assignmentDeliveryFile, hasTaskAcceptance, leadPlanDeliveryFile, taskGroup, taskVersion, type CooperativeAction, type TaskRecord } from './tasks';
import { buildProofContinuation } from './progress';
import { contextTaskConsumers } from './taskConsumers';
import { mathematicalGapContextText } from './mathematicalGaps';
import { nextCheckContextText } from './nextChecks';
import { goalProgressTaskContext } from './goalProgress';
import { leadPlanPublicationFeedback } from './cooperationShared';
import { contextCheckpointRejectionFeedback } from './contextCheckpoint';
import { researchDecisionMatches, type ResearchDecision } from './researchDecisions';

export const DEFAULT_TASK_CONTEXT_BYTES = 512 * 1024;
export const DEFAULT_OPTIONAL_TASK_CONTEXT_BYTES = 64 * 1024;
/** Above this size a source is shown compactly: definition bodies are omitted and the statement is cited, not repeated. */
export const COMPACT_CONTEXT_SOURCE_BYTES = 64 * 1024;
/** A compact source keeps definition bodies up to this size inline. */
const COMPACT_INLINE_BODY_BYTES = 32;
const COMPACT_BODY_MARKER = '\n/- body omitted -/\n';
export type ContextItemKind = 'problem' | 'assignment' | 'interfaces' | 'sources' | 'feedback' | 'delivery' |
  'finding' | 'history' | 'blocker' | 'routes' | 'continuation' | 'statement-review' | 'checkpoint' | 'groups';
export type ContextOmissionReason = 'budget' | 'superseded' | 'stale-version' | 'duplicate' | 'selection-limit' |
  'advisory-summary-limit' | 'advisory-details-by-reference' | 'optional-budget' |
  'encapsulated-private-dependency' | 'outside-task-scope';
export type ContextManifest = Readonly<{
  schema: 'theorem-os.task-context.v1';
  evidence: 'recorded-not-replayed';
  maxBytes: number; usedBytes: number; mandatoryBytes: number; maxOptionalBytes: number; optionalBytes: number; contentDigest: string;
  requiredTaskIds: readonly string[];
  included: readonly { id: string; kind: ContextItemKind; required: boolean; bytes: number }[];
  omitted: readonly { id: string; kind: ContextItemKind; reason: ContextOmissionReason }[];
}>;
export type ContextSection = Readonly<{ id: string; kind: ContextItemKind; text: string; priority?: number }>;
export type TaskContextInput = Readonly<{
  problem: SolverProblem; cooperation?: CooperationState; action?: CooperativeAction;
  instructions: string; taskText: string; feedback?: string; checkpoint?: string;
  /** Frozen source projection containing complete context and fixed definitions, with proof bodies omitted. */
  frozenContexts?: Readonly<Record<string, string>>;
  maxContextBytes?: number; environmentDigest?: string;
  /** Optional hints have their own allowance; exact mathematical contracts never use it. */
  maxOptionalContextBytes?: number;
  mandatory?: readonly ContextSection[];
  optional?: readonly ContextSection[];
}>;
export class TaskContextError extends Error {
  constructor(readonly code: 'math_context_missing_required' | 'math_context_stale_required' |
    'math_context_mandatory_overflow' | 'math_context_invalid_budget', readonly itemId: string) {
    super(`${code}:${itemId}`);
  }
}

const json = (value: unknown) => JSON.stringify(value);
const section = (id: string, kind: ContextItemKind, title: string, value: unknown): ContextSection =>
  ({ id, kind, text: `${title}\n${typeof value === 'string' ? value : json(value)}` });
const missing = (id: string): never => { throw new TaskContextError('math_context_missing_required', id); };
const stale = (id: string): never => { throw new TaskContextError('math_context_stale_required', id); };
const present = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const localName = (name: string) => name.split('.').at(-1);
const sourcePath = (problem: SolverProblem, file: string) => path.posix.join(problem.projectRelative.replaceAll('\\', '/'), file);

/**
 * Preserve source-level variables, scopes, instances and fixed definitions; never copy an existing proof body.
 * A source above COMPACT_CONTEXT_SOURCE_BYTES also omits definition and instance bodies, which stay in the frozen file.
 */
export function frozenSourceContext(problem: SolverProblem, file: string, source: string): string {
  const regions = inspectLeanDeclarationRegions(source), originals = problem.declarations[file] ?? [];
  const bytes = Buffer.byteLength(source), compact = bytes > COMPACT_CONTEXT_SOURCE_BYTES;
  const masked = compact ? maskLeanCommentsAndStrings(source) : '';
  const matching = originalDeclarationRegions(source, regions);
  if (originals.some(original => {
    const found = matching(original);
    return found.length !== 1 || found[0].declarationType !== original.header || (original.body &&
      mathDigest(source.slice(found[0].bodyOffset, found[0].endOffset).trim()) !== original.body);
  })) return stale(`frozen-source:${file}`);
  const kinds = new Map(inspectLeanDeclarations(source).map(item => [item.startOffset, item.kind]));
  for (const [index, region] of [...regions.entries()].reverse()) {
    const isTarget = problem.targets.some(target => target.proofPath === file &&
      localName(target.theoremName) === localName(region.name));
    if (kinds.get(region.startOffset) === 'theorem' || isTarget) {
      // A mutual block can extend a region over the next declaration; a compact cut stops before it.
      const end = compact ? Math.min(region.endOffset, regions[index + 1]?.startOffset ?? Infinity) : region.endOffset;
      source = source.slice(0, region.bodyOffset) + '\n/- Proof body omitted by the host context compiler. -/\n' + source.slice(end);
    } else if (compact) {
      // Structure-instance fields follow `where`; the first `:=` would sit inside them.
      const where = /(?<![\p{L}\p{M}\p{N}_'.?!])where(?![\p{L}\p{M}\p{N}_'.?!])/u.exec(masked.slice(region.startOffset, region.bodyOffset));
      const start = where ? region.startOffset + where.index + where[0].length : region.bodyOffset;
      const end = Math.min(region.endOffset, regions[index + 1]?.startOffset ?? Infinity);
      if (Buffer.byteLength(source.slice(start, end)) > COMPACT_INLINE_BODY_BYTES)
        source = source.slice(0, start) + COMPACT_BODY_MARKER + source.slice(end);
    }
  }
  return compact ? `/- Host context note: this ${bytes}-byte source is shown compactly. Definition and instance bodies ` +
    `over ${COMPACT_INLINE_BODY_BYTES} bytes appear as "body omitted"; read them with git show COMMIT:PATH from this file's frozen-sources entry. -/\n` + source : source;
}

/** A large statement that is a frozen file is cited by commit and path instead of being repeated. */
function originalProblemSection(input: TaskContextInput): ContextSection {
  const { problem } = input, statement = problem.contract.formalStatement, bytes = Buffer.byteLength(statement);
  const title = `${input.taskText}\n\nOriginal problem:`, digest = mathDigest(statement);
  const file = bytes > COMPACT_CONTEXT_SOURCE_BYTES && present(problem.baseCommit)
    ? Object.keys(problem.trustedFiles ?? {}).sort().find(file => problem.trustedFiles[file] === digest) : undefined;
  if (!file) return section('original-problem', 'problem', title, statement);
  return section('original-problem', 'problem', title, { commit: problem.baseCommit, path: sourcePath(problem, file), bytes, sha256: digest,
    retrieval: 'This statement is large, so it is cited rather than repeated. Read the complete text with git show COMMIT:PATH in this isolated worktree. ' +
      'The frozen source context below shows the same declarations, scopes and headers with proof and long definition bodies omitted.' });
}

function frozenHeader(problem: SolverProblem, node: Pick<TaskRecord, 'task'>): string | undefined {
  if (node.task.kind !== 'goal') return node.task.type;
  const exact = problem.declarations[node.task.proofPath!]?.filter(item =>
    item.name === node.task.theoremName || localName(item.name) === localName(node.task.theoremName!)) ?? [];
  if (exact.length !== 1) return missing(`interface:${node.task.id}`);
  return exact[0].header;
}

/** Kernel-verified at one target commit, with at least one receipt and every receipt at that commit. */
const receiptsComplete = ({ verification }: NonNullable<TaskRecord['proof']>) => verification.status === 'kernel_verified' &&
  present(verification.targetCommit) && verification.results.length > 0 && verification.results.every(result =>
    result.status === 'kernel_verified' && result.targetCommit === verification.targetCommit && present(result.receiptId));

function evidence(node: TaskRecord, environmentDigest?: string) {
  const proof = node.integratedCheck ?? node.proof;
  if (!proof) return undefined;
  if (proof.taskDigest !== taskVersion(node.task) || (environmentDigest && proof.references &&
      proof.references.environmentDigest !== environmentDigest) || (proof.passed && !receiptsComplete(proof)))
    return stale(`evidence:${node.task.id}`);
  return { evidence: 'recorded-not-replayed', passed: proof.passed, commit: proof.commit,
    sourceDigest: proof.sourceDigest, taskDigest: proof.taskDigest, conditions: proof.conditions ?? [],
    verification: { status: proof.verification.status, targetCommit: proof.verification.targetCommit,
      receipts: proof.verification.results.map(result => ({ receiptId: result.receiptId, status: result.status,
        targetCommit: result.targetCommit })) },
    references: proof.references && { sourceCommit: proof.references.sourceCommit,
      environmentDigest: proof.references.environmentDigest, contextDigest: proof.references.contextDigest,
      root: proof.references.root, inputs: proof.references.inputs, tasks: proof.references.tasks,
      statement: proof.references.statement, proof: proof.references.proof }, imports: proof.imports };
}

type EvidenceReferenceEntry = NonNullable<ReturnType<typeof evidence>>['references']['inputs'][number] |
  NonNullable<ReturnType<typeof evidence>>['references']['proof'][number] |
  NonNullable<ReturnType<typeof evidence>>['references']['tasks'][number];

/** First-seen index of each distinct key. */
function interner<T>(key: (value: T) => string) {
  const values: T[] = [], indices = new Map<string, number>();
  return { values, index: (value: T) => {
    const id = key(value), previous = indices.get(id);
    if (previous !== undefined) return previous;
    indices.set(id, values.length); values.push(value); return values.length - 1;
  } };
}

/** Intern exact metadata only; each proof retains its own source and verifier identities. */
function evidenceReferenceDictionary() {
  const { values: entries, index } = interner<EvidenceReferenceEntry>(canonicalMathJson);
  const { values: digests, index: digestIndex } = interner<string>(digest => digest);
  return { entries, digests, encode: (record: ReturnType<typeof sharedEvidence>) => record?.references ? {
    ...record, references: { ...record.references,
      environmentDigest: digestIndex(record.references.environmentDigest),
      contextDigest: digestIndex(record.references.contextDigest),
      inputs: record.references.inputs.map(index), proof: record.references.proof.map(index), tasks: record.references.tasks?.map(index),
      statement: record.references.statement.map(index) },
  } : record };
}

/** Null marks only exact field equality; absent or distinct receipt targets stay distinct. */
function sharedEvidence(record: ReturnType<typeof evidence>) {
  return record && { ...record, taskDigest: null, verification: { ...record.verification,
    receipts: record.verification.receipts.map(receipt => ({ ...receipt,
      targetCommit: receipt.targetCommit !== undefined && receipt.targetCommit === record.verification.targetCommit
        ? null : receipt.targetCommit })),
  } };
}

function closedLeadHelper(node: TaskRecord): boolean {
  const proof = node.integratedCheck;
  return node.task.kind === 'lemma' && node.status === 'integrated' && !!proof?.passed &&
    !proof.conditions?.length && hasTaskAcceptance(proof) && present(proof.commit) &&
    present(proof.sourceDigest) && present(node.task.proofPath) && present(node.task.theoremName);
}

function leadTaskInterface(node: TaskRecord, action: CooperativeAction | undefined,
  omitted: ContextManifest['omitted'][number][]) {
  if (action?.kind === 'task' && node.task.id === action.task.id) return { id: node.task.id };
  const finishedAdvisory = node.status === 'completed' && ['research', 'sketch'].includes(node.task.kind);
  if (action?.kind !== 'lead' || !(closedLeadHelper(node) || finishedAdvisory) ||
      Buffer.byteLength(node.task.objective) <= 1024) return node.task;
  // The full typed interface remains inline; only settled planning prose moves to the live peer index.
  const { objective, ...task } = node.task;
  omitted.push({ id: `objective:${task.id}`, kind: 'interfaces', reason: 'advisory-details-by-reference' });
  return { ...task, objectiveDigest: mathDigest(objective) };
}

/** Closed shared interfaces encapsulate private implementation prerequisites, never unresolved assumptions. */
function requiredTasks(input: TaskContextInput, omitted: ContextManifest['omitted'][number][]) {
  const tasks = input.cooperation?.tasks ?? [], byId = new Map(tasks.map(node => [node.task.id, node]));
  if (byId.size !== tasks.length) return missing('duplicate-task-id');
  const required = new Set<string>(), visiting = new Set<string>();
  const action = input.action;
  const scopedLead = action?.kind === 'lead' && tasks.some(node => node.task.kind === 'goal');
  if (action?.kind === 'task') {
    if (action.assignment.taskId !== action.task.id || action.assignment.taskDigest !== taskVersion(action.task))
      return stale(`assignment:${action.task.id}`);
    const current = byId.get(action.task.id);
    if (!current) return missing(`task:${action.task.id}`);
    if (taskVersion(current.task) !== action.assignment.taskDigest) return stale(`task:${action.task.id}`);
  }
  const visit = (id: string, consumer?: TaskRecord) => {
    const node = byId.get(id);
    if (!node) {
      const proof = consumer?.integratedCheck;
      if (consumer?.status === 'integrated' && proof?.passed && !proof.conditions?.length &&
          proof.taskDigest === taskVersion(consumer.task) && receiptsComplete(proof)) {
        omitted.push({ id: `interface:${id}`, kind: 'interfaces', reason: 'encapsulated-private-dependency' });
        return;
      }
      return missing(`dependency:${id}`);
    }
    if (visiting.has(id)) return missing(`dependency-cycle:${id}`);
    if (required.has(id)) return;
    visiting.add(id);
    // A typed interface must be supplied exactly; advisory tasks have no admitted proposition.
    if (['lemma', 'goal'].includes(node.task.kind) && !present(frozenHeader(input.problem, node)))
      return missing(`interface:${id}`);
    evidence(node, input.environmentDigest);
    required.add(id);
    const proof = node.integratedCheck ?? node.proof;
    for (const condition of proof?.conditions ?? []) {
      const dependency = byId.get(condition.taskId);
      if (!dependency) return missing(`condition:${condition.taskId}`);
      if (taskVersion(dependency.task) !== condition.taskDigest) return stale(`condition:${condition.taskId}`);
      visit(condition.taskId);
    }
    if (!scopedLead || !closedLeadHelper(node)) {
      for (const dependency of node.task.dependsOn) visit(dependency, node);
      if (action?.kind === 'lead') for (const route of [
        ...(input.cooperation?.proofRoutes ?? []), ...(node.alternativeRoutes ?? []),
      ]) if (route.targetTaskId === id) [...route.prerequisiteTaskIds, route.closingTaskId].forEach(dependency => visit(dependency));
    }
    visiting.delete(id);
  };
  // Unadopted proposals and refutations are ordinary planning inputs; their sources join the Lead's scope.
  const visitLeadInputs = () => {
    for (const delivery of selectedLeadResearchInputs(input, byId)) {
      visit(delivery.taskId!);
      delivery.dependencies.forEach(input => visit(input.taskId));
      for (const proposal of selectedLeadProposals(delivery, byId))
        proposal.dependsOn.filter(id => byId.has(id)).forEach(id => visit(id));
    }
  };
  if (action?.kind === 'task') visit(action.task.id);
  else if (scopedLead) {
    tasks.filter(node => node.task.kind === 'goal').forEach(node => visit(node.task.id));
    visitLeadInputs();
  }
  else tasks.forEach(node => visit(node.task.id));
  const route = action?.kind === 'task' && action.assignment.routeId ?
    input.cooperation?.proofRoutes?.find(route => route.id === action.assignment.routeId) ??
      byId.get(action.task.id)?.alternativeRoutes?.find(route => route.id === action.assignment.routeId) : undefined;
  if (action?.kind === 'task' && action.assignment.routeId) {
    if (!route || route.targetTaskId !== action.task.id) return missing(`route:${action.assignment.routeId}`);
    [...route.prerequisiteTaskIds, route.closingTaskId].forEach(id => visit(id));
  }
  if (action?.kind === 'task') for (const dependency of action.assignment.dependencies ?? []) {
    const current = byId.get(dependency.taskId);
    if (!current) {
      if (!omitted.some(item => item.id === `interface:${dependency.taskId}` && item.reason === 'encapsulated-private-dependency'))
        return missing(`dependency:${dependency.taskId}`);
    } else {
      if (taskVersion(current.task) !== dependency.taskDigest) return stale(`dependency:${dependency.taskId}`);
      visit(dependency.taskId);
    }
  }
  const deferred = scopedLead ? tasks.filter(node => !required.has(node.task.id)) : [];
  for (const node of deferred)
    omitted.push({ id: `interface:${node.task.id}`, kind: 'interfaces', reason: 'advisory-details-by-reference' });
  return { tasks: tasks.filter(node => required.has(node.task.id)), deferred, byId, required, route };
}

function taskRecordReference(node: TaskRecord) {
  return { id: node.task.id, taskDigest: taskVersion(node.task), recordDigest: mathDigest(canonicalMathJson(node)),
    kind: node.task.kind, status: node.status, control: node.task.status ?? 'active', groupId: taskGroup(node.task),
    owner: node.assignment?.workerId ?? node.task.ownerId, dependsOn: node.task.dependsOn,
    theoremName: node.task.theoremName, proofPath: node.task.proofPath };
}

function checkedHelperReference(input: TaskContextInput, node: TaskRecord) {
  const proof = evidence(node, input.environmentDigest)!;
  return { ...taskRecordReference(node), sharing: node.task.sharing ?? 'problem',
    source: { commit: proof.commit, path: sourcePath(input.problem, node.task.proofPath!), sourceDigest: proof.sourceDigest },
    evidence: 'recorded-not-replayed' };
}

function sourceReferences(input: TaskContextInput) {
  const problem = input.problem;
  if (!present(problem.baseCommit)) return missing('frozen-source-commit');
  if (!problem.declarations || !Array.isArray(problem.ownedFiles)) return missing('frozen-declarations');
  const frozen = problem.frozenFiles ?? {};
  const files = problem.ownedFiles.filter(file => file.endsWith('.lean') && !Object.hasOwn(frozen, file));
  for (const file of files)
    if (typeof input.frozenContexts?.[file] !== 'string') return missing(`frozen-context:${file}`);
  return { baseCommit: problem.baseCommit,
    retrieval: 'Read full proofs and namespace/section/instance context with git show COMMIT:PATH in this isolated worktree. Source references identify immutable content; they grant no proof acceptance.',
    files: files.map(file => {
      const context = input.frozenContexts![file], declarations = problem.declarations[file] ?? [];
      return { commit: problem.baseCommit, path: sourcePath(problem, file),
        contextDigest: problem.sourceStructure?.[file], imports: problem.sourceImports?.[file],
        // Large sources already retain every exact header in context. Repeating the
        // full declaration inventory can exhaust the budget before the first turn.
        ...(Buffer.byteLength(context) > COMPACT_CONTEXT_SOURCE_BYTES
          ? { declarationsFrom: 'context', declarationCount: declarations.length,
            targetDeclarations: declarations.filter(declaration => problem.targets.some(target =>
              target.proofPath === file && localName(target.theoremName) === localName(declaration.name))) }
          : { declarations }), context };
    }),
    // Library declarations are listed by the declaration index, not inline.
    ...(Object.keys(frozen).length ? { libraryFiles: Object.keys(frozen).sort().map(file => ({ commit: problem.baseCommit,
      path: sourcePath(problem, file), digest: frozen[file], frozenLibrary: true,
      declarationCount: problem.declarations[file]?.length ?? 0 })) } : {}),
    trustedFiles: Object.entries(problem.trustedFiles ?? {}).map(([file, digest]) =>
      ({ commit: problem.baseCommit, path: sourcePath(problem, file), digest })) };
}

/** Large frozen contexts already contain their headers; cite the complete order rather than repeating every name. */
function frozenDeclarationOrder(input: TaskContextInput) {
  return Object.fromEntries(Object.entries(input.problem.declarations)
    .filter(([file]) => !Object.hasOwn(input.problem.frozenFiles ?? {}, file))
    .map(([file, declarations]) => {
      const names = declarations.map(declaration => declaration.name), context = input.frozenContexts?.[file];
      return [file, context && Buffer.byteLength(context) > COMPACT_CONTEXT_SOURCE_BYTES ? {
        encoding: 'frozen-declaration-order-v1', commit: input.problem.baseCommit, path: sourcePath(input.problem, file),
        declarationCount: names.length, orderDigest: mathDigest(canonicalMathJson(names)),
        retrieval: 'Read the complete frozen file with git show COMMIT:PATH for its exact declaration order. ' +
          'The ordered array of declaration names as written (including dotted names and repeated local names) must match ' +
          'declarationCount and SHA-256(canonicalMathJson(names)) = orderDigest. ' +
          'Missing or mismatched source is unavailable. The frozen-sources context keeps the declaration headers inline; ' +
          'this reference replaces only the duplicate name list and grants no proof acceptance.',
      } : names];
    }));
}

function proofSources(problem: SolverProblem, node: TaskRecord) {
  const proof = node.integratedCheck ?? node.proof;
  return proof && { path: node.task.proofPath && sourcePath(problem, node.task.proofPath), evidenceFrom: 'evidence' };
}

const LEAD_RESEARCH_INPUTS = 8, LEAD_RESEARCH_PROPOSALS = 8, LEAD_INLINE_FINDING_BYTES = 2 * 1024;

/** Current research deliveries the Lead must review: unadopted lemma proposals, refutations and decision requests. */
export function leadResearchInputs(deliveries: readonly DeliveryRecord[], byId: ReadonlyMap<string, TaskRecord>,
  decisions: readonly ResearchDecision[] = []) {
  return deliveries.filter(record => {
    if (decisions.some(decision => researchDecisionMatches(record, decision))) return false;
    const source = record.taskId ? byId.get(record.taskId) : undefined;
    if (record.kind !== 'research' || record.status === 'superseded' || !source || record.taskDigest !== taskVersion(source.task) ||
        record.dependencies.some(input => !byId.has(input.taskId) || taskVersion(byId.get(input.taskId)!.task) !== input.taskDigest))
      return false;
    if (record.lemmaRequests?.some(task => !byId.has(task.id))) return true;
    // Host-bound check outcomes have their own per-publication nextCheckDecisions contract.
    if (source.nextCheckId && record.checkOutcome?.checkId === source.nextCheckId && record.checkOutcomeScope) return false;
    const text = deliveryFinding(record, source.finding);
    if (text === undefined) return false;
    try {
      const finding = JSON.parse(text);
      return finding?.conclusion === 'refuted' || finding?.needsDecision === true;
    } catch { return false; }
  });
}

function visibleLeadResearchInputs(input: Pick<TaskContextInput, 'cooperation'>, byId: ReadonlyMap<string, TaskRecord>) {
  const current = leadResearchInputs(input.cooperation?.deliveries ?? [], byId, input.cooperation?.researchDecisions);
  const ids = input.cooperation?.leadResearchInputIds;
  return ids ? ids.flatMap(id => current.find(record => record.id === id) ?? []) : current;
}

function selectedLeadResearchInputs(input: TaskContextInput, byId: ReadonlyMap<string, TaskRecord>) {
  return visibleLeadResearchInputs(input, byId).slice(-LEAD_RESEARCH_INPUTS).reverse();
}

function selectedLeadProposals(record: DeliveryRecord, byId: ReadonlyMap<string, TaskRecord>) {
  return (record.lemmaRequests ?? []).filter(task => !byId.has(task.id)).slice(0, LEAD_RESEARCH_PROPOSALS);
}

/** Exact proposals stay inline; a long finding is retrievable by digest from its saved notes. */
function leadResearchInput(record: DeliveryRecord, byId: ReadonlyMap<string, TaskRecord>) {
  const finding = deliveryFinding(record, byId.get(record.taskId!)?.finding);
  const proposals = (record.lemmaRequests ?? []).filter(task => !byId.has(task.id));
  return { deliveryId: record.id, producer: record.producer, taskId: record.taskId, taskDigest: record.taskDigest,
    summary: record.summary, evidenceRefs: record.evidenceRefs, remainingObligations: record.remainingObligations,
    ...(record.sourceUses?.length ? { sourceUseCount: record.sourceUses.length,
      sourceUseConsumers: [...new Set(record.sourceUses.map(use => use.consumer.taskId))] } : {}),
    ...(finding === undefined ? {} : Buffer.byteLength(finding) <= LEAD_INLINE_FINDING_BYTES ? { finding } : {
      findingBytes: Buffer.byteLength(finding), findingDigest: record.findingDigest }),
    ...(record.commit ? { savedSource: { commit: record.commit, notesPath: 'RESEARCH.md' } } : {}),
    ...(proposals.length ? { lemmaRequests: selectedLeadProposals(record, byId),
      ...(proposals.length > LEAD_RESEARCH_PROPOSALS ? { unshownProposals: proposals.length - LEAD_RESEARCH_PROPOSALS } : {}) } : {}) };
}

/** Full and same-thread Lead contexts carry the same exact presented publications. */
export function leadResearchInputSection(input: Pick<TaskContextInput, 'cooperation'>,
  byId: ReadonlyMap<string, TaskRecord> = new Map(input.cooperation?.tasks.map(node => [node.task.id, node]))) {
  // Newest first, so a stale unanswered input never hides newer evidence.
  const inputs = visibleLeadResearchInputs(input, byId).reverse();
  if (!inputs.length) return;
  return section('lead-research-inputs', 'assignment',
    'Research inputs for this planning decision (advisory, not checked lemmas or proof acceptance; retrieve a long finding from savedSource commit and notesPath):', {
      inputs: inputs.slice(0, LEAD_RESEARCH_INPUTS).map(record => leadResearchInput(record, byId)),
      ...((input.cooperation?.leadResearchInputCount ?? inputs.length) > LEAD_RESEARCH_INPUTS
        ? { unshown: (input.cooperation?.leadResearchInputCount ?? inputs.length) - LEAD_RESEARCH_INPUTS } : {}),
    });
}

function deliveryMatchesFinding(record: DeliveryRecord, node?: TaskRecord): boolean {
  if (record.kind !== 'research' || !node || !present(node.finding)) return false;
  return record.findingDigest === undefined ? record.summary === node.finding : record.findingDigest === mathDigest(node.finding);
}

/** 0 for the active task, 1 for its required closure, 2 for its group, 3 otherwise. */
const scopeRank = (active: TaskRecord['task'] | undefined, required: ReadonlySet<string>) => (taskId?: string, groupId?: string) =>
  active && taskId === active.id ? 0 : required.has(taskId ?? '') ? 1 : active && groupId === taskGroup(active) ? 2 : 3;

function optionalDeliveries(input: TaskContextInput, required: ReadonlySet<string>,
  byId: ReadonlyMap<string, TaskRecord>, omitted: ContextManifest['omitted'][number][]) {
  const action = input.action, active = action?.kind === 'task' ? action.task : undefined;
  const rank = scopeRank(active, required), priority = (record: DeliveryRecord) => rank(record.taskId, record.groupId);
  const seen = new Set<string>(), selected: DeliveryRecord[] = [];
  const findingSources = new Map<string, { deliveryId: string; commit: string; notesPath: 'RESEARCH.md'; sourceDigest?: string }>();
  for (const record of [...(input.cooperation?.deliveries ?? [])].reverse().sort((a, b) => priority(a) - priority(b))) {
    const id = `delivery:${record.id}`, current = record.taskId ? byId.get(record.taskId) : undefined;
    let reason: ContextOmissionReason | undefined;
    if (record.status === 'superseded') reason = 'superseded';
    else if ((current && record.taskDigest !== taskVersion(current.task)) || record.dependencies?.some(dependency =>
      byId.has(dependency.taskId) && taskVersion(byId.get(dependency.taskId)!.task) !== dependency.taskDigest)) reason = 'stale-version';
    if (!reason && current && deliveryMatchesFinding(record, current) && record.commit &&
        !findingSources.has(current.task.id)) findingSources.set(current.task.id, {
      deliveryId: record.id, commit: record.commit, notesPath: 'RESEARCH.md', sourceDigest: record.sourceDigest,
    });
    const key = json([record.taskId ?? record.id, record.taskDigest, record.kind, record.producer, record.findingDigest]);
    if (!reason && seen.has(key)) reason = 'duplicate';
    if (!reason && selected.length >= 8) reason = 'selection-limit';
    if (reason) { omitted.push({ id, kind: 'delivery', reason }); continue; }
    seen.add(key); selected.push(record);
  }
  const sections = selected.flatMap(record => {
    // Interfaces and receipts live in mandatory sections. A delivery summary is advisory prose.
    const current = record.taskId ? byId.get(record.taskId) : undefined;
    // Keep a shared mathematical finding independently selectable from its delivery metadata.
    const sharedFinding = deliveryMatchesFinding(record, current);
    const ownFinding = sharedFinding ? undefined : deliveryFinding(record);
    const findingId = sharedFinding ? `finding:${record.taskId}` : ownFinding ? `finding:delivery:${record.id}` : undefined;
    if (record.actualReferences || record.artifacts?.artifacts.some(artifact => artifact.declarations.length))
      omitted.push({ id: `delivery:${record.id}:details`, kind: 'delivery', reason: 'advisory-details-by-reference' });
    const visible = {
      id: record.id, submissionId: record.submissionId, statementReviewId: record.statementReviewId,
      producer: record.producer, taskId: record.taskId, taskDigest: record.taskDigest, groupId: record.groupId,
      kind: record.kind, status: record.status, statement: record.statement, premises: record.premises, findingDigest: record.findingDigest,
      dependencies: record.dependencies, remainingObligations: record.remainingObligations,
      evidenceRefs: record.evidenceRefs, createdAt: record.createdAt, commit: record.commit, sourceDigest: record.sourceDigest,
      savedSource: record.commit && { commit: record.commit, notesPath: 'RESEARCH.md',
        proofPath: current && current.task.proofPath && sourcePath(input.problem, current.task.proofPath) },
      actualReferenceSource: record.actualReferences && { sourceCommit: record.actualReferences.sourceCommit,
        root: record.actualReferences.root, environmentDigest: record.actualReferences.environmentDigest,
        contextDigest: record.actualReferences.contextDigest, tasks: record.actualReferences.tasks },
      artifacts: record.artifacts && { ...record.artifacts, artifacts: record.artifacts.artifacts.map(artifact => ({
        ...artifact, declarations: artifact.declarations.map(({ name, sha256, draft }) => ({ name, sha256, draft })),
      })) },
      artifactWarning: record.artifactWarning, lemmaRequests: record.lemmaRequests,
      sourceUseCount: record.sourceUses?.length,
    };
    return [{ ...section(`delivery:${record.id}`, 'delivery', 'Current-version delivery selected for this task (advisory; retain unproved obligations):',
      { ...visible, ...(findingId ? { summarySource: findingId } : { summary: record.summary }) }),
      priority: priority(record) * 10 + 2 }, ...(ownFinding ? [{ ...section(findingId!, 'finding', 'Immutable advisory research publication:', {
        taskId: record.taskId, taskDigest: record.taskDigest, finding: ownFinding, findingDigest: record.findingDigest,
        savedSource: { commit: record.commit, notesPath: 'RESEARCH.md' },
      }), priority: priority(record) * 10 + 1 }] : [])];
  });
  return { sections, findingSources };
}

/** Compile a task's mathematical interface before dispatch. A budget can omit hints, never hypotheses. */
export function compileTaskContext(input: TaskContextInput): { message: string; manifest: ContextManifest } {
  const { problem, action } = input;
  const maxBytes = input.maxContextBytes ?? DEFAULT_TASK_CONTEXT_BYTES;
  const maxOptionalBytes = input.maxOptionalContextBytes ?? DEFAULT_OPTIONAL_TASK_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TaskContextError('math_context_invalid_budget', 'maxContextBytes');
  if (!Number.isSafeInteger(maxOptionalBytes) || maxOptionalBytes < 0)
    throw new TaskContextError('math_context_invalid_budget', 'maxOptionalContextBytes');
  if (!present(problem.receiptDigest) || !present(problem.contract?.formalStatement) || !Array.isArray(problem.contract?.assumptions))
    return missing('frozen-problem');
  const omitted: ContextManifest['omitted'][number][] = [];
  const { tasks, deferred, byId, required, route: selectedRoute } = requiredTasks(input, omitted);
  const consumers = action?.kind === 'task' ? contextTaskConsumers(action.task, input.cooperation?.tasks ?? [], input.cooperation) : [];
  const consumerIds = new Set(consumers.map(consumer => consumer.task.id));
  if (consumerIds.size !== consumers.length) return missing('duplicate-consumer-id');
  for (const consumer of consumers) {
    const current = byId.get(consumer.task.id);
    if (consumer.taskDigest !== taskVersion(consumer.task) || (current && taskVersion(current.task) !== consumer.taskDigest))
      return stale(`consumer:${consumer.task.id}`);
    if (['lemma', 'goal'].includes(consumer.task.kind) && !present(frozenHeader(problem, consumer)))
      return missing(`interface:${consumer.task.id}`);
  }
  const references = evidenceReferenceDictionary();
  const graph = tasks.map(node => ({ ...leadTaskInterface(node, action, omitted), taskDigest: taskVersion(node.task),
    status: node.status, attempts: node.attempts, groupId: taskGroup(node.task), producer: node.assignment?.workerId,
    sharing: node.task.sharing ?? 'problem',
    integratedCommit: node.integratedCheck ? null : undefined, checkedSourceDigest: node.integratedCheck ? null : undefined,
    ...(node.task.kind === 'goal' ? { exactFrozenHeader: frozenHeader(problem, node) } : {}),
    evidence: references.encode(sharedEvidence(evidence(node, input.environmentDigest))), source: proofSources(problem, node) }));
  const mandatory: ContextSection[] = [
    originalProblemSection(input),
    section('original-assumptions', 'problem', 'Frozen assumptions and problem identity:', { problemReceiptDigest: problem.receiptDigest,
      statementHash: problem.contract.statementHash, leanStatementHash: problem.contract.leanStatementHash,
      informalStatement: problem.contract.informalStatement, assumptions: problem.contract.assumptions }),
    section('frozen-sources', 'sources', 'Frozen source context and immutable retrieval references:', sourceReferences(input)),
  ];
  if (action) mandatory.push(section('assignment', 'assignment', 'Cooperative assignment:', action));
  if (consumers.length) mandatory.push(section('consumer-interfaces', 'interfaces',
    'Planned consumer interfaces (read-only mathematical purpose; not premises, proof evidence or permission to edit consumers):',
    consumers.map(consumer => ({ ...consumer.task, taskDigest: consumer.taskDigest, status: consumer.status, uses: consumer.uses,
      ...(consumer.task.kind === 'goal' ? { exactFrozenHeader: frozenHeader(problem, consumer) } : {}) }))));
  if (input.feedback) mandatory.push(section('current-feedback', 'feedback',
    'Current host feedback (preserve the frozen original problem):', input.feedback));
  const assigned = action?.kind === 'task' ? byId.get(action.task.id) : undefined;
  if (assigned?.feedback) mandatory.push(section(`feedback:${assigned.task.id}`, 'feedback',
    `Host feedback for ${assigned.task.id}:`, assigned.feedback));
  if (selectedRoute) mandatory.push(section(`route:${selectedRoute.id}`, 'routes', 'Selected alternative route and exact closing obligation (planned, not accepted):', selectedRoute));
  if (input.cooperation) {
    if (input.cooperation.mathematicalGaps?.length) mandatory.push({ id: 'mathematical-gaps', kind: 'finding',
      text: mathematicalGapContextText(input.cooperation.mathematicalGaps) });
    const nextChecks = nextCheckContextText(input.cooperation.nextChecks ?? [], action?.kind === 'task' ? action.task.id : undefined);
    if (nextChecks) mandatory.push({ id: 'next-checks', kind: 'finding', text: nextChecks });
    const progressChecks = action?.kind === 'task' ? goalProgressTaskContext(input.cooperation.goalProgress, action.task) : '';
    if (progressChecks) mandatory.push({ id: 'goal-review-next-checks', kind: 'assignment', text: progressChecks });
    if (action?.kind === 'lead') {
      const researchInputs = leadResearchInputSection(input, byId);
      if (researchInputs) mandatory.push(researchInputs);
    }
    mandatory.push(section('task-interfaces', 'interfaces', 'Lead task graph and host feedback:', graph));
    if (graph.some(node => 'objectiveDigest' in node)) mandatory.push(section('task-objective-reference-encoding', 'sources',
      'Finished task objective references (advisory prose by reference; exact interfaces remain mandatory):', {
        encoding: 'finished-task-objectives-v1',
        retrieval: 'Retrieve omitted finished objectives from worktree-root COOPERATION.json peers by id. Require peer.taskDigest = row.taskDigest ' +
          'and UTF-8 SHA-256(peer.objective) = row.objectiveDigest. Missing or mismatched descriptions are unavailable. ' +
          'This live file is not an immutable proof source and grants no proof acceptance. Exact Lean types, premises, dependencies, ' +
          'unresolved conditions and evidence stay inline; completed research/sketch tasks remain advisory.',
      }));
    if (deferred.length) {
      mandatory.push(section('task-record-reference-encoding', 'sources',
        'Digest-bound task record retrieval (required before using an indexed task):', {
          retrieval: 'Read worktree-root COOPERATION.json tasks[] and match record.task.id to row.id. Require taskVersion(record.task) = row.taskDigest ' +
            'and SHA-256(canonicalMathJson(record)) = row.recordDigest; canonicalMathJson sorts object keys recursively and omits undefined object fields. ' +
            'Missing or mismatched records are unavailable. Retrieve exact Lean types, premises, conditions, feedback and evidence before reasoning from ' +
            'an indexed task or replacing the full plan. Every visible task remains discoverable, including running and blocked work. ' +
            'This live file is not an immutable proof source and grants no proof acceptance. A checked helper source commit/path identifies ' +
            'immutable Lean content retrievable with git show COMMIT:PATH; its recorded acceptance must still be independently checked when used.',
        }));
      const helpers = deferred.filter(closedLeadHelper), others = deferred.filter(node => !closedLeadHelper(node));
      if (helpers.length) mandatory.push(section('checked-helper-catalog', 'sources',
        'Checked helpers outside the current open-task closure (retrieve before using; recorded, not replayed):', {
          helpers: helpers.map(node => checkedHelperReference(input, node)),
        }));
      if (others.length) mandatory.push(section('task-record-index', 'sources',
        'Other visible task records outside the current goal and requested-input closure (retrieve exact interfaces before use):', {
          tasks: others.map(taskRecordReference),
        }));
    }
    if (action?.kind === 'lead') {
      const continuation = buildProofContinuation(tasks, { groups: input.cooperation.groups,
        environmentDigest: input.environmentDigest, proofRoutes: input.cooperation.proofRoutes });
      const goals = continuation.goals.filter(goal => goal.status !== 'integrated' || goal.recordedProof !== 'checked');
      const frontierIds = new Set(goals.flatMap(goal => goal.frontier));
      const relevant = new Set<string>();
      const visit = (id: string) => {
        if (relevant.has(id) || !required.has(id)) return;
        relevant.add(id); byId.get(id)!.task.dependsOn.forEach(visit);
        for (const route of input.cooperation!.proofRoutes ?? byId.get(id)!.alternativeRoutes ?? [])
          if (route.targetTaskId === id) [...route.prerequisiteTaskIds, route.closingTaskId].forEach(visit);
      };
      goals.forEach(goal => visit(goal.taskId));
      if (goals.length) mandatory.push(section('original-goal-frontier', 'continuation',
        'Unfinished original goals and their current frontier (recorded, not proof acceptance):', {
          goals: goals.map(({ taskId, frontier, missingDependencies, alternatives }) => ({ taskId, frontier, missingDependencies, alternatives })),
          frontier: continuation.frontier.filter(item => frontierIds.has(item.taskId)).map(item => ({ ...item,
            feedback: byId.get(item.taskId)?.feedback })),
          blockers: (input.cooperation.blockers ?? []).filter(blocker => relevant.has(blocker.taskId) &&
            blocker.status !== 'superseded' && blocker.taskDigest === taskVersion(byId.get(blocker.taskId)!.task))
            .map(({ id, taskId, routeId, status, mechanism, scope, evidenceStatus, reopenOn }) =>
              ({ id, taskId, routeId, status, mechanism, scope, evidenceStatus, reopenOn })),
        }));
    }
    const publicationFeedback = leadPlanPublicationFeedback(action, input.cooperation);
    if (publicationFeedback) mandatory.push({ id: 'plan-publication-rejection', kind: 'feedback', text: publicationFeedback });
    const checkpointFeedback = contextCheckpointRejectionFeedback(input.cooperation.contextCheckpointRejection,
      action?.kind === 'task' ? assignmentDeliveryFile(action.assignment) : action && leadPlanDeliveryFile(action));
    if (checkpointFeedback) mandatory.push({ id: 'context-checkpoint-rejection', kind: 'feedback', text: checkpointFeedback });
    if (action?.kind === 'lead' && input.cooperation.error) mandatory.push(section('plan-rejection', 'feedback',
      'Host rejected the proposed plan. Repair this error while preserving every exact original target:', {
        error: input.cooperation.error, rejection: input.cooperation.planRejection,
        originalTargets: problem.targets.map(({ proofPath, theoremName }) => ({ proofPath, theoremName })),
      }));
    const visibleGroups = new Set(tasks.map(node => taskGroup(node.task)));
    mandatory.push(section('groups', 'groups', 'Route groups and budgets:',
      input.cooperation.groups?.filter(route => action?.kind !== 'task' || visibleGroups.has(route.group.id)) ?? []));
    if (references.entries.length || references.digests.length) mandatory.push(section('evidence-reference-dictionary', 'sources',
      'Complete evidence reference dictionary (mandatory, recorded-not-replayed):', {
        encoding: 'evidence-reference-indices-v3', projectRelative: problem.projectRelative.replaceAll('\\', '/'),
        expansion: 'Each numeric element in a task evidence.references.inputs, proof, statement or tasks array indexes entries below. ' +
          'Expand every index in its original array order. A task source.inputsFrom names its evidence.references.inputs; ' +
          'each expanded input retains all fields and uses that task evidence.references.sourceCommit as commit and path.posix.join(projectRelative, input.file) as path. ' +
          'Source commits, verifier target commits and evidence remain distinct. Indexing grants no proof acceptance.',
        entries: references.entries,
        digestExpansion: 'Each numeric task evidence.references.environmentDigest or contextDigest indexes digests below. ' +
          'Replace that number with the exact original digest string. Digest sharing changes representation only; ' +
          'retain each source commit, verifier target commit, condition and reference inventory separately.',
        digests: references.digests,
      }));
    if (graph.some(node => node.source)) mandatory.push(section('proof-source-reference-encoding', 'sources',
      'Complete proof source reference encoding (mandatory, recorded-not-replayed):', {
        encoding: 'proof-source-evidence-v2',
        expansion: 'A task row.source with evidenceFrom="evidence" expands to {commit: row.evidence.commit, path: row.source.path, ' +
          'sourceDigest: row.evidence.sourceDigest}. If row.evidence.references exists, add inputsFrom="evidence.references.inputs"; ' +
          'otherwise omit inputsFrom. Preserve the actual source path and all values exactly. The source commit is row.evidence.commit, ' +
          'distinct from row.evidence.verification.targetCommit and row.evidence.references.sourceCommit. ' +
          'This encoding shares metadata only and grants no proof acceptance.',
        fieldExpansion: 'A null row.evidence.taskDigest expands to row.taskDigest. A null row.integratedCommit expands to row.evidence.commit; ' +
          'a null row.checkedSourceDigest expands to row.evidence.sourceDigest. A null receipt.targetCommit expands to its enclosing ' +
          'row.evidence.verification.targetCommit. Only null has this meaning; absent fields remain absent, and every distinct explicit value is retained.',
      }));
  }
  mandatory.push(section('declaration-order', 'sources', 'Frozen declaration order by file:', frozenDeclarationOrder(input)),
  section('original-targets', 'problem', 'Original targets:', problem.targets));
  mandatory.push(...(input.mandatory ?? []));
  const { sections: deliveries, findingSources } = optionalDeliveries(input, required, byId, omitted);
  const active = action?.kind === 'task' ? action.task : undefined;
  const checkpoint = active && input.cooperation?.researchCheckpoints?.[active.id];
  if (active && checkpoint?.taskDigest === taskVersion(active) && checkpoint.unchangedEvidenceCount !== undefined)
    mandatory.push(section('checkpoint-evidence', 'checkpoint', 'Host checkpoint observations (advisory, no solving deadline):', {
      taskId: active.id, savedCheckpointCountWithoutCandidateChange: checkpoint.unchangedEvidenceCount,
      candidateStatus: checkpoint.candidateStatus,
      interpretation: 'Notes and drafts remain saved. Candidate identity covers retained code and structured references or proposals; ' +
        'unclassified prose can contain useful mathematics and has not been assessed. A changed file is not proof progress. ' +
        'Use the saved argument and identify a concrete new check, missing input or consumer application before repeating an attempt. ' +
        'This observation neither accepts a theorem nor stops continued reasoning.',
    }));
  const seenAttempts = new Set<string>();
  const repeatedAttempts = active ? (input.cooperation?.failedTaskInputs ?? []).toReversed().filter(record => {
    if (record.taskId !== active.id || record.taskDigest !== taskVersion(active) || !record.relatedFailureIds?.length ||
        !record.attemptFingerprint || seenAttempts.has(record.attemptFingerprint)) return false;
    seenAttempts.add(record.attemptFingerprint); return true;
  }) : [];
  const attemptHint = (record: typeof repeatedAttempts[number]) => ({ failureId: record.id,
      attemptFingerprint: record.attemptFingerprint, relatedFailureIds: record.relatedFailureIds,
      interpretation: 'The saved target text and local mathematical inputs match an earlier failure. Full source or declaration placement changed, ' +
        'so this is a search hint, not mathematical equivalence or permission to reuse a verification result.' });
  if (repeatedAttempts.length) mandatory.push(section('repeated-attempts', 'feedback',
    'Latest related failed attempt (advisory; full-source checks remain independent). Older search hints use the optional budget:',
    { relatedAttemptFingerprints: repeatedAttempts.length, latest: attemptHint(repeatedAttempts[0]) }));
  const rank = scopeRank(active, required);
  const deferredIds = new Set(deferred.map(node => node.task.id));
  const optional: ContextSection[] = [];
  if (repeatedAttempts.length > 1) optional.push({ ...section('repeated-attempt-history', 'feedback',
    'Earlier related failed attempts (advisory; not permission to reuse verification):',
    repeatedAttempts.slice(1).map(attemptHint)), priority: 0 });
  for (const blocker of [...(input.cooperation?.blockers ?? [])].sort((a, b) => rank(a.taskId, a.groupId) - rank(b.taskId, b.groupId))) {
    const id = `blocker:${blocker.id}`;
    if (!byId.has(blocker.taskId) || (active && blocker.groupId !== taskGroup(active) && !required.has(blocker.taskId))) {
      omitted.push({ id, kind: 'blocker', reason: 'outside-task-scope' }); continue;
    }
    if (blocker.status === 'superseded' || blocker.taskDigest !== taskVersion(byId.get(blocker.taskId)!.task)) {
      omitted.push({ id, kind: 'blocker', reason: blocker.status === 'superseded' ? 'superseded' : 'stale-version' }); continue;
    }
    // The complete recurrence basis can contain private prerequisite identities; the public interface does not need it.
    const { basis: _basis, ...publicBlocker } = blocker;
    optional.push({ ...section(id, 'blocker', 'Local route blocker and reopening conditions (advisory):', publicBlocker), priority: rank(blocker.taskId, blocker.groupId) * 10 + 1 });
  }
  optional.push(...deliveries);
  for (const node of [...(input.cooperation?.tasks ?? [])].sort((a, b) =>
    rank(a.task.id, taskGroup(a.task)) - rank(b.task.id, taskGroup(b.task)))) {
    const priority = rank(node.task.id, taskGroup(node.task)) * 10;
    if (node.feedback && node.task.id !== active?.id) optional.push({ ...section(`feedback:${node.task.id}`, 'feedback', `Host feedback for ${node.task.id}:`, node.feedback), priority: priority + 3 });
    if (present(node.finding)) optional.push({ ...section(`finding:${node.task.id}`, 'finding', `Advisory finding for ${node.task.id}:`, {
      taskId: node.task.id, taskDigest: taskVersion(node.task), finding: node.finding,
      savedSource: findingSources.get(node.task.id),
    }), priority: priority + 1 });
    if (!required.has(node.task.id) && !consumerIds.has(node.task.id) && !deferredIds.has(node.task.id)) optional.push({ ...section(`interface:${node.task.id}`, 'interfaces', 'Other visible task (advisory planning context):',
      { ...node.task, taskDigest: taskVersion(node.task), status: node.status }), priority: priority + 8 });
  }
  for (const route of input.cooperation?.proofRoutes ?? []) {
    if (route.id === selectedRoute?.id) continue;
    if ([route.targetTaskId, route.closingTaskId, ...route.prerequisiteTaskIds].every(id => byId.has(id)))
      optional.push(section(`route:${route.id}`, 'routes', 'Alternative route and closing obligation (planned, not accepted):', route));
    else omitted.push({ id: `route:${route.id}`, kind: 'routes', reason: 'outside-task-scope' });
  }
  for (const [index, entry] of [...(input.cooperation?.history ?? [])].reverse().entries()) {
    const id = `history:${entry.task.id}:${taskVersion(entry.task)}:${index}`;
    if (active && !required.has(entry.task.id) && taskGroup(entry.task) !== taskGroup(active)) {
      omitted.push({ id, kind: 'history', reason: 'outside-task-scope' }); continue;
    }
    const proof = entry.integratedCheck ?? entry.proof;
    optional.push({ ...section(id, 'history', 'Earlier route finding (historical and advisory; not a current premise):', {
      taskId: entry.task.id, taskDigest: taskVersion(entry.task), objective: entry.task.objective,
      producer: entry.producer, finding: entry.finding, commit: proof?.commit, sourceDigest: proof?.sourceDigest,
      evidenceRefs: proof?.verification.results.map(result => result.receiptId),
      source: proof && entry.task.proofPath ? { commit: proof.commit, path: sourcePath(problem, entry.task.proofPath) } : undefined,
      evidence: 'historical-not-current' }), priority: rank(entry.task.id, taskGroup(entry.task)) * 10 + 5 });
  }
  if (input.checkpoint) {
    mandatory.push(section('checkpoint-source', 'sources', 'Complete current research checkpoint source (advisory, not proof acceptance):', {
      path: 'RESEARCH.md', bytes: Buffer.byteLength(input.checkpoint), digest: mathDigest(input.checkpoint),
      retrieval: 'If the checkpoint section is omitted for budget, read worktree-root RESEARCH.md before continuing the argument. ' +
        'Require the recorded byte length and UTF-8 SHA-256 to match; otherwise report that the saved checkpoint is unavailable. Resume from its attempted methods, exact results and evidence locations, scoped negative searches, and precise unresolved next inference; retain these before the next checkpoint or context rotation. Recheck claims in Lean and reopen a negatively searched scope only with a relevant changed input or genuinely different mathematical method.',
    }));
    optional.push({ ...section('checkpoint', 'checkpoint', 'Current research checkpoint (advisory; recheck claims in Lean):', input.checkpoint), priority: 5 });
  }
  optional.push(...(input.optional ?? []));
  return compileSections(input.instructions, mandatory, optional.sort((a, b) => (a.priority ?? 20) - (b.priority ?? 20)),
    omitted, [...required], maxBytes, maxOptionalBytes);
}

export type CompiledContext = Readonly<{ message: string; manifest: ContextManifest }>;

/** Compile a same-thread dispatch with the same budget and manifest rules as a full task context. */
export function compileContextSections(input: Readonly<{
  instructions: string; mandatory: readonly ContextSection[]; optional?: readonly ContextSection[];
  omitted?: ContextManifest['omitted']; requiredTaskIds?: readonly string[];
  maxContextBytes?: number; maxOptionalContextBytes?: number;
  /** Custom M4 prompts may have their own wire format; their manifest still lives in CONTEXT-MANIFEST.json. */
  inlineManifest?: boolean;
}>): CompiledContext {
  const maxBytes = input.maxContextBytes ?? DEFAULT_TASK_CONTEXT_BYTES;
  const maxOptionalBytes = input.maxOptionalContextBytes ?? DEFAULT_OPTIONAL_TASK_CONTEXT_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TaskContextError('math_context_invalid_budget', 'maxContextBytes');
  if (!Number.isSafeInteger(maxOptionalBytes) || maxOptionalBytes < 0)
    throw new TaskContextError('math_context_invalid_budget', 'maxOptionalContextBytes');
  return compileSections(input.instructions, input.mandatory, input.optional ?? [], [...(input.omitted ?? [])],
    input.requiredTaskIds ?? [], maxBytes, maxOptionalBytes, input.inlineManifest);
}

function compileSections(instructions: string, mandatory: readonly ContextSection[], optional: readonly ContextSection[],
  initialOmissions: ContextManifest['omitted'][number][], requiredTaskIds: readonly string[], maxBytes: number, maxOptionalBytes: number,
  embedManifest = true) {
  const selected: ContextSection[] = [];
  const omissionReasons = new Map<string, ContextOmissionReason>();
  const optionalBytes = (items: readonly ContextSection[]) => items.reduce((total, item) => total + Buffer.byteLength(item.text) + 2, 0);
  const render = (selected: readonly ContextSection[], mandatoryBytes?: number) => {
    const included = [...mandatory.map(item => ({ ...item, required: true })), ...selected.map(item => ({ ...item, required: false }))];
    const content = included.map(item => item.text).join('\n\n');
    const includedIds = new Set(selected.map(item => item.id));
    const manifest: { -readonly [K in keyof ContextManifest]: ContextManifest[K] } = {
      schema: 'theorem-os.task-context.v1', evidence: 'recorded-not-replayed', maxBytes, usedBytes: 0, mandatoryBytes: mandatoryBytes ?? 0,
      maxOptionalBytes, optionalBytes: optionalBytes(selected),
      contentDigest: mathDigest(json({ instructions, message: content })), requiredTaskIds,
      included: included.map(item => ({ id: item.id, kind: item.kind, required: item.required, bytes: Buffer.byteLength(item.text) })),
      omitted: [...initialOmissions, ...optional.filter(item => !includedIds.has(item.id))
        .map(item => ({ id: item.id, kind: item.kind, reason: omissionReasons.get(item.id) ?? 'budget' as const }))],
    };
    const omissionPreview = manifest.omitted.length <= 16 ? undefined : {
      omitted: manifest.omitted.slice(0, 16),
      omissionSet: { selection: 'bounded-preview', count: manifest.omitted.length,
        digest: mathDigest(canonicalMathJson(manifest.omitted)),
        reference: { path: 'CONTEXT-MANIFEST.json', field: 'omitted' },
        retrieval: 'Read the full manifest file; require matching contentDigest, omitted count and canonical JSON SHA-256. ' +
          'Inline omissions are a preview.' } };
    let message: string;
    do {
      // Large audit inventories already live in the durable worker manifest. Keep the
      // byte accounting and omission preview inline without repeating section metadata.
      const { included: _included, requiredTaskIds: _requiredTaskIds, ...summary } = manifest;
      const inlineManifest = omissionPreview ? { ...summary, manifestRef: 'CONTEXT-MANIFEST.json', ...omissionPreview } : manifest;
      message = embedManifest ? content + '\n\nContext compilation manifest:\n' + json(inlineManifest) : content;
      const usedBytes = Buffer.byteLength(instructions) + Buffer.byteLength(message);
      if (usedBytes === manifest.usedBytes) break;
      manifest.usedBytes = usedBytes;
      if (mandatoryBytes === undefined) manifest.mandatoryBytes = usedBytes;
    } while (true);
    return { message, manifest };
  };
  const mandatoryResult = () => {
    const result = render([]);
    if (result.manifest.usedBytes > maxBytes)
      throw new TaskContextError('math_context_mandatory_overflow', `${result.manifest.usedBytes}>${maxBytes}`);
    return result;
  };
  let mandatoryBytes = mandatoryResult().manifest.usedBytes;
  for (const item of optional) {
    const candidate = render([...selected, item], mandatoryBytes);
    if (candidate.manifest.usedBytes > maxBytes) omissionReasons.set(item.id, 'budget');
    else if (candidate.manifest.optionalBytes > maxOptionalBytes) omissionReasons.set(item.id, 'optional-budget');
    else selected.push(item);
  }
  // Final omission reasons can enlarge the manifest; retain the hard byte boundary after recording them.
  mandatoryBytes = mandatoryResult().manifest.usedBytes;
  let result = render(selected, mandatoryBytes);
  while (result.manifest.usedBytes > maxBytes && selected.length) {
    omissionReasons.set(selected.pop()!.id, 'budget');
    mandatoryBytes = mandatoryResult().manifest.usedBytes;
    result = render(selected, mandatoryBytes);
  }
  return result;
}
