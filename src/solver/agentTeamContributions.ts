import path from 'node:path';
import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { leanDeclarationKeys } from '../math/leanSource';
import type { SolverRunState } from './archive';
import { deliveredDeclarationChange, teamDeclarationForwarding } from './agentTeamForwarding';
import { committedSource, git } from './problem';
import { locateKnowledgeDeclaration } from './theoremKnowledge';
import type { ProofCheck } from './modules/evidence';

const target = z.object({ file: z.string(), name: z.string(), receiptId: z.string().optional(),
  relation: z.enum(['direct', 'indirect', 'referenced', 'target-proof', 'not-referenced', 'unknown']),
  reason: z.string().optional() });
const row = z.object({ deliveryId: z.string(), agentId: z.string(), taskId: z.string(), file: z.string(), name: z.string(),
  objectiveRevision: z.number().int().positive().optional(), kind: z.literal('definition').optional(),
  sourceCommit: z.string(), declarationDigest: z.string().optional(), adoptionIds: z.array(z.string()),
  forwardedFrom: z.array(z.string()), targets: z.array(target) });
export const teamContributionsSchema = z.object({ schema: z.literal('theorem-os.team-contributions.v1'),
  runId: z.string(), evidence: z.literal('recorded-source-and-kernel-references'), finalCommit: z.string().optional(),
  adoptions: z.array(z.object({ id: z.string(), deliveryId: z.string(), targetId: z.string(), status: z.string(),
    commit: z.string().optional() })),
  declarations: z.array(row), unavailableDeliveries: z.array(z.string()), advisoryMessages: z.array(z.object({
    id: z.string(), from: z.string(), to: z.string(), status: z.string(), text: z.string().optional(), encoding: z.string(),
  })) });
type Report = z.infer<typeof teamContributionsSchema>;
type Row = Report['declarations'][number];
type Target = Row['targets'][number];

