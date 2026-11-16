import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathGitBytes, mathGitText } from '../math/mathGit';
import { canonicalMathJson, mathDigest, readMathText, syncMathDirectory, writeMathFrozen } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import type { SolverRunState } from './archive';

export type AgentTeamResearchState = Pick<SolverRunState, 'runId' | 'environmentDigest'> & {
  problem: Pick<SolverRunState['problem'], 'receiptDigest'>;
};
export type AgentTeamResearchArtifactReference = Readonly<{
  id: string; agentId: string; taskId: string; commit: string; path: string;
}>;
export type AgentTeamResearchArtifactStatus = 'completed' | 'interrupted' | 'failed' | 'cancelled' | 'paused';
type Identity = { runId: string; environmentDigest: string; problemReceiptDigest: string };
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commitHash = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u);
const agentId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u);
const taskId = z.string().min(1);
const identitySchema = z.object({ runId: z.string().min(1), environmentDigest: hash, problemReceiptDigest: hash }).strict();
const referenceSchema = z.object({ id: hash, agentId, taskId, commit: commitHash, path: z.string().min(1) }).strict();
const notesSchema = z.object({ file: z.literal('RESEARCH.md'), sha256: hash,
  bytes: z.number().int().nonnegative(), text: z.string() }).strict();
const artifactSchema = z.object({ schema: z.literal('theorem-os.agent-team-research-artifact.v1'), id: hash,
  ...identitySchema.shape, agentId, taskId, commit: commitHash, summary: z.string(),
  status: z.enum(['completed', 'interrupted', 'failed', 'cancelled', 'paused']), advisory: z.literal(true),
  originalProblemAcceptance: z.literal('not-assessed'), notes: notesSchema.nullable() }).strict();
// These schemas require every field, including when Zod inference runs without strictNullChecks.
type Notes = Required<z.infer<typeof notesSchema>>;
type Artifact = Required<Omit<z.infer<typeof artifactSchema>, 'notes'>> & { notes: Notes | null };
export type AgentTeamResearchInspection = Readonly<Pick<Artifact,
  'id' | 'agentId' | 'taskId' | 'commit' | 'summary' | 'status' | 'advisory' | 'originalProblemAcceptance'> & {
  notes: (Notes & { offset: number; nextOffset?: number; truncated: boolean; totalCharacters: number }) | null;
}>;
const fail = (reason: string): never => { throw new Error(`math_agent_team_research_${reason}`); };
const identityOf = (state: AgentTeamResearchState): Identity => {
  const identity = { runId: state.runId, environmentDigest: state.environmentDigest,
    problemReceiptDigest: state.problem.receiptDigest };
  identitySchema.parse(identity); return identity;
};
const recordId = ({ id: _id, ...record }: { id: string }) => mathDigest(canonicalMathJson(record));
const referenceOf = (record: Artifact, file: string): AgentTeamResearchArtifactReference => ({ id: record.id,
  agentId: record.agentId, taskId: record.taskId, commit: record.commit, path: file });

function validateArtifact(value: unknown, state: AgentTeamResearchState): Artifact {
  const parsed = artifactSchema.safeParse(value);
  if (!parsed.success) return fail('artifact_invalid');
  const artifact = parsed.data as Artifact;
  if (canonicalMathJson(identityOf(state)) !== canonicalMathJson({ runId: artifact.runId,
    environmentDigest: artifact.environmentDigest, problemReceiptDigest: artifact.problemReceiptDigest }))
    return fail('identity_changed');
  if (recordId(artifact) !== artifact.id || artifact.notes &&
    (mathDigest(artifact.notes.text) !== artifact.notes.sha256 || Buffer.byteLength(artifact.notes.text, 'utf8') !== artifact.notes.bytes))
    return fail('artifact_changed');
  return artifact;
}

