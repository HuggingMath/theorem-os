import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { leadPlanPublicationTarget, parseLeadPlan } from './cooperationShared';
import { MAX_RESEARCH_NOTES_BYTES } from './deliveries';
import type { GoalPathReview } from './goalPathReview';
import { invalidPlanField, PlanValidationError, type PlanIssue } from './planDiagnostics';
import { liftNestedPlanPatch, type PlanPatchBase } from './planPatch';
import { readSolverProblem } from './problem';
import type { CooperationPlanProblem } from './tasks';

/** Lead-only snapshot. The running host still validates every proposal against live state. */
export type PlanToolContext = { problem: CooperationPlanProblem; base?: PlanPatchBase; goalPath?: GoalPathReview;
  publication?: ReturnType<typeof leadPlanPublicationTarget> };
type PlanValidation = { ok: true; planVersion: string; baseVersion?: string; summary: string; tasksCount: number;
  groupsCount: number; retireRoutesCount: number };
type PlanFailure = { ok: false; error: string; issues: PlanIssue[] };
type PlanInput = { workspace: string; file: string } | { workspace: string; text: string };

function failure(error: unknown, field = '$'): PlanFailure {
  if (error instanceof PlanValidationError) return { ok: false, error: error.code, issues: error.issues };
  const message = error instanceof Error ? error.message : 'Could not read the plan.';
  return { ok: false, error: /^math_[\w-]+/u.exec(message)?.[0] ?? 'math_plan_tool_failed', issues: [{ path: field, message }] };
}

function validated(value: unknown, context: PlanToolContext) {
  const candidate = liftNestedPlanPatch(value);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate))
    throw invalidPlanField('math_plan_invalid', '$', 'Supply one JSON object containing a complete plan or revision.');
  const plan = parseLeadPlan(context.problem, candidate, context.base, { goalPath: context.goalPath });
  const result: PlanValidation = {
    ok: true, planVersion: mathDigest(canonicalMathJson(plan)), baseVersion: context.base?.version,
    summary: `Validated ${plan.tasks.length} tasks in ${plan.groups.length} groups.`, tasksCount: plan.tasks.length,
    groupsCount: plan.groups.length, retireRoutesCount: plan.retireRoutes?.length ?? 0,
  };
  return result;
}

export function validateCooperationPlan(value: unknown, context: PlanToolContext): PlanValidation | PlanFailure {
  try { return validated(value, context); } catch (error) { return failure(error); }
}

function readCandidate(input: PlanInput): unknown {
  let text: string;
  try { text = 'text' in input ? input.text : readMathText(input.file, MAX_RESEARCH_NOTES_BYTES); }
  catch { throw invalidPlanField('math_plan_file_unreadable', '--file', 'Use a readable regular JSON file of at most 1 MB.'); }
  if (Buffer.byteLength(text) > MAX_RESEARCH_NOTES_BYTES)
    throw invalidPlanField('math_plan_file_too_large', '--file', 'Keep the plan JSON at or below 1 MB.');
  try { return JSON.parse(text); }
  catch (error) {
    throw invalidPlanField('math_plan_json_invalid', '$',
      'Supply JSON without Markdown fences. ' + (error instanceof Error ? error.message : 'Invalid JSON.'));
  }
}

function workspacePlanContext(worktree: string): PlanToolContext {
  const cooperationFile = path.join(worktree, 'COOPERATION.json');
  assertMathCanonicalPath(cooperationFile);
  if (fs.existsSync(cooperationFile)) {
    const cooperation = JSON.parse(readMathText(cooperationFile, 32_000_000)) as { planTool?: PlanToolContext };
    if (cooperation.planTool) return cooperation.planTool;
    throw invalidPlanField('math_plan_workspace_context_missing', '--workspace',
      'Run this command in the cooperative Lead worktree with its current COOPERATION.json.');
  }
  const receipt = path.join(worktree, 'active-problem.json');
  assertMathCanonicalPath(receipt);
  if (!fs.existsSync(receipt)) throw invalidPlanField('math_plan_workspace_context_missing', '--workspace',
    'Use the cooperative Lead worktree or a prepared workspace containing active-problem.json.');
  return { problem: readSolverProblem(worktree, receipt) };
}

function prepare(input: PlanInput) {
  const candidate = readCandidate(input);
  const worktree = fs.realpathSync(input.workspace);
  assertMathCanonicalPath(worktree);
  return validated(candidate, workspacePlanContext(worktree));
}

export function validateCooperationPlanFile(input: PlanInput): PlanValidation | PlanFailure {
  try { return prepare(input); } catch (error) { return failure(error); }
}
