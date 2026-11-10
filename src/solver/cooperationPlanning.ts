import { parseCooperationPlan, isAdvisoryTask as advisory } from './tasks';
import { assertPlanTaskTypeContracts } from './taskTypeContract';
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
import { keepRespacedObjectives, taskGroup, taskVersion, taskProofContractVersion, taskReferenceDependencies, invalidatedTaskIds, type TaskRecord,
  type CooperativeAction } from './tasks';
import { digest, HumanEditRecord, InitialPlanPublication, RETRY_DISPATCH, DispatchResult, bounded, deliveryInputFields, readCooperationPlan,
  type LeadPlan } from './cooperationShared';
import { formatPlanJson, type PlanPatchBase } from './planPatch';
import { collapseTaskFamilies } from './taskFamilies';
import { dropLeadWakes, LEAD_MAX_BACKOFF } from './leadWakes';
import { CooperationIntegration } from './cooperationIntegration';
import { researchRouteGroups, researchWorkerCanNode } from './modules/organization';
import { currentCapacityExploration } from './capacityExploration';
import { currentNextCheck, prepareNextCheckDecisions } from './nextChecks';
import { prepareGoalProgressDecision } from './goalProgress';
import { answerResearchInputs } from './researchDecisions';
import { leadResearchInputs } from './contextCompiler';

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
      rebased, restoring: !action, ...(rebased ? {} : { goalPath: this.goalPathReview() }) });
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
    // New peer evidence must release the pause, because a plan input drops any delivery whose task version
    // has since advanced and would otherwise hide the finding that alone can wake the Lead. The immutable
    // content of peer publications is that evidence; a peer saving its notes mid-slice is work this Lead
    // already dispatched and must not re-open the turn on every checkpoint.
    return mathDigest(canonicalMathJson({ inputDigest: this.planningInputDigest(true),
      evidenceDigest: this.planningEvidenceDigest(), planVersion: this.planVersion(),
      sourceDigest, notesDigest: mathDigest(notes) }));
  }
  /** A completed decision covers its own bookkeeping, but never evidence arriving during that dispatch. */
  protected rememberLeadDecision(action: CooperativeAction) {
    if (action.kind === 'lead' && action.planningInputDigest) {
      this.archive.lastLeadInputDigest = this.leadEvidence.get(action) === this.planningEvidenceDigest()
        ? this.planningInputDigest() : action.planningInputDigest;
      this.archive.lastLeadPauseInputDigest = undefined;
      // Diagnostic only: an accepted plan does not answer a peer still in the same no-work episode.
      this.archive.leadDecisionBasisAt = this.archive.leadInboxBasis?.at ?? Date.now();
      this.answerGoalProgressReview(action);
      const pending = leadResearchInputs(this.archive.deliveries ?? [],
        new Map(this.archive.tasks.map(node => [node.task.id, node])), this.archive.researchDecisions);
      const merging = new Set((this.pendingSourceResearchDecisions.get(action) ?? []).map(item => item.deliveryId));
      if (pending.some(record => !merging.has(record.id)) && this.presentedResearchInputs.get(action)?.shown.length) {
        // A second page was present at dispatch; evidence arriving later is already a different input digest.
        const presented = this.presentedResearchInputs.get(action)!;
        if (presented.total > presented.shown.length) this.archive.lastLeadInputDigest = undefined;
        this.wakeLead('research-finding');
      }
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
    const checkView = this.nextCheckPlanView({ tasks, groups, proofRoutes });
    for (const node of this.archive.tasks) if (node.nextCheckId &&
        tasks.some(task => task.id === node.task.id && digest(task) === digest(node.task))) {
      const record = this.archive.nextChecks?.find(record => record.id === node.nextCheckId);
      // Group revisions and unrelated consumers cannot strip a current check's host identity.
      if (record && currentNextCheck(record, checkView, this.explorationIdentity)) invalidated.delete(node.task.id);
    }
    return invalidated;
  }
  protected async acceptPlan(planInput?: LeadPlan, edit?: HumanEditRecord,
    publication?: { action: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>;
      receipt: Omit<InitialPlanPublication, 'planVersion'> },
    leadAction?: Extract<CooperativeAction, { kind: 'lead' | 'assemble' }>) {
    const plan = planInput ?? this.readLeadPlan(leadAction);
    plan.tasks = keepRespacedObjectives(plan.tasks, new Map(this.archive.tasks.map(node => [node.task.id, node.task])));
    const decidingAction = publication?.action ?? leadAction;
    const nextCheckDecisions = prepareNextCheckDecisions(this.archive, this.explorationIdentity, plan,
      plan.nextCheckDecisions, decidingAction ? this.presentedNextCheckOutcomes.get(decidingAction) : []);
    this.includeCapacityExplorations(plan);
    this.includeNextCheckTasks(plan);
    const { tasks, groups, proofRoutes } = plan;
    assertPlanTaskTypeContracts(tasks, this.archive.tasks.map(node => node.task));
    const restoringPlan = !decidingAction && !edit && this.archive.tasks.length > 0;
    const shown = decidingAction?.kind === 'lead' ? this.presentedResearchInputs.get(decidingAction)?.shown ?? [] :
      restoringPlan ? leadResearchInputs(this.archive.deliveries ?? [],
        new Map(this.archive.tasks.map(node => [node.task.id, node])), this.archive.researchDecisions).slice(-8) : [];
    const researchDecisions = answerResearchInputs(plan, shown, this.plannedTasks().map(node => node.task),
      tasks, [...this.archive.researchDecisions ?? [],
        ...(decidingAction ? this.pendingSourceResearchDecisions.get(decidingAction) ?? [] : [])], '', Date.now());
    for (const decision of researchDecisions.filter(item => item.outcome === 'source')) {
      if (decidingAction?.kind !== 'lead') throw new Error('math_plan_research_source_invalid: no Lead source dispatch.');
      for (const file of decision.sourcePaths ?? []) {
        const problem = this.input.state.problem;
        if (!file.endsWith('.lean') || !problem.ownedFiles.includes(file) || problem.frozenFiles?.[file])
          throw new Error('math_plan_research_source_invalid: ' + file);
        const relative = path.posix.join(problem.projectRelative, file);
        if (fs.readFileSync(path.join(this.lead.worktree, relative), 'utf8') ===
            committedSource(this.lead.worktree, decidingAction.seedCommit, relative))
          throw new Error('math_plan_research_source_unchanged: ' + file);
      }
    }
    // Peer evidence can settle a review while its Lead is still composing an otherwise valid plan.
    // Only the still-owed review shown to this dispatch may contribute a new progress decision.
    const progressDecision = plan.goalProgressDecision && decidingAction &&
      this.archive.goalProgress?.pending?.id === plan.goalProgressDecision.id &&
      this.presentedGoalProgress.get(decidingAction) === plan.goalProgressDecision.id
      ? prepareGoalProgressDecision(plan.goalProgressDecision, this.archive.goalProgress, plan,
        this.archive.nextChecks, this.archive.tasks) : undefined;
    const publicationResponseDigest = publication ? this.proposedPlanDigest(
      git(this.lead.worktree, ['ls-tree', '--name-only', publication.action.seedCommit, '--', 'RESEARCH.md'])
        ? committedSource(this.lead.worktree, publication.action.seedCommit, 'RESEARCH.md') : '') : undefined;
    for (const task of tasks) if (task.ownerId || task.preferredOwnerId) {
      const owner = this.input.workers.find(worker => worker.id === (task.ownerId ?? task.preferredOwnerId));
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
    const graphDecisions = researchDecisions.filter(decision => decision.outcome !== 'source');
    const sourceDecisions = researchDecisions.filter(decision => decision.outcome === 'source');
    if (sourceDecisions.length && decidingAction)
      this.pendingSourceResearchDecisions.set(decidingAction, sourceDecisions);
    if (graphDecisions.length) {
      this.archive.researchDecisions = [...this.archive.researchDecisions ?? [],
        ...graphDecisions.map(decision => ({ ...decision, planVersion: this.archive.planVersion! }))];
      this.input.emit('research_findings_decided', { decisions: graphDecisions.map(decision =>
        ({ deliveryId: decision.deliveryId, outcome: decision.outcome, taskIds: decision.taskIds })) });
    }
    if (restoringPlan && shown.length && leadResearchInputs(this.archive.deliveries ?? [],
      new Map(this.archive.tasks.map(node => [node.task.id, node])), this.archive.researchDecisions).length) {
      this.archive.lastLeadInputDigest = undefined;
      this.wakeLead('research-finding');
    }
    for (const { record, decision, repeated } of nextCheckDecisions) if (!repeated) {
      record.decision = { ...decision, at: Date.now(), planVersion: this.archive.planVersion }; record.status = 'decided';
      this.input.emit('next_check_decided', { checkId: record.id, outcomeDeliveryId: decision.outcomeDeliveryId,
        action: decision.action, target: record.scope.target });
    }
    if (plan.goalPathDecisions && decidingAction) this.recordGoalPathDecisions(decidingAction, plan.goalPathDecisions);
    if (progressDecision && decidingAction) this.goalProgressDecisions.set(decidingAction, progressDecision);
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
  /** A proposed source answer becomes durable only when its changed Lean file reaches the canonical commit. */
  protected settleSourceResearchDecisions(action: CooperativeAction, previousCommit: string, mergedCommit: string) {
    const pending = this.pendingSourceResearchDecisions.get(action);
    if (!pending?.length) return;
    this.pendingSourceResearchDecisions.delete(action);
    const root = this.input.state.problem.projectRelative;
    const applied = pending.filter(decision => decision.sourcePaths?.every(file => {
      const relative = path.posix.join(root, file);
      return committedSource(this.lead.worktree, previousCommit, relative) !==
        committedSource(this.lead.worktree, mergedCommit, relative);
    }));
    if (applied.length) {
      this.archive.researchDecisions = [...this.archive.researchDecisions ?? [], ...applied.map(decision =>
        ({ ...decision, at: Date.now(), planVersion: this.archive.planVersion! }))];
      this.input.emit('research_findings_decided', { decisions: applied.map(decision =>
        ({ deliveryId: decision.deliveryId, outcome: decision.outcome, sourcePaths: decision.sourcePaths })) });
    }
    if (applied.length !== pending.length) this.wakeLead('research-finding');
  }
  /** A planning checkpoint without a graph must not leave every peer idle. */
  async startInitialTasks() {
    if (this.archive.tasks.length) return;
    const reason = this.archive.error ?? 'math_initial_plan_checkpoint';
    const researchers = this.input.workers.filter(worker => worker.role === 'researcher' && this.liveWorkers.has(worker.id));
    const engineer = this.input.workers.find(worker => worker.role === 'engineer' && this.liveWorkers.has(worker.id));
    const targets = this.input.state.problem.targets;
    // Start the Engineer on original goals and preserve the Researchers' initial coverage.
    // Once a Researcher has no ready investigation, it may share unstarted goals with a busy Engineer.
    const goals = targets.map((target, index) => ({ id: `initial_goal_${index + 1}`, kind: 'goal' as const,
      objective: `Prove the frozen original target ${target.theoremName}; use researcher findings as advisory guidance.`,
      ...(engineer ? { preferredOwnerId: engineer.id } : {}),
      proofPath: target.proofPath, theoremName: target.theoremName }));
    // Identical investigation text makes two Researchers ask one question; each gets a distinct angle.
    const angles = [
      'the central construction or quantitative estimate, with its exact assumptions and the missing inference',
      'library connections: the exact existing lemmas or definitions that could discharge a step, with pinned versions and searches',
      'the hardest substantive inference: whether it holds as stated, with a counterexample search or a concrete reduction',
      'a concrete end-to-end proof route, naming the remaining gaps in order',
    ];
    const tasks = [...goals, ...researchers.map((worker, index) => {
      // Round-robin coverage, but never an empty assignment: one target belongs to every Researcher.
      const primary = targets.filter((_, targetIndex) => targetIndex % researchers.length === index);
      const coveredTargets = primary.length ? primary : targets;
      const covered = coveredTargets.map(target => target.theoremName).join(', ');
      const researchSource = (['public-literature', 'verified-library', 'mathlib'] as const)[index % 3];
      return { id: `initial_research_${index + 1}`, kind: 'research' as const, ownerId: worker.id, researchSource,
        consumerGoalIds: goals.filter(goal => coveredTargets.some(target => target.proofPath === goal.proofPath &&
          target.theoremName === goal.theoremName)).map(goal => goal.id),
        // The goal is an inspection input, never a proof dependency: a parked advisory review must not
        // make the original goal unstartable (advisory tasks may depend on the consumer, not the reverse).
        dependsOn: goals.map(goal => goal.id),
        objective: `Investigate ${angles[index % angles.length]} for ${covered}` +
          `${researchers.length > 1 ? ` (investigation ${index + 1} of ${researchers.length})` : ''}. ` +
          `Focus on ${researchSource}; deliver sourceUses with exact assumptions and consumer adaptation, ` +
          'and typed lemmaRequests when the implementation method is known. Report concrete evidence and unresolved gaps; findings are advisory.' };
    })];
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
  /**
   * A checkpoint cut is not a Lead decision. When nothing else runs, the cut draft is the only possible input,
   * so the Lead continues it on its backoff schedule; only a pause past the backoff cap, unchanged, ends the run.
   */
  protected resumePausedLead() {
    if (!this.archive.lastLeadPauseInputDigest || this.active.size) return false;
    const research = this.input.state.workers?.find(record => record.id === this.lead.id) ?? this.input.state;
    const streak = research.advisoryCheckpoint?.noProgressStreak ?? 0;
    if (streak > LEAD_MAX_BACKOFF) return false;
    this.archive.lastLeadPauseInputDigest = undefined;
    this.wakeLead('lead-pause-idle');
    this.input.emit('lead_pause_resumed', { noProgressStreak: streak });
    this.changed();
    return true;
  }
  /** Nothing runs and the Lead already decided on these inputs: no process input can arrive, so the run ends. */
  protected async idleFrontier(frontier: ReturnType<CooperationPlanning['activeGoalFrontier']>, inputDigest: string): Promise<DispatchResult> {
    if (this.preparingTaskTypes.size) return this.waitForDispatch();
    if (this.resumeUnattemptedFrontier(frontier)) return RETRY_DISPATCH;
    if (this.resumePausedLead()) return RETRY_DISPATCH;
    this.input.emit('routes_idle', { groups: this.archive.groups,
      goalIds: [...new Set(frontier.flatMap(item => item.goalIds))], frontier,
      reason: frontier.length ? 'unchanged-mathematical-input' : 'no-active-goal-frontier', inputDigest });
  }
}
