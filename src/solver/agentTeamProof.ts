import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, mathDigest, readMathText, writeMathTextDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { leanDeclarationKeys } from '../math/leanSource';
import { bindLeanPackages } from '../math/leanDiagnostics';
import { applyTaskChanges, ownedSourceDigest, taskChanges, type DeclarationChange } from './cooperativeProof';
import { checkDeclarationArtifacts, declarationSubmissionSchema, validateDeclarationArtifact,
  type DeclarationArtifact, type DeclarationArtifactIdentity, type DeclarationSubmission } from './declarationArtifacts';
import { assertSolverSources, committedSource, commitSolverSources, git, solverProofImports, withSolverWorktree } from './problem';
import { locateKnowledgeDeclaration } from './theoremKnowledge';
import { solverSourceDigest } from './modules/evidence';
import { archiveAgentTeamCommits, importAgentTeamCommit } from './agentTeamWorkspace';

type Identity = { runId: string; problemReceiptDigest: string; environmentDigest: string };
export type AgentTeamProofProvenance = z.infer<typeof provenanceSchema>;
export type AgentTeamProofDelivery = Readonly<Identity & {
  schema: 'theorem-os.agent-team-proof-delivery.v1'; id: string; agentId: string; sourceWorktree: string;
  seedCommit: string; commit: string; sourceDigest: string;
  declarations: DeclarationSubmission['declarations']; artifacts: readonly DeclarationArtifact[];
  changes: readonly DeclarationChange[]; imports: readonly { file: string; module: string }[];
  provenance?: AgentTeamProofProvenance;
}>;
export type AgentTeamProofAdoption = Readonly<Identity & {
  schema: 'theorem-os.agent-team-proof-adoption.v1'; id: string; deliveryId: string;
  beforeCommit: string; commit: string; sourceDigest: string; artifacts: readonly DeclarationArtifact[];
}>;
type AgentTeamProofAdoptionIntent = Readonly<Identity & {
  schema: 'theorem-os.agent-team-proof-adoption-intent.v1'; id: string; worktree: string;
  adoption: AgentTeamProofAdoption;
}>;
type CheckInput = { state: DeclarationArtifactIdentity; env: NodeJS.ProcessEnv; signal: AbortSignal;
  timeoutMs?: number; assertWriterStopped: () => void; evidenceDirectory: string };
type IntegrationInput = CheckInput & { delivery: AgentTeamProofDelivery; worktree: string; expectedCommit: string };
const hash = z.string().regex(/^[a-f0-9]{64}$/u), commitHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const identitySchema = { runId: z.string().min(1), problemReceiptDigest: hash, environmentDigest: hash };
const provenanceSchema = z.object({ objectiveRevision: z.number().int().positive().optional(),
  taskId: z.string().min(1).optional(), workKind: z.enum(['research', 'proof', 'independent-reconstruction', 'review', 'assembly']).optional(),
  exposures: z.array(z.object({ deliveryId: hash, agentId: z.string().min(1), taskId: z.string().min(1),
    commit: commitHash, kind: z.enum(['inspected', 'adopted']), at: z.string().min(1) }).strict()).optional() }).strict();
// The host can combine prior checked peer inputs with a member's <=32-declaration submission.
// Individual declarations keep the public validation; only the internal collection is larger.
const teamDeclarations = z.array(declarationSubmissionSchema.shape.declarations.element).min(1);
const deliverySchema = z.object({ schema: z.literal('theorem-os.agent-team-proof-delivery.v1'), id: hash,
  ...identitySchema, agentId: z.string().trim().min(1).max(1000), sourceWorktree: z.string().min(1),
  seedCommit: commitHash, commit: commitHash, sourceDigest: hash,
  declarations: teamDeclarations, artifacts: z.array(z.unknown()).min(1),
  changes: z.array(z.object({ file: z.string(), name: z.string(), before: z.string().optional(), after: z.string(),
    beforeName: z.string().optional(), afterName: z.string().optional(), tail: z.string().optional() }).strict()),
  imports: z.array(z.object({ file: z.string(), module: z.string() }).strict()),
  provenance: provenanceSchema.optional(),
}).strict();
const adoptionSchema = z.object({ schema: z.literal('theorem-os.agent-team-proof-adoption.v1'), id: hash,
  ...identitySchema, deliveryId: hash, beforeCommit: commitHash, commit: commitHash, sourceDigest: hash,
  artifacts: z.array(z.unknown()).min(1),
}).strict();
const fail = (reason: string): never => { throw new Error(`math_agent_team_proof_${reason}`); };
const identityOf = (state: DeclarationArtifactIdentity): Identity => ({ runId: state.runId,
  problemReceiptDigest: state.problem.receiptDigest, environmentDigest: state.environmentDigest });
