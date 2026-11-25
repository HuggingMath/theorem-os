import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathFile, withMathRuntimeLease, writeMathTextDurable } from './mathRuntimeIo';
import { assertMathCanonicalPath } from './paths';
import { limitMathOutput } from './mathProcess';
import { scheduleMathTimeout } from './mathTimers';
import { resolveMathematicsRuntimeEnvironment } from './mathRuntimeEnvironment';
import { prepareLeanSearchProjection, prepareRetainedLeanSearchProjection } from './leanSearchProjection';
import { openPantographSession, readPantographBackend, type ProofSearchSession } from './pantographSession';
import { localProofSearchPath, projectedProofSearchPath, proofSearchDirectory } from './proofSearchCheckpointPath';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const identity = z.string().min(1).max(256);
export const proofSearchScopeSchema = z.object({ taskId: identity, taskDigest: identity,
  problemReceiptDigest: identity, environmentDigest: identity }).strict();
export type LeanProofSearchScope = z.infer<typeof proofSearchScopeSchema>;
const referenceSchema = z.object({ path: z.string().min(1).max(4096), digest }).strict();
export type SearchCheckpointReference = z.infer<typeof referenceSchema>;
const tactic = z.string().min(1).max(12000).refine(value => value.trim().length > 0 && Buffer.byteLength(value) <= 12000);
const proposalSchema = z.object({ id: identity, premiseIds: z.array(identity).max(32) }).strict();
const branchSchema = z.object({ from: digest.optional(), tactics: z.array(tactic).max(64),
  proposal: proposalSchema.optional() }).strict();
const limitsSchema = z.object({ timeoutMs: z.number().int().min(1).max(600_000),
  maxTransitions: z.number().int().min(1).max(256) }).strict();
export const proofSearchRequestSchema = z.object({
  branches: z.array(branchSchema).min(1).max(32),
  resume: referenceSchema.optional(),
  limits: limitsSchema.default({ timeoutMs: 30_000, maxTransitions: 64 }),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value)) <= 256_000, 'Search request exceeds its byte limit');
export type ProofSearchRequest = z.infer<typeof proofSearchRequestSchema>;
const basisSchema = z.object({ scope: proofSearchScopeSchema, sourceDigest: digest, projectionDigest: digest, backendDigest: digest,
  target: z.object({ file: z.string(), theoremName: z.string(), type: z.string() }).strict(),
  environment: z.object({ environmentDigest: digest, toolIdentity: digest.optional() }).strict(),
  sourceFiles: z.array(z.object({ file: z.string(), digest }).strict()).max(4096),
}).strict();
export type ProofSearchBasis = z.infer<typeof basisSchema>;
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const viewSchema = z.object({ root: z.unknown().optional(), goals: z.array(z.unknown()).max(1024),
  rootHasSorry: z.boolean(), rootHasUnsafe: z.boolean(), rootHasMVar: z.boolean() }).passthrough();
const nodeSchema = z.object({ id: digest, tactics: z.array(tactic).max(128),
  status: z.enum(['pending', 'open', 'candidate', 'rejected']), view: viewSchema.optional(), error: z.string().max(4000).optional() }).strict();
export const proofSearchCheckpointSchema = z.object({
  schema: z.literal('theorem-os.proof-search-checkpoint.v1'), generation: natural, basis: basisSchema,
  assignmentKey: z.string().min(1).max(4096).optional(),
  nodes: z.array(nodeSchema).min(1).max(4096),
  actions: z.array(z.object({ sequence: natural, from: digest, to: digest, replay: z.boolean(),
    requestDigest: digest.optional(), branchIndex: natural.optional(), proposal: proposalSchema.optional(),
    status: z.enum(['issued', 'completed', 'rejected', 'interrupted']) }).strict()).max(16384),
  counters: z.object({ issued: natural, completed: natural, replay: natural, durationMs: natural }).strict(),
  replaySources: z.array(z.object({ file: z.string().min(1).max(4096), source: z.string() }).strict()).max(4096).optional(),
  lastRequest: z.object({ digest, branches: z.array(branchSchema).min(1).max(32), limits: limitsSchema }).strict().optional(),
}).strict();
export type ProofSearchCheckpoint = z.infer<typeof proofSearchCheckpointSchema>;
export const AesopPartialTactic = 'aesop (config := { terminal := false })';
const checkpointLimit = 4_000_000;
const nodeId = (basis: string, tactics: string[]) => mathDigest(canonicalMathJson([basis, tactics]));

