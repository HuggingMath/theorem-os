import { parseCooperationPlan, isAdvisoryTask as advisory } from './tasks';
import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { commitSolverSources, committedSource, git, solverProofImports, withSolverWorktree } from './problem';
import { originalGoalTaskFocus, routeAllowsTask, taskCanStart, plannedTaskDependencyIds } from './modules/search';
import { readMathResponse as block, parseMathResponse, isPlanFence as planFence, MAX_RESEARCH_NOTES_BYTES } from './deliveries';
import { applyTaskChanges, ownedSourceDigest, taskChanges } from './cooperativeProof';
import { statementSnapshot } from './statementReview';
import { proofReferencesUnchanged } from './proofReferences';
import { captureObligationSnapshot } from './obligationProgress';
import { taskConnectionCheckCurrent } from './taskConnections';
import { taskGroup, taskVersion, taskProofContractVersion, taskReferenceDependencies, invalidatedTaskIds, type TaskRecord,
  type CooperativeAction } from './tasks';
import { digest, HumanEditRecord, InitialPlanPublication, RETRY_DISPATCH, DispatchResult, bounded, deliveryInputFields, readCooperationPlan,
  type LeadPlan } from './cooperationShared';
import { formatPlanJson, type PlanPatchBase } from './planPatch';
import { collapseTaskFamilies } from './taskFamilies';
import { dropLeadWakes } from './leadWakes';
import { CooperationIntegration } from './cooperationIntegration';
import { researchRouteGroups, researchWorkerCanNode } from './modules/organization';
import { currentCapacityExploration } from './capacityExploration';