const recordId = ({ id: _id, ...record }: { id: string }) => mathDigest(canonicalMathJson(record));
const sameIdentity = (record: Identity, state: DeclarationArtifactIdentity) =>
  canonicalMathJson(identityOf(state)) === canonicalMathJson({ runId: record.runId,
    problemReceiptDigest: record.problemReceiptDigest, environmentDigest: record.environmentDigest });

function validateDelivery(value: unknown, state: DeclarationArtifactIdentity): AgentTeamProofDelivery {
  const parsed = deliverySchema.parse(value), artifacts = parsed.artifacts.map(validateDeclarationArtifact);
  const delivery = { ...parsed, artifacts } as AgentTeamProofDelivery;
  if (recordId(delivery) !== delivery.id || !sameIdentity(delivery, state)) return fail('delivery_identity_changed');
  if (artifacts.length !== delivery.declarations.length || artifacts.some((artifact, index) =>
    !sameIdentity(artifact, state) || artifact.proof.commit !== delivery.commit ||
    artifact.proof.sourceDigest !== delivery.sourceDigest ||
    canonicalMathJson(artifact.declaration) !== canonicalMathJson(delivery.declarations[index])))
    return fail('delivery_evidence_changed');
  return delivery;
}

/** Restored evidence is history; integration always checks the selected declarations again. */
export function readAgentTeamProofDelivery(file: string, state: DeclarationArtifactIdentity): AgentTeamProofDelivery {
  assertMathCanonicalPath(file);
  return validateDelivery(JSON.parse(readMathText(file)), state);
}

function evidenceFile(input: CheckInput, kind: 'deliveries' | 'adoptions' | 'adoption-intents', id: string,
  worktree: string): string {
  assertMathCanonicalPath(input.evidenceDirectory);
  if ([input.state.problem.workspace, worktree].some(root => isMathPathWithin(root, input.evidenceDirectory)))
    return fail('evidence_inside_source_workspace');
  const file = path.join(input.evidenceDirectory, kind, `${id}.json`); assertMathCanonicalPath(file);
  return file;
}

function persist(input: CheckInput, kind: 'deliveries' | 'adoptions' | 'adoption-intents',
  record: AgentTeamProofDelivery | AgentTeamProofAdoption | AgentTeamProofAdoptionIntent, worktree: string): void {
  const file = evidenceFile(input, kind, record.id, worktree), directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); assertMathCanonicalPath(file);
  const text = canonicalMathJson(record);
  if (fs.existsSync(file)) {
    if (readMathText(file) !== text) return fail('evidence_changed');
  } else writeMathTextDurable(file, text, 0o400);
}

const intentId = (input: IntegrationInput, delivery: AgentTeamProofDelivery) => mathDigest(canonicalMathJson({
  ...identityOf(input.state), worktree: input.worktree, deliveryId: delivery.id, beforeCommit: input.expectedCommit,
}));

function validateAdoption(value: unknown, state: DeclarationArtifactIdentity,
  delivery: AgentTeamProofDelivery): AgentTeamProofAdoption {
  const parsed = adoptionSchema.parse(value), artifacts = parsed.artifacts.map(validateDeclarationArtifact);
  const adoption = { ...parsed, artifacts } as AgentTeamProofAdoption;
  if (recordId(adoption) !== adoption.id || !sameIdentity(adoption, state) || adoption.deliveryId !== delivery.id)
    return fail('adoption_identity_changed');
  if (artifacts.length !== delivery.declarations.length || artifacts.some((artifact, index) =>
    !sameIdentity(artifact, state) || artifact.proof.commit !== adoption.commit ||
    artifact.proof.sourceDigest !== adoption.sourceDigest ||
    canonicalMathJson(artifact.declaration) !== canonicalMathJson(delivery.declarations[index])))
    return fail('adoption_evidence_changed');
  return adoption;
}