function cleanCandidate(view: z.infer<typeof viewSchema>) {
  return view.goals.length === 0 && view.root != null && view.rootHasSorry === false &&
    view.rootHasUnsafe === false && view.rootHasMVar === false;
}
function rejectedView(view: z.infer<typeof viewSchema>) { return view.rootHasSorry || view.rootHasUnsafe; }
function proofSource(tactics: string[]) { return 'by\n' + tactics.map(text => text.split('\n').map(line => `  ${line}`).join('\n')).join('\n') + '\n'; }
export function emptyProofSearchCheckpoint(basis: ProofSearchBasis): ProofSearchCheckpoint {
  const basisDigest = mathDigest(canonicalMathJson(basis));
  return { schema: 'theorem-os.proof-search-checkpoint.v1', generation: 0, basis,
    nodes: [{ id: nodeId(basisDigest, []), tactics: [], status: 'pending' }], actions: [],
    counters: { issued: 0, completed: 0, replay: 0, durationMs: 0 } };
}
function validateCheckpoint(checkpoint: ProofSearchCheckpoint, basis: ProofSearchBasis) {
  if (canonicalMathJson(checkpoint.basis) !== canonicalMathJson(basis)) throw new Error('proof_search_stale_basis');
  const basisDigest = mathDigest(canonicalMathJson(basis)), nodes = new Map(checkpoint.nodes.map(node => [node.id, node]));
  if (nodes.size !== checkpoint.nodes.length || !nodes.has(nodeId(basisDigest, []))) throw new Error('proof_search_checkpoint_invalid');
  for (const node of nodes.values()) if (node.id !== nodeId(basisDigest, node.tactics) ||
      node.tactics.length && !nodes.has(nodeId(basisDigest, node.tactics.slice(0, -1)))) throw new Error('proof_search_checkpoint_invalid');
  if (checkpoint.counters.issued !== checkpoint.actions.length || checkpoint.counters.completed !== checkpoint.actions.filter(action =>
      action.status === 'completed' || action.status === 'rejected').length ||
      checkpoint.counters.replay !== checkpoint.actions.filter(action => action.replay).length ||
      checkpoint.actions.some((action, index) => action.sequence !== index + 1 || !nodes.has(action.from) || !nodes.has(action.to)))
    throw new Error('proof_search_checkpoint_invalid');
}

function readCheckpoint(project: string, reference: SearchCheckpointReference, history?: string) {
  const file = path.resolve(project, reference.path); assertMathCanonicalPath(file);
  const bytes = readMathFile(file, checkpointLimit).bytes;
  if (mathDigest(bytes) !== reference.digest) throw new Error('proof_search_stale_checkpoint_digest');
  const value = proofSearchCheckpointSchema.parse(JSON.parse(bytes.toString('utf8')));
  const basisDigest = mathDigest(canonicalMathJson(value.basis));
  if (file !== localProofSearchPath(project, basisDigest, value.generation, history) &&
      file !== projectedProofSearchPath(project, basisDigest, value.generation, reference.digest, history))
    throw new Error('proof_search_stale_checkpoint_path');
  validateCheckpoint(value, value.basis);
  return value;
}