/** The relation is about the exact delivered source version, not historical authorship. */
export function buildAgentTeamContributions(state: SolverRunState, evaluation: Record<string, unknown>): Report {
  const team = state.agentTeam!;
  const final = evaluation.verification as ProofCheck | undefined;
  const commit = evaluation.status === 'passed' && final?.passed && final.commit === state.check?.commit &&
    final.sourceDigest === state.check?.sourceDigest && final.verification?.status === 'kernel_verified' &&
    final.verification.targetCommit === final.commit ? final.commit : undefined;
  const rows: Row[] = [], unavailableDeliveries: string[] = [];
  const actorPath = (actor: string) => actor === 'lead' ? '/root' : team.workers.find(w => w.id === actor)?.native?.agentPath;
  const hostNotices = new Set(team.events.map(e => JSON.stringify([actorPath(e.from), actorPath(e.to),
    'Mathematical host update (advisory):\n' + canonicalMathJson(e)])));
  const result: Report = { schema: 'theorem-os.team-contributions.v1', runId: state.runId,
    evidence: 'recorded-source-and-kernel-references', finalCommit: commit, declarations: rows, unavailableDeliveries,
    adoptions: team.adoptions.map(({ id, deliveryId, targetId, status, commit: adopted }) => ({ id, deliveryId, targetId, status, commit: adopted })),
    advisoryMessages: (team.nativeControl?.mailbox ?? []).flatMap(mail =>
      !team.workers.some(w => w.native?.agentPath === mail.author) || !mail.message ||
        hostNotices.has(JSON.stringify([mail.author, mail.recipient, mail.message.text])) ? [] :
      [{ id: mail.id, from: mail.author, to: mail.recipient, status: mail.status, encoding: String(mail.message.kind),
        ...(typeof mail.message.text === 'string' ? { text: mail.message.text } : {}) }]) };
  const sources = new Map<string, string>(), worktree = state.problem.workspace;
  function version(at: string, file: string, qualified: string) {
    const key = at + '\0' + file;
    const source = sources.get(key) ?? committedSource(worktree, at, path.posix.join(state.problem.projectRelative, file));
    sources.set(key, source);
    try {
      const loc = locateKnowledgeDeclaration(source, qualified);
      if (loc.qualifiedName !== qualified.replace(/^_root_\./u, '')) return;
      const body = source.slice(source.lastIndexOf('\n', loc.startOffset - 1) + 1, loc.endOffset).trimEnd() + '\n';
      return { digest: mathDigest(body), key: leanDeclarationKeys(source).get(loc.startOffset) };
    } catch (err) {
      if (err instanceof Error && err.message === 'math_knowledge_declaration_missing_or_ambiguous') return;
      throw err;
    }
  }
  const unresolved = new Map<Row, string>();
  const transfers = teamDeclarationForwarding(state, path.join(path.dirname(state.worktree), 'agent-team/proofs'));
  for (const ref of team.deliveries) {
    try {
      const delivery = transfers.read(ref.id);
      for (const decl of delivery.declarations) {
        const item: Row = { deliveryId: ref.id, agentId: ref.agentId, taskId: ref.taskId, sourceCommit: delivery.commit,
          ...(delivery.provenance?.objectiveRevision && { objectiveRevision: delivery.provenance.objectiveRevision }),
          ...(decl.kind && { kind: decl.kind }),
          file: decl.file, name: decl.name.replace(/^_root_\./u, ''), adoptionIds: [], forwardedFrom: [], targets: [] };
        rows.push(item);
        // Unadopted child commits need not be present in Lead's repository. Match the checked patch later
        // at the final version, using its exact qualified file/name and the patch's scoped key and bytes.
        const change = deliveredDeclarationChange(delivery, decl.file, item.name);
        if (!change) { unresolved.set(item, 'no-unique-changed-declaration'); continue; }
        item.forwardedFrom = transfers.origins(delivery, decl.file, item.name).map(o => o.deliveryId);
        item.declarationDigest = mathDigest(change.after);
        if (!commit) { unresolved.set(item, 'no-accepted-final-receipt'); continue; }
        try {
          const v = version(commit, decl.file, item.name);
          if (!v || v.digest !== item.declarationDigest || v.key !== change.name) unresolved.set(item, 'final-source-version-differs');
        } catch { unresolved.set(item, 'source-unavailable'); }
      }
    } catch { unavailableDeliveries.push(ref.id); }
  }
  for (const item of rows) {
    const destinations = new Set([item.deliveryId]);
    for (const id of destinations) for (const r of rows) if (r.file === item.file && r.name === item.name &&
      r.declarationDigest === item.declarationDigest && r.forwardedFrom.includes(id)) destinations.add(r.deliveryId);
    const adoptions = team.adoptions.filter(a => a.status === 'completed' && a.targetId === 'lead' && destinations.has(a.deliveryId));
    for (const a of adoptions) {
      if (!a.commit || !a.expectedCommit || !commit || !item.declarationDigest || a.commit === a.expectedCommit) continue;
      try {
        git(worktree, ['merge-base', '--is-ancestor', a.commit, commit]);
        if (version(a.commit, item.file, item.name)?.digest === item.declarationDigest &&
            version(a.expectedCommit, item.file, item.name)?.digest !== item.declarationDigest)
          item.adoptionIds.push(a.id);
      } catch { /* Missing archive data is not proof of transfer. */ }
    }
    for (const t of state.problem.targets) {
      const obs: Target = { file: t.proofPath, name: t.theoremName, relation: 'unknown' };
      item.targets.push(obs);
      const receipt = commit && final?.verification.results.find(r => r.status === 'kernel_verified' && r.targetCommit === commit &&
        r.proofPath === t.proofPath && r.theoremName === t.theoremName && r.sourceDeclarationHash === t.declarationHash);
      if (receipt) obs.receiptId = receipt.receiptId;
      if ((obs.reason = unresolved.get(item) ?? (!item.adoptionIds.length ? 'no-observed-transfer-to-lead' :
        !receipt ? 'no-matching-final-receipt' : undefined))) continue;
      if (!receipt) continue;
      const same = (r: { file: string; name: string }) => r.file === item.file && r.name === item.name;
      if (!item.kind && item.file === t.proofPath && item.name === t.theoremName) obs.relation = 'target-proof';
      else if (!receipt.declarationReferences) obs.reason = 'proof-references-unavailable';
      else if (!receipt.declarationReferences.proof.some(same)) obs.relation = 'not-referenced';
      else obs.relation = !receipt.directProofReferences ? 'referenced' : receipt.directProofReferences.some(same) ? 'direct' : 'indirect';
    }
  }
  return result;
}