function readIntent(input: IntegrationInput, delivery: AgentTeamProofDelivery): AgentTeamProofAdoption | undefined {
  const id = intentId(input, delivery), file = evidenceFile(input, 'adoption-intents', id, input.worktree);
  if (!fs.existsSync(file)) return;
  const intent = z.object({ schema: z.literal('theorem-os.agent-team-proof-adoption-intent.v1'), id: hash,
    ...identitySchema, worktree: z.string(), adoption: z.unknown() }).strict().parse(JSON.parse(readMathText(file)));
  if (intent.id !== id || intent.worktree !== input.worktree || !sameIdentity(intent as Identity, input.state))
    return fail('adoption_intent_changed');
  const adoption = validateAdoption(intent.adoption, input.state, delivery);
  if (adoption.beforeCommit !== input.expectedCommit) return fail('adoption_intent_changed');
  return adoption;
}

function retainEvidence(input: CheckInput, worktree: string, artifacts: readonly DeclarationArtifact[], commit: string): void {
  const commits = [...new Set([commit, ...artifacts.map(artifact => artifact.proof.verification.targetCommit)])];
  // Validate the host evidence location before creating or moving source objects there.
  evidenceFile(input, 'deliveries', 'source-archive', worktree);
  archiveAgentTeamCommits(path.join(input.evidenceDirectory, 'sources.git'), worktree, commits);
  for (const id of commits) {
    commitHash.parse(id);
    git(worktree, ['update-ref', `refs/math/agent-team/evidence/${id}`, id]);
  }
}

function importEvidenceCommit(input: IntegrationInput, commit: string): void {
  try { git(input.worktree, ['cat-file', '-e', `${commit}^{commit}`]); return; }
  catch { /* An independent receiver may not have this checked source yet. */ }
  evidenceFile(input, 'deliveries', 'source-archive', input.worktree);
  const archive = path.join(input.evidenceDirectory, 'sources.git');
  let archived = false;
  if (fs.existsSync(archive)) {
    try { git(archive, ['cat-file', '-e', `${commit}^{commit}`]); archived = true; }
    catch { /* Legacy records can predate the host-owned archive. */ }
  }
  // Legacy shared-worktree evidence is retained in the frozen primary repository.
  // Never read a mutable/deleted member path supplied by a delivery record.
  if (!archived) archiveAgentTeamCommits(archive, input.state.problem.workspace, [commit]);
  importAgentTeamCommit(archive, input.worktree, commit);
}

/** Every changed declaration must be named and independently checked; metadata never widens source ownership. */
function deliveryPatch(state: DeclarationArtifactIdentity, worktree: string, seedCommit: string, commit: string,
  declarations: DeclarationSubmission['declarations']) {
  const { problem } = state;
  if (declarations.some(declaration => !problem.ownedFiles.includes(declaration.file)))
    return fail('declaration_outside_ownership');
  git(worktree, ['merge-base', '--is-ancestor', seedCommit, commit]);
  if (problem.ownedFiles.some(file => !file.endsWith('.lean') &&
      committedSource(worktree, seedCommit, `${problem.projectRelative}/${file}`) !==
      committedSource(worktree, commit, `${problem.projectRelative}/${file}`))) return fail('undeclared_source_change');
  const changes = taskChanges(problem, worktree, commit, undefined, { seedCommit });
  const declared = new Set(declarations.map(declaration => {
    const source = committedSource(worktree, commit, `${problem.projectRelative}/${declaration.file}`);
    let location: ReturnType<typeof locateKnowledgeDeclaration>;
    try { location = locateKnowledgeDeclaration(source, declaration.name); }
    catch (error) {
      if (error instanceof Error && error.message === 'math_knowledge_declaration_missing_or_ambiguous')
        return fail('declaration_missing');
      throw error;
    }
    const name = leanDeclarationKeys(source).get(location.startOffset);
    if (!name) return fail('declaration_missing');
    return `${declaration.file}\0${name}`;
  }));
  if (declared.size !== declarations.length || changes.some(change => !declared.has(`${change.file}\0${change.name}`)))
    return fail('undeclared_source_change');
  const imports = problem.ownedFiles.filter(file => file.endsWith('.lean')).flatMap(file => {
    const before = solverProofImports(problem, committedSource(worktree, seedCommit, `${problem.projectRelative}/${file}`));
    const after = solverProofImports(problem, committedSource(worktree, commit, `${problem.projectRelative}/${file}`));
    if (before.some(module => !after.includes(module))) return fail('import_removed');
    return after.filter(module => !before.includes(module)).map(module => ({ file, module }));
  });
  return { changes, imports };
}