/** Pure orchestration seam: tests supply a protocol fake. Whole states are replayed; printed goals are never identities. */
export async function advanceLeanProofSearch(input: {
  session: ProofSearchSession; checkpoint: ProofSearchCheckpoint; request: ProofSearchRequest;
  prefix: string; signal: AbortSignal; deadlineAt: number; save: (checkpoint: ProofSearchCheckpoint) => void;
}) {
  const { checkpoint, request, session } = input;
  validateCheckpoint(checkpoint, checkpoint.basis);
  const startedAt = Date.now(), basisDigest = mathDigest(canonicalMathJson(checkpoint.basis));
  const nodes = new Map(checkpoint.nodes.map(node => [node.id, node])), states = new Map<string, number>(), rejected = new Set<string>();
  const previouslyKnown = new Set(nodes.keys());
  const requestDigest = mathDigest(canonicalMathJson({ branches: request.branches, limits: request.limits }));
  checkpoint.lastRequest = { digest: requestDigest, branches: request.branches, limits: request.limits };
  for (const action of checkpoint.actions) if (action.status === 'issued') action.status = 'interrupted';
  let transitions = 0, lastSavedAt = startedAt;
  const save = () => { const now = Date.now(); checkpoint.counters.durationMs += now - lastSavedAt; lastSavedAt = now; input.save(checkpoint); };
  const guard = () => { input.signal.throwIfAborted(); if (Date.now() >= input.deadlineAt) throw new Error('proof_search_deadline'); };
  const candidates: { node: string; proofSource: string }[] = [];
  const record = (node: z.infer<typeof nodeSchema>, view: z.infer<typeof viewSchema>) => {
    node.view = view; delete node.error;
    node.status = rejectedView(view) ? 'rejected' : cleanCandidate(view) ? 'candidate' : 'open';
    if (node.status === 'rejected') rejected.add(node.id);
    if (node.status === 'candidate' && candidates.length < 8 && !candidates.some(item => item.node === node.id))
      candidates.push({ node: node.id, proofSource: proofSource(node.tactics) });
  };
  const paths = request.branches.map((branch, branchIndex) => {
    const from = branch.from ? nodes.get(branch.from) : nodes.get(nodeId(basisDigest, []));
    if (!from) throw new Error('proof_search_unknown_node');
    const tactics = [...from.tactics, ...branch.tactics];
    if (tactics.length > 128) throw new Error('proof_search_path_limit');
    return { tactics, branchIndex, proposal: branch.proposal, cursor: 0, done: false };
  });
  try {
    guard();
    await session.request('options.set', { printJsonPretty: false, automaticMode: true, noRepeat: false });
    const frontend = await session.request('frontend.process', { file: input.prefix, readHeader: true, inheritEnv: true, newConstants: false });
    if (!Array.isArray(frontend.units) || frontend.units.some((unit: { messages?: { severity?: string }[] }) => !Array.isArray(unit.messages)))
      throw new Error('proof_search_prefix_response_invalid');
    const errors = frontend.units.flatMap((unit: { messages: { severity?: string }[] }) =>
      unit.messages.filter(message => message.severity === 'error'));
    if (errors.length) throw new Error('proof_search_prefix_elaboration_failed: ' + limitMathOutput(JSON.stringify(errors), 1600, 'head'));
    guard();
    const initial = await session.request('goal.start', { expr: checkpoint.basis.target.type });
    if (!Number.isSafeInteger(initial.stateId) || Number(initial.stateId) < 0 || typeof initial.root !== 'string')
      throw new Error('proof_search_protocol_invalid_root');
    const root = nodes.get(nodeId(basisDigest, []))!;
    states.set(root.id, initial.stateId as number);
    record(root, viewSchema.parse(await session.request('goal.print', { stateId: initial.stateId, rootExpr: true, goals: true })));
    save();
    while (paths.some(branch => !branch.done) && transitions < request.limits.maxTransitions && !candidates.length) {
      for (const branch of paths) {
        guard();
        if (branch.done || transitions >= request.limits.maxTransitions || candidates.length) continue;
        // Already-executed prefixes share the same complete backend state, including coupled metavariables.
        while (branch.cursor < branch.tactics.length && states.has(nodeId(basisDigest, branch.tactics.slice(0, branch.cursor + 1)))) branch.cursor++;
        if (branch.cursor === branch.tactics.length) { branch.done = true; continue; }
        const parentId = nodeId(basisDigest, branch.tactics.slice(0, branch.cursor));
        const tactics = branch.tactics.slice(0, branch.cursor + 1), id = nodeId(basisDigest, tactics);
        if (rejected.has(parentId) || rejected.has(id)) { branch.done = true; continue; }
        const stateId = states.get(parentId); if (stateId === undefined) throw new Error('proof_search_missing_parent_state');
        let node = nodes.get(id);
        if (!node) { node = { id, tactics, status: 'pending' }; nodes.set(id, node); checkpoint.nodes.push(node); }
        const action: ProofSearchCheckpoint['actions'][number] = { sequence: checkpoint.actions.length + 1,
          from: parentId, to: id, replay: previouslyKnown.has(id), status: 'issued', requestDigest,
          branchIndex: branch.branchIndex, ...(branch.proposal ? { proposal: branch.proposal } : {}) };
        checkpoint.actions.push(action); checkpoint.counters.issued++; transitions++;
        if (action.replay) checkpoint.counters.replay++;
        save(); // Durable intent precedes the request; interruption does not refund a transition.
        const response = await session.request('goal.tactic', { stateId, tactic: tactics.at(-1)!, autoResume: true });
        if (Number.isSafeInteger(response.nextStateId) && Number(response.nextStateId) >= 0 &&
            response.hasSorry === false && response.hasUnsafe === false && !response.parseError) {
          const view = viewSchema.parse(await session.request('goal.print', { stateId: response.nextStateId, rootExpr: true, goals: true }));
          record(node, view);
          if (node.status !== 'rejected') states.set(id, response.nextStateId as number);
        } else {
          node.status = 'rejected'; delete node.view;
          node.error = limitMathOutput(JSON.stringify(response), 2000, 'head'); rejected.add(id);
        }
        action.status = node.status === 'rejected' ? 'rejected' : 'completed'; checkpoint.counters.completed++;
        branch.cursor++; if (node.status === 'rejected' || branch.cursor === branch.tactics.length) branch.done = true;
        save();
      }
    }
    guard();
    for (const branch of paths) if (states.has(nodeId(basisDigest, branch.tactics)) ||
      branch.tactics.some((_, index) => rejected.has(nodeId(basisDigest, branch.tactics.slice(0, index + 1))))) branch.done = true;
    return { status: candidates.length ? 'candidate' as const : paths.some(branch => !branch.done) ? 'budget-exhausted' as const : 'exhausted' as const,
      candidates, transitions };
  } finally { save(); }
}

