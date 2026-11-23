import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { nativeAssignmentEvidence, teamEvidenceRefSchema } from '../../src/solver/agentTeamEvidenceRef';
import { agentTeamOverview } from '../../src/solver/agentTeamViews';
import { teamDeclarationForwarding } from '../../src/solver/agentTeamForwarding';
import { readRecordedAgentTeamAdoption, type AgentTeamProofAdoption, type AgentTeamProofDelivery } from '../../src/solver/agentTeamProof';
import { inspectAgentTeamResearchArtifact } from '../../src/solver/agentTeamResearch';
import type { AgentTeamTask } from '../../src/solver/agentTeamState';
import type { SolverRunState } from '../../src/solver/archive';
import type { buildRunInspection } from '../../src/solver/inspection';
import type { WebNativeTeam, WebNativeTeamTask, WebTeamDelivery, WebTeamFinding, WebTeamProof } from './collaboration';

const preview = (value?: string) => value && value.slice(0, 1_200);

/** Workbench view of existing host records. All reads come from this run's evidence archive. */
export function projectWebNativeTeam(state: SolverRunState, runDirectory: string,
  inspection: NonNullable<ReturnType<typeof buildRunInspection>['agentTeam']>,
  committed: (archive: string, commit: string) => { files: Record<string, string>; digest: string },
): WebNativeTeam | undefined {
  const team = state.agentTeam;
  if (team?.transport !== 'native-agent-control') return;
  const root = path.join(path.dirname(state.worktree), 'agent-team');
  const contained = root !== runDirectory && isMathPathWithin(runDirectory, root);
  const proofs = path.join(root, 'proofs'), archive = path.join(proofs, 'sources.git');
  const forwarding = teamDeclarationForwarding(state, proofs);
  const overview = agentTeamOverview(state, { workerLimit: 8, budget: inspection.budget });
  const byMember = new Map(team.workers.map(worker => [worker.id, worker]));
  const byTask = new Map(team.workers.flatMap(worker => worker.tasks.map(task => [task.id, { task, worker }] as const)));
  const mail = team.nativeControl?.mailbox ?? [];
  const findings = new Map<string, WebTeamFinding>();
  const deliveries = new Map<string, AgentTeamProofDelivery | null>();
  const actor = (agentPath: string) => agentPath === '/root' ? 'lead' :
    team.workers.find(worker => worker.native?.agentPath === agentPath)?.id;

  function delivery(id: string) {
    if (!deliveries.has(id)) {
      let record: AgentTeamProofDelivery | null = null;
      if (contained) try { record = forwarding.read(id); } catch { /* The stored reference did not resolve. */ }
      deliveries.set(id, record);
    }
    return deliveries.get(id) ?? undefined;
  }

  function finding(ref: string): WebTeamFinding | undefined {
    if (findings.has(ref)) return findings.get(ref);
    if (!teamEvidenceRefSchema.safeParse(ref).success) return;
    const [kind, id] = ref.split(':') as [string, string];
    let item: WebTeamFinding | undefined;
    if (kind === 'message') {
      const entry = mail.find(entry => entry.id === id && entry.sentAt !== undefined);
      const task = entry?.originTaskId ? byTask.get(entry.originTaskId) : undefined;
      const to = entry && actor(entry.recipient);
      if (entry?.message && task && to && task.worker.id === actor(entry.author)) {
        item = { ref, from: task.worker.id, to, taskId: task.task.id, at: entry.sentAt, status: entry.status,
          ...(typeof entry.message.text === 'string' && { text: preview(entry.message.text) }) };
      }
    } else if (kind === 'research') {
      const record = team.researchArtifacts?.find(record => record.id === id);
      const task = record && byTask.get(record.taskId);
      if (contained && record?.path === path.join(root, 'research', id + '.json') &&
          record.agentId && record.taskId && record.commit && task?.worker.id === record.agentId) {
        try {
          const saved = inspectAgentTeamResearchArtifact({ reference: { id, path: record.path,
            agentId: record.agentId, taskId: record.taskId, commit: record.commit }, state, limit: 1_200 });
          item = { ref, from: saved.agentId, taskId: saved.taskId, status: 'recorded',
            at: team.events.find(event => event.researchArtifactId === id)?.at ?? task.task.finishedAt ?? task.task.pausedAt,
            text: preview(saved.notes?.text || saved.summary) };
        } catch { /* An invalid or missing record cannot supply evidence. */ }
      }
    } else {
      const record = delivery(id);
      const reference = team.deliveries.find(reference => reference.id === id);
      if (record && reference) item = { ref, from: record.agentId, taskId: reference.taskId, status: 'recorded',
        at: team.events.find(event => event.kind === 'delivery' && event.deliveryId === id)?.at,
        text: preview(record.declarations.map(declaration => declaration.name).join(', ')) };
    }
    if (item) findings.set(ref, item);
    return item;
  }

  function reassignment(task: AgentTeamTask): WebNativeTeamTask['reassignment'] {
    if (task.startedAt === undefined || task.status === 'queued') return;
    const history = task.objectiveHistory ?? [];
    const revisions = [...history.map(item => ({ revision: item.revision, message: item.message })),
      { revision: task.objectiveRevision ?? 1, message: task.message }];
    for (let i = revisions.length - 1; i >= 0; i--) {
      const revision = revisions[i]!, previous = revisions[i - 1];
      if (revision.revision > 1 && !previous) continue;
      const { reference, objective } = nativeAssignmentEvidence(revision.message);
      if (!reference || !objective || previous && objective === nativeAssignmentEvidence(previous.message).objective) continue;
      const entry = finding(reference), dispatchAt = history[i - 1]?.at ?? task.startedAt;
      if (entry && entry.at !== undefined && entry.at <= dispatchAt && entry.taskId !== task.id && (!entry.to || entry.to === 'lead'))
        return { ref: entry.ref, revision: revision.revision };
    }
  }

  let sourceBytes = 0;
  function retainSource(source?: string) {
    if (source === undefined) return;
    const bytes = Buffer.byteLength(source);
    if (bytes > 128 * 1024 || sourceBytes + bytes > 768 * 1024) return;
    sourceBytes += bytes;
    return source;
  }
  function frozenSources(commit: string, digest: string, names: readonly string[]) {
    const sources: WebTeamProof['sources'] = [];
    if (!contained) return sources;
    try {
      assertMathCanonicalPath(archive);
      const snapshot = committed(archive, commit);
      if (snapshot.digest !== digest) return sources;
      for (const file of new Set(names)) {
        if (!Object.hasOwn(snapshot.files, file)) continue;
        const source = retainSource(snapshot.files[file]);
        if (source !== undefined) sources.push({ file, source });
      }
    } catch { /* Historical records can outlive the source archive. */ }
    return sources;
  }

  function proof(record: AgentTeamProofDelivery | AgentTeamProofAdoption): WebTeamProof {
    const artifacts = record.artifacts.slice(0, 24);
    const sources = frozenSources(record.commit, record.sourceDigest, artifacts.map(item => item.declaration.file));
    const declarations = artifacts.map(artifact => {
      const { file, name, type } = artifact.declaration, { targetCommit, results } = artifact.proof.verification;
      let checkedSource: string | undefined;
      if (contained && record.commit !== targetCommit) try {
        assertMathCanonicalPath(archive);
        const source = committed(archive, targetCommit).files[file];
        if (source !== undefined && mathDigest(source) === results[0]?.proofHash) checkedSource = retainSource(source);
      } catch { /* The checked projection may not be available in a historical archive. */ }
      return { file, name, type: preview(type), checkedCommit: targetCommit, checkedSource,
        receipts: results.map(receipt => ({ id: receipt.receiptId, status: receipt.status })) };
    });
    return { commit: record.commit, sourceDigest: record.sourceDigest, environmentDigest: record.environmentDigest,
      declarations, sources };
  }

  const published: WebTeamDelivery[] = team.deliveries.slice(-16).map(ref => {
    const record = delivery(ref.id);
    const references = (inspection.contributions?.declarations ?? [])
      .filter(item => item.deliveryId === ref.id && item.sourceCommit === record?.commit)
      .flatMap(item => item.targets.flatMap(({ name, relation }) =>
        relation === 'unknown' || relation === 'not-referenced' ? [] : [{ file: item.file, name: item.name, target: name, relation }])).slice(0, 24);
    finding('delivery:' + ref.id);
    return { id: ref.id, taskId: ref.taskId, memberId: ref.agentId, ...(record && { proof: proof(record) }), references };
  });
  const adoptions = team.adoptions.filter(item => published.some(delivery => delivery.id === item.deliveryId)).slice(-24).map(item => {
    const { id, targetId, status, deliveryId, commit } = item, record = delivery(deliveryId);
    const worktree = targetId === 'lead' ? state.worktree : byMember.get(targetId)?.worktree;
    let receipt: AgentTeamProofAdoption | undefined;
    if (contained && status === 'completed' && commit && item.expectedCommit && worktree && record &&
        isMathPathWithin(runDirectory, worktree)) {
      try {
        receipt = readRecordedAgentTeamAdoption({ state, evidenceDirectory: proofs, worktree,
          expectedCommit: item.expectedCommit, commit, receiptId: item.receiptId }, record);
      } catch { /* The adoption journal alone does not supply the formal receipt. */ }
    }
    return { id, targetId, status, deliveryId, commit, error: preview(item.error),
      ...(receipt && { receiptId: receipt.id, proof: proof(receipt) }) };
  });

  const tasks = overview.workers.flatMap(member => member.tasks.flatMap(view => {
    const record = byTask.get(view.id);
    if (!record) return [];
    const { task, worker } = record, pending = worker.pendingDelivery?.taskId === task.id;
    const researchRef = view.researchArtifactId && 'research:' + view.researchArtifactId;
    if (researchRef) finding(researchRef);
    const check = task.failedCheck;
    const rejection = check && check.environmentDigest === state.environmentDigest && check.problemReceiptDigest === state.problem.receiptDigest
      ? { commit: check.commit, sourceDigest: check.sourceDigest, environmentDigest: check.environmentDigest, sources: [],
          declarations: [{ file: check.declaration.file, name: check.declaration.name, checkedCommit: check.projectionCommit,
            receipts: check.results.slice(0, 4).map(result => ({ id: result.receiptId, status: result.status,
              diagnostic: preview([result.error, result.stdoutPreview, result.stderrPreview].filter(Boolean).join('\n')) })) }] } : undefined;
    const status: WebNativeTeamTask['status'] = pending ? member.activity === 'checking' ? 'checking' : 'stopping'
      : task.deliveryId ? 'delivered' : task.status === 'failed' && (rejection || task.nomination) ? 'rejected'
        : task.status === 'running' && (member.activity === 'stopping' || task.declarations || task.pauseRequested) ? 'stopping'
          : task.status === 'queued' && member.activity === 'preparing' ? 'preparing' : task.status;
    return [{ id: task.id, memberId: member.id, objective: view.objective ?? '', revision: view.objectiveRevision,
      profiles: view.profileEvidence?.selected.slice(0, 12) ?? [], status, finding: preview(view.progress?.at(-1)?.summary ?? view.summary),
      researchRef, deliveryId: task.deliveryId, rejection, reason: preview(view.error ?? view.pauseRequested?.reason),
      reassignment: reassignment(task) }];
  }));
  for (const reference of (team.researchArtifacts ?? []).slice(-16)) finding('research:' + reference.id);
  for (const entry of mail.filter(entry => entry.originTaskId).slice(-24)) finding('message:' + entry.id);
  return { schema: 'theorem-os.web-native-team.v1', runId: state.runId, maxAgents: inspection.maxAgents,
    memberCount: overview.totals.workers, taskCount: overview.totals.tasks, taskOmissions: overview.totals.tasks - tasks.length,
    tasks, findings: [...findings.values()], deliveries: published, adoptions };
}