function frozenSource(input: CheckInput, worktree: string, commit: string): () => void {
  const identity = canonicalMathJson(identityOf(input.state));
  return () => {
    input.signal.throwIfAborted(); input.assertWriterStopped(); assertSolverSources(input.state.problem, worktree);
    if (canonicalMathJson(identityOf(input.state)) !== identity) return fail('run_identity_changed');
    if (git(worktree, ['rev-parse', 'HEAD']) !== commit || git(worktree, ['status', '--porcelain', '--',
      ...input.state.problem.ownedFiles.map(file => path.join(input.state.problem.projectRelative, file))]))
      return fail('source_changed');
  };
}

/** Delta/duplicate checks cover the whole delivery; each batch still receives fresh ordinary declaration checks. */
async function checkTeamDeclarationArtifacts(input: Parameters<typeof checkDeclarationArtifacts>[0]) {
  const artifacts: DeclarationArtifact[] = [];
  for (let offset = 0; offset < input.declarations.length; offset += 32) {
    artifacts.push(...await checkDeclarationArtifacts({ ...input,
      declarations: input.declarations.slice(offset, offset + 32) }));
  }
  return artifacts;
}

/** Called only after the child writer has stopped. No mutable child files become proof evidence. */
export async function checkAgentTeamProofDelivery(input: CheckInput & {
  agentId: string; worktree: string; seedCommit: string; declarations: DeclarationSubmission['declarations'];
  provenance?: AgentTeamProofProvenance;
}): Promise<AgentTeamProofDelivery> {
  const declarations = teamDeclarations.parse(input.declarations);
  const agentId = deliverySchema.shape.agentId.parse(input.agentId);
  commitHash.parse(input.seedCommit); assertMathCanonicalPath(input.worktree);
  input.signal.throwIfAborted(); input.assertWriterStopped();
  const { problem } = input.state;
  if (input.worktree === problem.workspace) return fail('worktree_not_isolated');
  const commit = commitSolverSources(problem, input.worktree), stable = frozenSource(input, input.worktree, commit);
  stable();
  const patch = deliveryPatch(input.state, input.worktree, input.seedCommit, commit, declarations);
  const artifacts = await checkTeamDeclarationArtifacts({ ...input, commit, declarations, assertWriterStopped: stable });
  stable();
  const record: AgentTeamProofDelivery = { schema: 'theorem-os.agent-team-proof-delivery.v1', id: '',
    ...identityOf(input.state), agentId, sourceWorktree: input.worktree, seedCommit: input.seedCommit, commit,
    sourceDigest: ownedSourceDigest(problem, input.worktree, commit), declarations, artifacts, ...patch,
    ...(input.provenance === undefined ? {} : { provenance: provenanceSchema.parse(input.provenance) }) };
  const delivery = { ...record, id: recordId(record) };
  validateDelivery(delivery, input.state);
  retainEvidence(input, input.worktree, artifacts, commit);
  persist(input, 'deliveries', delivery, input.worktree); stable();
  return delivery;
}

async function finishAdoption(input: IntegrationInput, adoption: AgentTeamProofAdoption): Promise<AgentTeamProofAdoption> {
  const stable = frozenSource(input, input.worktree, adoption.commit); stable();
  if (!sameIdentity(adoption, input.state)) return fail('adoption_identity_changed');
  if (ownedSourceDigest(input.state.problem, input.worktree, adoption.commit) !== adoption.sourceDigest)
    return fail('adoption_source_changed');
  persist(input, 'adoptions', adoption, input.worktree);
  stable();
  return adoption;
}