export type LeanProofSearchStatus = 'candidate' | 'exhausted' | 'budget-exhausted' | 'stale' | 'unavailable' | 'unsupported' | 'busy' | 'cancelled';
export async function searchLeanBranches(input: {
  projectRoot: string; file: string; theoremName: string; type: string; scope: LeanProofSearchScope;
  request: unknown; env?: NodeJS.ProcessEnv; signal?: AbortSignal;
  /** Host-assigned history for a search performed as part of an independent check. */
  history?: string;
  /** An ordinary worker search may start at the current root if its implicit resume has a different basis. */
  restartStaleImplicitResume?: boolean;
  /** Only a host-scoped independent nextCheck may replay the explicitly retained source instead of live owned files. */
  retainedInput?: { basisDigest: string; checkpoint: SearchCheckpointReference; assignmentKey?: string };
  onCheckpoint?: (reference: SearchCheckpointReference) => void;
}) {
  const request = proofSearchRequestSchema.parse(input.request), scope = proofSearchScopeSchema.parse(input.scope);
  const history = digest.optional().parse(input.history);
  const startedAt = Date.now();
  const env = resolveMathematicsRuntimeEnvironment(input.env ?? process.env), project = fs.realpathSync(input.projectRoot);
  const controller = new AbortController(), abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) controller.abort();
  const deadlineAt = Date.now() + request.limits.timeoutMs;
  const cancelTimer = scheduleMathTimeout(() => controller.abort(), request.limits.timeoutMs);
  let projection: ReturnType<typeof prepareLeanSearchProjection> | undefined, session: ProofSearchSession | undefined;
  let reference: SearchCheckpointReference | undefined, checkpoint: ProofSearchCheckpoint | undefined;
  let retainedCheckpoint: ProofSearchCheckpoint | undefined;
  let status: LeanProofSearchStatus = 'unavailable', reason: string | undefined;
  let candidates: { node: string; proofSource: string }[] = [];
  try {
    controller.signal.throwIfAborted();
    const backend = readPantographBackend(env);
    if (!backend) throw new Error('proof_search_backend_not_configured');
    if (readMathFile(path.join(project, 'lean-toolchain'), 1000).bytes.toString('utf8').trim() !== backend.toolchain)
      throw new Error('proof_search_backend_toolchain_mismatch');
    if (input.retainedInput) {
      const retained = input.retainedInput.checkpoint;
      if (!input.retainedInput.assignmentKey && request.resume && request.resume.digest !== retained.digest)
        throw new Error('proof_search_stale_retained_checkpoint');
      const saved = readCheckpoint(project, retained, history);
      if (mathDigest(canonicalMathJson(saved.basis)) !== input.retainedInput.basisDigest ||
          canonicalMathJson(saved.basis.scope) !== canonicalMathJson(scope) ||
          canonicalMathJson(saved.basis.target) !== canonicalMathJson({ file: input.file, theoremName: input.theoremName, type: input.type }))
        throw new Error('proof_search_stale_retained_basis');
      if (!saved.replaySources?.length) throw new Error('proof_search_unsupported_missing_replay_sources');
      retainedCheckpoint = saved;
      projection = prepareRetainedLeanSearchProjection({ ...input, env,
        sources: saved.replaySources.map(item => ({ file: item.file!, source: item.source! })) });
    } else projection = prepareLeanSearchProjection({ ...input, env });
    const basis: ProofSearchBasis = { scope, sourceDigest: projection.sourceDigest, projectionDigest: projection.projectionDigest,
      backendDigest: backend.digest, target: { file: input.file, theoremName: input.theoremName, type: input.type },
      environment: projection.environment, sourceFiles: projection.sourceFiles };
    const basisDigest = mathDigest(canonicalMathJson(basis)), directory = proofSearchDirectory(project, basisDigest, history);
    assertMathCanonicalPath(directory); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    await withMathRuntimeLease({ lockPath: path.join(directory, 'writer.lock'), flockExecutable: '/usr/bin/flock' }, async () => {
      controller.signal.throwIfAborted();
      const names = fs.readdirSync(directory);
      const generations = names.filter(name => /^\d+\.json$/u.test(name)).map(name => Number(name.slice(0, -5)));
      const latestLocal = generations.length ? Math.max(...generations) : -1;
      const projected = names.flatMap(name => {
        const match = /^retained-(0|[1-9][0-9]*)-([a-f0-9]{64})\.json$/u.exec(name);
        return match ? [{ name, generation: Number(match[1]), digest: match[2]! }] : [];
      }).sort((a, b) => b.generation - a.generation)[0];
      const localReference = () => {
        const file = localProofSearchPath(project, basisDigest, latestLocal, history); assertMathCanonicalPath(file);
        return { path: path.relative(project, file), digest: mathDigest(readMathFile(file, checkpointLimit).bytes) };
      };
      const retained = input.retainedInput;
      // An independent history can outlive an assignment. Unpublished local files
      // from a prior dispatch reserve generations but cannot resume the current one.
      const local = retainedCheckpoint && retained?.assignmentKey && latestLocal > retainedCheckpoint.generation
        ? localReference() : undefined;
      const ownedLocal = local && readCheckpoint(project, local, history).assignmentKey === retained?.assignmentKey ? local : undefined;
      const resumableLocal = retained?.assignmentKey && !ownedLocal ? -1 : latestLocal;
      const latest = Math.max(resumableLocal, retainedCheckpoint?.generation ?? projected?.generation ?? -1);
      const requireLatestResume = () => {
        reference = resumableLocal === latest ? ownedLocal ?? localReference() : retained?.checkpoint ??
          { path: path.relative(project, path.join(directory, projected!.name)), digest: projected!.digest };
        checkpoint = readCheckpoint(project, reference, history);
        validateCheckpoint(checkpoint, basis);
        throw new Error('proof_search_stale_resume_required: use the returned latest checkpoint');
      };
      const resume = request.resume ?? (ownedLocal && resumableLocal === latest ? ownedLocal : retained?.checkpoint);
      if (resume) {
        const saved = readCheckpoint(project, resume, history);
        if (retainedCheckpoint && retained && resume.digest !== retained.checkpoint.digest &&
            (!retained.assignmentKey || saved.assignmentKey !== retained.assignmentKey || saved.generation <= retainedCheckpoint.generation ||
              path.resolve(project, resume.path) !== localProofSearchPath(project, basisDigest, saved.generation, history)))
          throw new Error('proof_search_stale_retained_checkpoint');
        checkpoint = saved;
        if (input.restartStaleImplicitResume && !input.retainedInput && !request.branches.some(branch => branch.from) &&
            canonicalMathJson(checkpoint.basis) !== canonicalMathJson(basis)) checkpoint = undefined;
        else {
          validateCheckpoint(checkpoint, basis);
          if (checkpoint.generation < latest) requireLatestResume();
        }
      }
      if (!checkpoint) {
        if (latest >= 0) requireLatestResume();
        checkpoint = emptyProofSearchCheckpoint(basis);
        const replaySources = projection!.replaySources;
        if (replaySources.reduce((size, item) => size + Buffer.byteLength(item.file) + Buffer.byteLength(item.source), 0) > 2_000_000)
          throw new Error('proof_search_unsupported_replay_source_size');
        checkpoint.replaySources = replaySources;
      }
      if (retained?.assignmentKey) checkpoint.assignmentKey = retained.assignmentKey;
      let generation = Math.max(latestLocal, projected?.generation ?? -1, checkpoint.generation);
      const save = (value: ProofSearchCheckpoint) => {
        value.generation = ++generation;
        proofSearchCheckpointSchema.parse(value);
        const text = canonicalMathJson(value);
        if (Buffer.byteLength(text) > checkpointLimit) throw new Error('proof_search_checkpoint_size_limit');
        const file = localProofSearchPath(project, basisDigest, value.generation, history); assertMathCanonicalPath(file);
        if (fs.existsSync(file)) throw new Error('proof_search_checkpoint_generation_conflict');
        writeMathTextDurable(file, text, 0o400);
        reference = { path: path.relative(project, file), digest: mathDigest(text) };
        input.onCheckpoint?.(reference);
      };
      save(checkpoint);
      let result: Awaited<ReturnType<typeof advanceLeanProofSearch>>;
      try {
        try {
          await projection!.compile(controller.signal, deadlineAt);
          session = await openPantographSession({ project: projection!.project, backend, env, signal: controller.signal, deadlineAt });
        } finally { checkpoint.counters.durationMs += Date.now() - startedAt; save(checkpoint); }
        result = await advanceLeanProofSearch({ session, checkpoint, request, prefix: projection!.prefix,
          signal: controller.signal, deadlineAt, save });
      } finally { await session?.close(); session = undefined; }
      projection!.verify(); backend.verify();
      status = result.status; candidates = result.candidates;
    });
  } catch (error) {
    reason = error instanceof Error ? limitMathOutput(error.message, 2000, 'head') : 'proof_search_failed';
    status = input.signal?.aborted ? 'cancelled' : controller.signal.aborted || Date.now() >= deadlineAt ? 'budget-exhausted' :
      reason.includes('lease_busy') ? 'busy' : /stale|changed/u.test(reason) ? 'stale' : reason.includes('unsupported') ? 'unsupported' : 'unavailable';
  } finally {
    try { await session?.close(); } finally { projection?.dispose(); cancelTimer(); input.signal?.removeEventListener('abort', abort); }
  }
  // Full fragments remain in scratch. The command response is a bounded preview even for long resumed paths.
  const candidateArtifacts = candidates.map(candidate => {
    const directory = proofSearchDirectory(project, mathDigest(canonicalMathJson(checkpoint!.basis)), history);
    const file = path.join(directory, `candidate-${candidate.node}.lean`); assertMathCanonicalPath(file);
    writeMathTextDurable(file, candidate.proofSource, 0o400);
    return { node: candidate.node, proofSource: limitMathOutput(candidate.proofSource, 4000, 'head'),
      truncated: Buffer.byteLength(candidate.proofSource) > 4000,
      artifact: { path: path.relative(project, file), digest: mathDigest(candidate.proofSource), bytes: Buffer.byteLength(candidate.proofSource) } };
  });
  const frontier = checkpoint?.nodes.filter(node => node.status === 'open').slice(-8).map(node => ({ node: node.id,
    preview: limitMathOutput(JSON.stringify(node.view ?? null), 1600, 'head'),
    truncated: Buffer.byteLength(JSON.stringify(node.view ?? null)) > 1600 }));
  return { authority: 'advisory-proof-search' as const, proofAcceptance: 'not-accepted' as const, status, reason,
    sourceBinding: input.retainedInput ? 'host-retained-source-snapshot' as const : 'current-worker-source' as const,
    basis: checkpoint && mathDigest(canonicalMathJson(checkpoint.basis)), checkpoint: reference,
    counters: checkpoint?.counters, frontier, frontierOmitted: Math.max(0, (checkpoint?.nodes.filter(node => node.status === 'open').length ?? 0) - 8),
    candidates: candidateArtifacts, next: 'Inspect the retained checkpoint; copy the complete candidate artifact into the owned declaration, then use the existing ready and independent verification workflow.' };
}