/** Read only the root note blob in this exact commit; uncommitted notes never enter a delivery. */
function committedNotes(worktree: string, commit: string): Artifact['notes'] {
  const options = { maxBuffer: Infinity, errorMessage: 'math_agent_team_research_source_unavailable' };
  if (mathGitText(worktree, ['cat-file', '-t', commit], options) !== 'commit') return fail('commit_invalid');
  const entry = mathGitText(worktree, ['ls-tree', '--full-tree', '-z', commit, '--', 'RESEARCH.md'], options);
  if (!entry) return null;
  const match = /^(100644|100755) blob ([a-f0-9]{40}|[a-f0-9]{64})\tRESEARCH\.md\0$/u.exec(entry);
  if (!match) return fail('notes_not_regular_file');
  const bytes = mathGitBytes(worktree, ['cat-file', 'blob', match[2]], options);
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return fail('notes_invalid_utf8'); }
  return { file: 'RESEARCH.md', sha256: mathDigest(bytes), bytes: bytes.length, text };
}

/** Host evidence is complete and immutable; it carries no Lean acceptance or declaration receipt. */
export function saveAgentTeamResearchArtifact(input: {
  directory: string; state: AgentTeamResearchState; agentId: string; taskId: string; worktree: string;
  commit: string; summary: string; status: AgentTeamResearchArtifactStatus;
}): AgentTeamResearchArtifactReference {
  commitHash.parse(input.commit); agentId.parse(input.agentId); taskId.parse(input.taskId);
  assertMathCanonicalPath(input.directory); assertMathCanonicalPath(input.worktree);
  if (isMathPathWithin(input.worktree, input.directory)) return fail('evidence_inside_source_workspace');
  const record = { schema: 'theorem-os.agent-team-research-artifact.v1' as const, id: '', ...identityOf(input.state),
    agentId: input.agentId, taskId: input.taskId, commit: input.commit, summary: input.summary, status: input.status,
    advisory: true as const, originalProblemAcceptance: 'not-assessed' as const,
    notes: committedNotes(input.worktree, input.commit) };
  const artifact = validateArtifact({ ...record, id: recordId(record) }, input.state);
  fs.mkdirSync(input.directory, { recursive: true, mode: 0o700 });
  const file = path.join(input.directory, `${artifact.id}.json`); assertMathCanonicalPath(file);
  const text = canonicalMathJson(artifact);
  if (fs.existsSync(file)) {
    if (readMathText(file) !== text) return fail('artifact_changed');
  } else {
    writeMathFrozen(file, text); syncMathDirectory(input.directory);
  }
  return referenceOf(artifact, file);
}

/** Offsets and limits count Unicode code points so a page never splits a surrogate pair. */
export function inspectAgentTeamResearchArtifact(input: {
  reference: AgentTeamResearchArtifactReference; state: AgentTeamResearchState; offset?: number; limit?: number;
}): AgentTeamResearchInspection {
  const reference = referenceSchema.parse(input.reference);
  const offset = z.number().int().nonnegative().parse(input.offset ?? 0);
  const limit = Math.min(z.number().int().positive().parse(input.limit ?? 16000), 16000);
  assertMathCanonicalPath(reference.path);
  if (path.basename(reference.path) !== `${reference.id}.json`) return fail('reference_changed');
  const artifact = validateArtifact(JSON.parse(readMathText(reference.path)), input.state);
  if (canonicalMathJson(referenceOf(artifact, reference.path)) !== canonicalMathJson(reference)) return fail('reference_changed');
  const { id, agentId, taskId, commit, summary, status, advisory, originalProblemAcceptance } = artifact;
  const result = { id, agentId, taskId, commit, summary, status, advisory, originalProblemAcceptance };
  if (!artifact.notes) return { ...result, notes: null };
  const characters = Array.from(artifact.notes.text), nextOffset = Math.min(offset + limit, characters.length);
  const truncated = nextOffset < characters.length;
  return { ...result, notes: { ...artifact.notes, text: characters.slice(offset, nextOffset).join(''), offset,
    ...(truncated ? { nextOffset } : {}), truncated, totalCharacters: characters.length } };
}