/** A persisted intent may finish only its exact stopped-writer transition, never an unrelated or later HEAD. */
async function resumeAdoption(input: IntegrationInput, delivery: AgentTeamProofDelivery,
  adoption: AgentTeamProofAdoption): Promise<AgentTeamProofAdoption> {
  const { problem } = input.state, head = git(input.worktree, ['rev-parse', 'HEAD']);
  if (head !== adoption.beforeCommit && head !== adoption.commit) return fail('source_changed');
  const stable = frozenSource(input, input.worktree, head); stable();
  const parents = git(input.worktree, ['rev-list', '--parents', '-n', '1', adoption.commit]).split(' ');
  if (adoption.commit !== adoption.beforeCommit &&
      (parents.length !== 2 || parents[1] !== adoption.beforeCommit)) return fail('adoption_source_changed');
  const owned = new Set(problem.ownedFiles.map(file => path.join(problem.projectRelative, file)));
  if (git(input.worktree, ['diff', '--name-only', adoption.beforeCommit, adoption.commit]).split('\n')
    .filter(Boolean).some(file => !owned.has(file))) return fail('adoption_source_changed');
  // Reconstruct the authorized patch as well as verifying hashes: a different committed tree cannot become a recovered success.
  await withSolverWorktree(input.worktree, adoption.beforeCommit, async checkout => {
    assertSolverSources(problem, checkout);
    applyTaskChanges(problem, checkout, delivery.changes, [...delivery.imports]);
    if (solverSourceDigest(problem, checkout) !== adoption.sourceDigest) return fail('adoption_source_changed');
  });
  await withSolverWorktree(input.worktree, adoption.commit, async checkout => {
    assertSolverSources(problem, checkout);
    if (ownedSourceDigest(problem, checkout, adoption.commit) !== adoption.sourceDigest) return fail('adoption_source_changed');
    if (head !== adoption.commit) {
      // A crash before FF has not adopted anything. Check the saved candidate anew before continuing that transition.
      const packages = path.join(input.worktree, problem.projectRelative, '.lake', 'packages');
      if (fs.existsSync(packages)) bindLeanPackages(path.join(checkout, problem.projectRelative), packages);
      const checkoutStable = frozenSource(input, checkout, adoption.commit);
      await checkTeamDeclarationArtifacts({ ...input, worktree: checkout, commit: adoption.commit,
        declarations: delivery.declarations, assertWriterStopped: () => { stable(); checkoutStable(); } });
      stable(); checkoutStable();
    }
  });
  stable();
  if (head !== adoption.commit) git(input.worktree, ['merge', '--ff-only', '--no-edit', adoption.commit]);
  return finishAdoption(input, adoption);
}

/** Stage and recheck off-line, persist the checked intent, then FF. Retrying the same expectedCommit is idempotent. */
export async function integrateAgentTeamProofDelivery(input: IntegrationInput): Promise<AgentTeamProofAdoption> {
  const delivery = validateDelivery(input.delivery, input.state), { problem } = input.state;
  commitHash.parse(input.expectedCommit); assertMathCanonicalPath(input.worktree);
  input.signal.throwIfAborted(); input.assertWriterStopped();
  const pending = readIntent(input, delivery);
  const stable = frozenSource(input, input.worktree, input.expectedCommit);
  if (!pending) stable();
  // New deliveries are independent of the mutable member directory. Legacy evidence
  // already in the target repository remains readable without a new source lookup.
  importEvidenceCommit(input, delivery.commit);
  if (pending) importEvidenceCommit(input, pending.commit);
  return withSolverWorktree(input.worktree, delivery.commit, async frozen => {
    assertSolverSources(problem, frozen);
    if (ownedSourceDigest(problem, frozen, delivery.commit) !== delivery.sourceDigest) return fail('delivery_source_changed');
    const patch = deliveryPatch(input.state, frozen, delivery.seedCommit, delivery.commit, delivery.declarations);
    if (canonicalMathJson(patch) !== canonicalMathJson({ changes: delivery.changes, imports: delivery.imports }))
      return fail('delivery_patch_changed');
    if (pending) return resumeAdoption(input, delivery, pending);
    return withSolverWorktree(input.worktree, input.expectedCommit, async checkout => {
      const packages = path.join(input.worktree, problem.projectRelative, '.lake', 'packages');
      if (fs.existsSync(packages)) bindLeanPackages(path.join(checkout, problem.projectRelative), packages);
      applyTaskChanges(problem, checkout, patch.changes, patch.imports);
      const commit = commitSolverSources(problem, checkout), checkoutStable = frozenSource(input, checkout, commit);
      const assertStopped = () => { stable(); checkoutStable(); };
      const artifacts = await checkTeamDeclarationArtifacts({ ...input, worktree: checkout, commit,
        declarations: delivery.declarations, assertWriterStopped: assertStopped });
      assertStopped();
      const record: AgentTeamProofAdoption = { schema: 'theorem-os.agent-team-proof-adoption.v1', id: '',
        ...identityOf(input.state), deliveryId: delivery.id, beforeCommit: input.expectedCommit, commit,
        sourceDigest: ownedSourceDigest(problem, checkout, commit), artifacts };
      const adoption = { ...record, id: recordId(record) };
      retainEvidence(input, input.worktree, artifacts, commit);
      persist(input, 'adoption-intents', { schema: 'theorem-os.agent-team-proof-adoption-intent.v1',
        id: intentId(input, delivery), ...identityOf(input.state), worktree: input.worktree, adoption }, input.worktree);
      // This is checked adoption evidence, not whole-problem acceptance. Journals stay with the primary.
      assertStopped();
      git(input.worktree, ['merge', '--ff-only', '--no-edit', commit]);
      return finishAdoption(input, adoption);
    });
  });
}