/** Lead plan acceptance, plan identity and the idle original-goal frontier. */
export abstract class CooperationPlanning extends CooperationIntegration {
  protected syncPlanNotes() {
    if (!this.archive.planEdited) return;
    const file = path.join(this.lead.worktree, 'RESEARCH.md');
    const source = fs.existsSync(file) ? readMathText(file, MAX_RESEARCH_NOTES_BYTES) : '';
    const plan = '```math\n' + formatPlanJson({ tasks: collapseTaskFamilies(this.plannedTasks().map(node => node.task)), groups: this.archive.groups?.map(route => route.group),
      ...(this.archive.proofRoutes?.length ? { proofRoutes: this.archive.proofRoutes } : {}) }) + '\n```';
    // Replace the first plan fence and drop the rest, so an applied revision cannot be read again.
    let replaced = false;
    const synced = source.replace(/```([a-z-]+)\s*\n([\s\S]*?)\n```/gu, (fence, label: string, body: string) => {
      if (!planFence(label, body)) return fence;
      if (replaced) return '';
      replaced = true; return plan;
    });
    fs.writeFileSync(file, replaced ? synced : plan + '\n' + bounded(source, 8000));
    this.archive.planEdited = false;
  }
  /** The accepted Lead graph that a plan revision is written against; family members are rederived on parse. */
  protected planPatchBase(): PlanPatchBase | undefined {
    const tasks = collapseTaskFamilies(this.plannedTasks().map(node => node.task));
    return tasks.length ? { version: this.archive.planVersion ?? this.planVersion(), tasks,
      groups: this.archive.groups?.map(route => route.group) ?? [], proofRoutes: this.archive.proofRoutes } : undefined;
  }
  /** A dispatch's own live publication already applied its revision; the final notes may repeat it against the dispatch base. */
  protected readLeadPlan(action?: CooperativeAction): LeadPlan {
    const base = this.planPatchBase();
    const rebased = Boolean(action?.kind === 'lead' && this.current(action) && this.publishedPlans.has(action) &&
      action.planVersion && action.planVersion !== base?.version);
    // A rebased repeat of an applied publication already answered the review it was written against.
    return readCooperationPlan(this.input.state.problem, this.lead.worktree, base, {
      acceptedBaseVersions: [...(base ? [base.version] : []), ...(rebased ? [(action as { planVersion: string }).planVersion] : [])],
      rebased, ...(rebased ? {} : { goalPath: this.goalPathReview() }) });
  }
  protected planningInputDigest(omitLeadDrafts = false) {
    const versions = new Map(this.archive.tasks.map(node => [node.task.id, digest(node.task)]));
    const deliveries = [...new Set((this.archive.deliveries ?? []).filter(record => record.status !== 'superseded' &&
      !(omitLeadDrafts && record.producer === this.lead.id && record.kind === 'progress' &&
        record.summary.startsWith('Saved Lead draft pending integration:')) &&
      (!record.taskId || versions.get(record.taskId) === record.taskDigest))
      .map(record => canonicalMathJson(deliveryInputFields(record))))].sort();
    return mathDigest(canonicalMathJson({ problemReceiptDigest: this.input.state.problem.receiptDigest,
      environmentDigest: this.input.state.environmentDigest, planVersion: this.archive.planVersion,
      sourceDigest: ownedSourceDigest(this.input.state.problem, this.lead.worktree, this.archive.canonicalCommit!),
      liveWorkers: this.input.workers.filter(worker => this.liveWorkers.has(worker.id)).map(({ id, role }) => ({ id, role })),
      progress: captureObligationSnapshot(this.archive.tasks, { groups: this.archive.groups,
        environmentDigest: this.input.state.environmentDigest, proofRoutes: this.archive.proofRoutes, blockers: this.archive.blockers }).digest,
      tasks: this.plannedTasks().map(node => ({ id: node.task.id, status: node.status, feedback: node.feedback })),
      deliveries }));
  }
  protected planningEvidenceDigest() {
    // Plan invalidation can supersede old deliveries, so compare their immutable content.
    return mathDigest(canonicalMathJson({ problemReceiptDigest: this.input.state.problem.receiptDigest,
      environmentDigest: this.input.state.environmentDigest,
      liveWorkers: this.input.workers.filter(worker => this.liveWorkers.has(worker.id)).map(({ id, role }) => ({ id, role })),
      sourceDigest: ownedSourceDigest(this.input.state.problem, this.lead.worktree, this.archive.canonicalCommit!),
      deliveries: (this.archive.deliveries ?? []).filter(record => record.producer !== this.lead.id)
        .map(({ status: _status, evidence: _evidence, ...record }) => record) }));
  }
  /** Ignore the draft-preservation bookkeeping produced by pausing this same turn. */
  protected leadPauseInputDigest(commit?: string) {
    const problem = this.input.state.problem;
    const sourceDigest = commit ? ownedSourceDigest(problem, this.lead.worktree, commit) :
      mathDigest(canonicalMathJson(problem.ownedFiles.map(file => [file,
        mathDigest(fs.readFileSync(path.join(this.lead.worktree, problem.projectRelative, file)))])));
    const notes = commit ? (git(this.lead.worktree, ['ls-tree', '--name-only', commit, '--', 'RESEARCH.md'])
      ? committedSource(this.lead.worktree, commit, 'RESEARCH.md') : '') :
      (fs.existsSync(path.join(this.lead.worktree, 'RESEARCH.md'))
        ? readMathText(path.join(this.lead.worktree, 'RESEARCH.md'), MAX_RESEARCH_NOTES_BYTES) : '');
    return mathDigest(canonicalMathJson({ inputDigest: this.planningInputDigest(true), planVersion: this.planVersion(),
      sourceDigest, notesDigest: mathDigest(notes) }));
  }
  /** A completed decision covers its own bookkeeping, but never evidence arriving during that dispatch. */
  protected rememberLeadDecision(action: CooperativeAction) {
    if (action.kind === 'lead' && action.planningInputDigest) {
      this.archive.lastLeadInputDigest = this.leadEvidence.get(action) === this.planningEvidenceDigest()
        ? this.planningInputDigest() : action.planningInputDigest;
      this.archive.lastLeadPauseInputDigest = undefined;
    }
  }
  protected activeGoalFrontier() {
    const focus = originalGoalTaskFocus(this.archive.tasks, this.archive.groups, this.input.state.environmentDigest, { includeParkedTasks: true });
    return [...focus.frontier].map(taskId => {
      const node = this.node(taskId);
      return { taskId, status: node.status, attempts: node.attempts, goalIds: [...focus.frontierGoals.get(taskId)!], parkedBy: node.routeParking ?? [] };
    });
  }
  protected resumeUnattemptedFrontier(frontier: ReturnType<CooperationPlanning['activeGoalFrontier']>) {
    const candidates = new Set(frontier.map(item => this.node(item.taskId)));
    const seen = new Set<string>();
    const visit = (node: TaskRecord) => {
      if (seen.has(node.task.id) || !routeAllowsTask(node.task, this.archive.tasks, this.archive.groups) ||
          ['integrated', 'completed'].includes(node.status)) return;
      seen.add(node.task.id);
      if (node.status === 'blocked') candidates.add(node);
      for (const id of plannedTaskDependencyIds(node, this.archive.tasks)) {
        const dependency = this.archive.tasks.find(item => item.task.id === id);
        if (dependency) visit(dependency);
      }
    };
    // An explicitly pending supporting task can have unfinished prerequisites outside the original-goal cone.
    for (const node of this.archive.tasks) if (node.status === 'pending') visit(node);
    const resumed = [...candidates].filter(node => node.status === 'blocked' && node.attempts === 0 &&
      !node.assignment && !node.proof && !node.integratedCheck &&
      node.typePreflight?.status !== 'invalid' &&
      !node.feedback?.startsWith('math_task_repeated_failed_input\n') &&
      !this.archive.blockers?.some(blocker => blocker.taskId === node.task.id && blocker.status === 'parked') &&
      routeAllowsTask(node.task, this.archive.tasks, this.archive.groups) && taskCanStart(node.task, this.archive.tasks, this.archive.groups) &&
      this.livePeers.some(worker => this.input.modules.M5.assign([node], worker, this.livePeers, this.archive.groups, this.archive.tasks, this.stoppedWorkers) === node));
    if (!resumed.length) return false;
    // A planning assessment is not an execution attempt at an imported unresolved obligation.
    for (const node of resumed) this.moveTask(node, 'pending', 'reopened');
    this.input.emit('unattempted_frontier_resumed', { taskIds: resumed.map(node => node.task.id),
      goalIds: [...new Set(frontier.flatMap(item => item.goalIds))] });
    this.changed();
    return true;
  }
  protected proposedPlanDigest(source?: string) {
    try {
      const { tasks, groups, proofRoutes, upsert, remove, baseVersion } = source === undefined
        ? block(this.lead.worktree, 'math-plan') : parseMathResponse(source, 'math-plan');
      const revision = upsert !== undefined || remove !== undefined;
      return mathDigest(canonicalMathJson({ tasks, groups, proofRoutes, ...(revision ? { upsert, remove, baseVersion } : {}) }));
    } catch {
      if (source !== undefined) return mathDigest(source);
      // A notes-only commit must not make an identical malformed response new input.
      const file = path.join(this.lead.worktree, 'RESEARCH.md');
      return fs.existsSync(file) ? git(this.lead.worktree, ['hash-object', '--', file]) : 'missing';
    }
  }
  protected rejectPlan(error: unknown) {
    const reason = error instanceof Error ? error.message : 'math_plan_invalid';
    const proposalDigest = this.proposedPlanDigest(), inputDigest = this.planningInputDigest();
    const previous = this.archive.planRejection;
    const stalled = previous?.proposalDigest === proposalDigest && previous.inputDigest === inputDigest && previous.error === reason;
    this.archive.error = reason;
    this.archive.planRejection = { proposalDigest, inputDigest, error: reason, stalled };
    // A repeated rejection of the same proposal for the same input answers its wake-ups; it is not new input.
    if (stalled) dropLeadWakes(this.archive.leadWakes!); else this.wakeLead('plan-rejected');
    this.input.emit('plan_rejected', { ...this.archive.planRejection });
  }
  protected async mergeLeadSources(commit: string, seedCommit: string, canonical = this.archive.canonicalCommit!) {
    const problem = this.input.state.problem;
    git(this.lead.worktree, ['merge-base', '--is-ancestor', seedCommit, commit]);
    const changes = taskChanges(problem, this.lead.worktree, commit, undefined, { seedCommit });
    const imports = problem.ownedFiles.filter(file => file.endsWith('.lean')).flatMap(file => {
      const before = solverProofImports(problem, committedSource(this.lead.worktree, seedCommit, `${problem.projectRelative}/${file}`));
      return solverProofImports(problem, committedSource(this.lead.worktree, commit, `${problem.projectRelative}/${file}`))
        .filter(module => !before.includes(module)).map(module => ({ file, module }));
    });
    return withSolverWorktree(this.lead.worktree, canonical, async checkout => {
      applyTaskChanges(problem, checkout, changes, imports);
      const merged = commitSolverSources(problem, checkout);
      this.pin(merged);
      return merged;
    });
  }
  protected preserveLeadDraft(commit: string, seedCommit: string | undefined, reason: string, requestDecision = true) {
    const summary = `Saved Lead draft pending integration: ${reason}. ` +
      `Inspect git show ${commit}:PROJECT_RELATIVE_PATH and reapply the useful declarations against the current canonical sources. ` +
      'This draft has no proof acceptance.';
    if (!this.archive.deliveries?.some(record => record.producer === this.lead.id && record.kind === 'progress' &&
        record.commit === commit && record.summary.startsWith('Saved Lead draft pending integration:'))) {
      this.record(this.lead, undefined, 'progress', 'advisory', summary, { commit });
    }
    if (requestDecision) { this.archive.error = reason; this.wakeLead('lead-draft-preserved'); }
    this.input.emit('lead_draft_preserved', { commit, seedCommit, canonicalCommit: this.archive.canonicalCommit, reason });
  }
  protected async restoreLeadSources() {
    const problem = this.input.state.problem;
    const seed = this.archive.leadSeedCommit;
    const draft = commitSolverSources(problem, this.lead.worktree);
    this.pin(draft);
    if (ownedSourceDigest(problem, this.lead.worktree, draft) !==
        ownedSourceDigest(problem, this.lead.worktree, this.archive.canonicalCommit!)) {
      try {
        if (!seed) throw new Error('math_lead_recovery_seed_unknown');
        this.archive.canonicalCommit = await this.mergeLeadSources(draft, seed);
        this.input.emit('lead_draft_restored', { commit: draft, seedCommit: seed, canonicalCommit: this.archive.canonicalCommit });
      } catch (error) {
        this.input.signal.throwIfAborted();
        this.preserveLeadDraft(draft, seed, error instanceof Error ? error.message : 'math_lead_recovery_failed');
      }
    }
    this.archive.canonicalCommit = this.seed(this.lead, this.archive.canonicalCommit!);
  }
  protected planInvalidation({ tasks, groups, proofRoutes }: ReturnType<typeof parseCooperationPlan>, proofContracts = false) {
    const previousGroups = new Map(this.archive.groups?.map(record => [record.group.id, record]));
    const changedGroups = new Set(groups.filter(group => {
      const previous = previousGroups.get(group.id)?.group;
      return previous && (previous.objective !== group.objective || previous.revision !== group.revision);
    }).map(group => group.id));
    const dependencies = new Map(this.archive.tasks.map(node => {
      const references = taskReferenceDependencies(node);
      return [node.task.id, references && proofReferencesUnchanged(this.input.state.problem, this.lead.worktree,
        this.archive.canonicalCommit!, node.integratedCheck!.references!, this.input.state.environmentDigest)
        ? references.map(reference => reference.taskId)
        : [...node.task.dependsOn, ...(node.alternativeRoutes?.flatMap(route => [...route.prerequisiteTaskIds, route.closingTaskId]) ?? []),
          ...(node.assignment?.dependencies?.map(dependency => dependency.taskId) ?? [])]];
    }));
    const proposed = tasks.map(task => ({ task, status: 'pending' as const, attempts: 0,
      alternativeRoutes: proofRoutes?.filter(route => route.targetTaskId === task.id) }));
    const routeChanges = new Set(this.archive.tasks.filter(node => node.status !== 'integrated' &&
      (canonicalMathJson(node.alternativeRoutes ?? []) !== canonicalMathJson(proofRoutes?.filter(route => route.targetTaskId === node.task.id) ?? []) ||
        node.assignment?.connectionCheck && !taskConnectionCheckCurrent(node.task, node.assignment, proposed)))
      .map(node => node.task.id));
    const invalidated = invalidatedTaskIds(this.archive.tasks, tasks, changedGroups, dependencies, routeChanges,
      proofContracts ? taskProofContractVersion : taskVersion);
    const view = this.capacityPlanView({ tasks, groups, proofRoutes });
    for (const node of this.archive.tasks) if (node.capacityExploration &&
        tasks.some(task => task.id === node.task.id && digest(task) === digest(node.task)) &&
        currentCapacityExploration(node, view, this.explorationIdentity)) invalidated.delete(node.task.id);
    return invalidated;
  }
  protected async acceptPlan(planInput?: LeadPlan, edit?: HumanEditRecord,
    publication?: { action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>;
      receipt: Omit<InitialPlanPublication, 'planVersion'> },
    leadAction?: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>) {
    const plan = planInput ?? this.readLeadPlan(leadAction);
    this.includeCapacityExplorations(plan);
    const { tasks, groups, proofRoutes } = plan;
    const publicationResponseDigest = publication ? this.proposedPlanDigest(
      git(this.lead.worktree, ['ls-tree', '--name-only', publication.action.seedCommit, '--', 'RESEARCH.md'])
        ? committedSource(this.lead.worktree, publication.action.seedCommit, 'RESEARCH.md') : '') : undefined;
    for (const task of tasks) if (task.ownerId) {
      const owner = this.input.workers.find(worker => worker.id === task.ownerId);
      const previous = this.archive.tasks.find(node => node.task.id === task.id);
      const ownershipTask = previous?.capacityExploration ? { ...task, status: 'active' as const } : task;
      if (!owner || !researchWorkerCanNode(owner, { ...(previous ?? { status: 'pending', attempts: 0 }), task: ownershipTask }))
        throw new Error('math_plan_task_owner_unavailable');
    }
    const previousGroups = new Map(this.archive.groups?.map(record => [record.group.id, record]));
    const configuredGroups = researchRouteGroups(groups, this.input.workers).map(group => {
      if (group.engineerId && !this.input.workers.some(worker => worker.id === group.engineerId && worker.role === 'engineer'))
        throw new Error('math_plan_group_engineer_unavailable');
      return { ...group };
    });
    const current = new Map(this.archive.tasks.map(node => [node.task.id, node]));
    const invalidated = this.planInvalidation(plan);
    const proofChanges = this.planInvalidation(plan, true);
    const revalidate = new Set([...invalidated].filter(id => !proofChanges.has(id) && current.get(id)?.status === 'integrated'));
    this.input.signal.throwIfAborted();
    for (const id of invalidated) if (this.archive.unchangedResearch) delete this.archive.unchangedResearch[id];
    for (const id of invalidated) if (this.archive.researchCheckpoints) delete this.archive.researchCheckpoints[id];
    for (const previousEdit of this.archive.edits ?? []) for (const result of previousEdit.recheck?.tasks ?? [])
      if (invalidated.has(result.taskId) && result.status !== 'removed') result.status = 'superseded';
    for (const record of this.archive.deliveries ?? []) if (record.taskId && invalidated.has(record.taskId)) record.status = 'superseded';
    for (const id of invalidated) {
      const previous = current.get(id);
      if (previous) (this.archive.history ??= []).push(
        { task: previous.task, producer: previous.assignment?.workerId, proof: previous.proof, integratedCheck: previous.integratedCheck,
          finding: previous.finding, researchCompletion: previous.researchCompletion });
    }
    this.archive.tasks = tasks.map(task => {
      const previous = current.get(task.id);
      if (previous && (!invalidated.has(task.id) || revalidate.has(task.id))) {
        previous.task = task;
        const owner = task.ownerId ?? (task.kind === 'goal' ? configuredGroups.find(group => group.id === taskGroup(task))?.engineerId : undefined);
        if (owner && previous.assignment && previous.assignment.workerId !== owner && ['pending', 'running'].includes(previous.status)) {
          this.moveTask(previous, 'pending', 'reassigned'); previous.assignment = undefined;
        }
        return previous;
      }
      return { task, status: 'pending', attempts: previous?.attempts ?? 0 };
    });
    this.archive.groups = configuredGroups.map(group => ({ group, turns: previousGroups.get(group.id)?.turns ?? 0 }));
    this.archive.proofRoutes = proofRoutes;
    this.syncProofRoutes();
    if (invalidated.size) { this.archive.review = undefined; this.lastAssembly = undefined; }
    for (const [id, active] of this.active) {
      if (active.action.kind === 'review' && !this.archive.review && !active.cancelled) { active.cancelled = true; void active.interrupt().catch(() => {}); }
      if (active.action.kind !== 'task') continue;
      const action = active.action;
      const node = this.archive.tasks.find(item => item.task.id === action.task.id);
      const group = configuredGroups.find(route => route.id === (node && taskGroup(node.task)));
      if (!node || invalidated.has(action.task.id) || (node.task.status ?? 'active') !== 'active' || group?.status !== 'active' ||
          (node.task.ownerId && node.task.ownerId !== id) ||
          (node.task.kind === 'goal' && group.engineerId && group.engineerId !== id)) {
        if (node && !invalidated.has(node.task.id) && node.status === 'running') {
          this.moveTask(node, 'pending', 'interrupted');
          if ((node.task.ownerId && node.task.ownerId !== id) || (node.task.kind === 'goal' && group?.engineerId && group.engineerId !== id)) node.assignment = undefined;
        }
        if (!active.cancelled) { active.cancelled = true; void active.interrupt().catch(() => {}); }
      }
    }
    this.archive.error = undefined;
    this.archive.planRejection = undefined;
    if (edit) {
      edit.status = 'applied'; edit.appliedAt = Date.now(); edit.pendingSync = true;
      edit.affectedTasks = [...new Set([...invalidated, ...tasks.filter(task => !current.has(task.id)).map(task => task.id)])];
      edit.recheck = { status: 'pending', tasks: edit.affectedTasks.filter(id => {
        const task = this.node(id)?.task ?? current.get(id)?.task;
        return task && !advisory(task);
      }).map(id => ({ taskId: id, taskDigest: digest((this.node(id) ?? current.get(id)!).task),
        status: this.node(id) ? 'pending' : 'removed' })) };
      this.archive.planEdited = true;
    }
    this.archive.planVersion = this.planVersion();
    const decidingAction = publication?.action ?? leadAction;
    if (plan.goalPathDecisions && decidingAction) this.recordGoalPathDecisions(decidingAction, plan.goalPathDecisions);
    // A revision is not a graph: the next dispatch's notes show the complete accepted result.
    if (plan.fromPatch) this.archive.planEdited = true;
    // Replaying unchanged saved notes during restore does not correct a rejected live event.
    if (edit || publication || leadAction || this.archive.planPublicationRejection?.baseVersion !== this.archive.planVersion)
      this.archive.planPublicationRejection = undefined;
    if (publication) {
      // Publish the graph, receipt and dispatch continuation together before waking any peer.
      this.archive.planPublication = { ...publication.receipt, planVersion: this.archive.planVersion };
      if (publication.action.kind === 'lead' && publication.action.initialPlanNonce)
        this.archive.initialPlanPublication = this.archive.planPublication;
      this.publishedPlans.set(publication.action, { plan, version: this.archive.planVersion,
        responseDigest: publicationResponseDigest! });
    }
    // Preserve a Lead's own initial publication, but reclaim turns superseded by a newer plan.
    for (const active of this.active.values()) if (active.action.kind === 'lead' && !this.current(active.action) && !active.cancelled) {
      active.cancelled = true; void active.interrupt().catch(() => {});
    }
    // Restored reviews include elaboration; compare them only after rebuilding that context.
    const missingStatementContext = (node: TaskRecord) => !this.statementContexts.has(statementSnapshot(
      this.input.state.problem, node.task, this.lead.worktree, this.archive.canonicalCommit!, this.input.state.environmentDigest,
      this.dependencies(node.task).map(dependency => ({ task: dependency.task, taskDigest: digest(dependency.task) }))).snapshotDigest);
    const synchronize = this.archive.tasks.filter(node => revalidate.has(node.task.id) || node.task.statementReview &&
      (invalidated.has(node.task.id) || !current.has(node.task.id) || !this.archive.statementReviews?.some(review =>
        review.taskId === node.task.id && review.taskDigest === digest(node.task) && review.status !== 'superseded') ||
        missingStatementContext(node)));
    this.markPendingValidation(synchronize, revalidate);
    this.changed(edit);
    this.input.emit('plan_updated', { groups: this.archive.groups, tasks: tasks.map(task =>
      ({ id: task.id, kind: task.kind, dependsOn: task.dependsOn, groupId: taskGroup(task), sharing: task.sharing ?? 'problem' })), invalidated: [...invalidated] });
    if (this.archive.tasks.some(node => node.pendingValidation)) this.schedulePlanSynchronization();
    else {
      this.syncStatementReviews(invalidated);
      if (edit) edit.pendingSync = undefined;
    }
    this.changed(edit);
  }
  /** A planning checkpoint without a graph must not leave every peer idle. */
  async startInitialTasks() {
    if (this.archive.tasks.length) return;
    const reason = this.archive.error ?? 'math_initial_plan_checkpoint';
    const researchers = this.input.workers.filter(worker => worker.role === 'researcher' && this.liveWorkers.has(worker.id));
    const targets = this.input.state.problem.targets;
    const tasks = [
      ...targets.map((target, index) => ({ id: `initial_goal_${index + 1}`, kind: 'goal',
        objective: `Prove the frozen original target ${target.theoremName}; use researcher findings as advisory guidance.`,
        proofPath: target.proofPath, theoremName: target.theoremName })),
      ...researchers.map((worker, index) => ({ id: `initial_research_${index + 1}`, kind: 'research', ownerId: worker.id,
        objective: `Investigate proof routes and difficult library connections for ${targets.filter((_, i) => i % researchers.length === index)
          .map(target => target.theoremName).join(', ') || 'the original targets'}. Report concrete evidence and unresolved gaps; findings are advisory.` })),
    ];
    await this.acceptPlan(parseCooperationPlan(this.input.state.problem, { tasks }));
    dropLeadWakes(this.archive.leadWakes!);
    this.archive.initialPlanFallback = { at: Date.now(), reason };
    this.archive.planEdited = true;
    this.syncPlanNotes();
    this.input.emit('initial_plan_fallback', { reason, planVersion: this.archive.planVersion });
    this.changed();
  }
  protected planVersion() {
    return mathDigest(canonicalMathJson({ tasks: this.plannedTasks().map(node => node.task),
      groups: this.archive.groups?.map(route => route.group),
      ...(this.archive.proofRoutes?.length ? { proofRoutes: this.archive.proofRoutes } : {}) }));
  }
  /** Nothing runs and the Lead already decided on these inputs: no process input can arrive, so the run ends. */
  protected async idleFrontier(frontier: ReturnType<CooperationPlanning['activeGoalFrontier']>, inputDigest: string): Promise<DispatchResult> {
    if (this.preparingTaskTypes.size) return this.waitForDispatch();
    if (this.resumeUnattemptedFrontier(frontier)) return RETRY_DISPATCH;
    this.input.emit('routes_idle', { groups: this.archive.groups,
      goalIds: [...new Set(frontier.flatMap(item => item.goalIds))], frontier,
      reason: frontier.length ? 'unchanged-mathematical-input' : 'no-active-goal-frontier', inputDigest });
  }
}
