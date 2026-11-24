import fs from 'node:fs';
import path from 'node:path';
import { canonicalMathJson, mathDigest, readMathText, writeMathTextDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { parseLeadPlan } from './cooperationShared';
import { isPlanFence, MAX_RESEARCH_NOTES_BYTES, parseMathResponse } from './deliveries';
import type { GoalPathReview } from './goalPathReview';
import { invalidPlanField, PlanValidationError, type PlanIssue } from './planDiagnostics';
import { liftNestedPlanPatch, type PlanPatchBase } from './planPatch';
import { readSolverProblem } from './problem';
import type { CooperationPlanProblem } from './tasks';

/** Lead-only snapshot. The running host still validates every proposal against live state. */
export type PlanToolContext = { problem: CooperationPlanProblem; base?: PlanPatchBase; goalPath?: GoalPathReview };
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
  const canonical = canonicalMathJson(candidate);
  const result: PlanValidation = {
    ok: true, planVersion: mathDigest(canonicalMathJson(plan)), baseVersion: context.base?.version,
    summary: `Validated ${plan.tasks.length} tasks in ${plan.groups.length} groups.`, tasksCount: plan.tasks.length,
    groupsCount: plan.groups.length, retireRoutesCount: plan.retireRoutes?.length ?? 0,
  };
  return { canonical, result };
}

export function validateCooperationPlan(value: unknown, context: PlanToolContext): PlanValidation | PlanFailure {
  try { return validated(value, context).result; } catch (error) { return failure(error); }
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
  return { worktree, ...validated(candidate, workspacePlanContext(worktree)) };
}

export function validateCooperationPlanFile(input: PlanInput): PlanValidation | PlanFailure {
  try { return prepare(input).result; } catch (error) { return failure(error); }
}

function replacePlanFence(source: string, fence: string): string {
  // The complete bare JSON response from an older Lead is also a plan block.
  if (isPlanFence('json', source.trim()) && source.trimStart().startsWith('{')) {
    try { JSON.parse(source); return fence + '\n'; } catch { /* Preserve surrounding prose. */ }
  }
  let replaced = false;
  const notes = source.replace(/```([a-z-]+)\s*\n([\s\S]*?)\n```/gu, (block, label: string, body: string) => {
    if (!isPlanFence(label, body)) return block;
    if (replaced) return '';
    replaced = true;
    return fence;
  });
  return replaced ? notes : fence + '\n' + (source ? '\n' + source : '');
}

/** Write a validated draft in one rename. Any revision keeps its baseVersion and decision fields until host intake. */
export function applyCooperationPlanFile(input: PlanInput): (PlanValidation & { file: string }) | PlanFailure {
  let candidate: ReturnType<typeof prepare>;
  try { candidate = prepare(input); } catch (error) { return failure(error); }
  const { worktree, result, canonical } = candidate;
  const file = path.join(worktree, 'RESEARCH.md');
  try {
    assertMathCanonicalPath(file);
    const source = fs.existsSync(file) ? readMathText(file, MAX_RESEARCH_NOTES_BYTES) : '';
    const next = replacePlanFence(source, '```math-plan\n' + canonical + '\n```');
    if (Buffer.byteLength(next) > MAX_RESEARCH_NOTES_BYTES)
      throw invalidPlanField('math_plan_notes_too_large', 'RESEARCH.md', 'Shorten the existing notes or the plan so they fit within 1 MB.');
    if (canonicalMathJson(parseMathResponse(next, 'math-plan')) !== canonical)
      throw invalidPlanField('math_plan_notes_invalid', 'RESEARCH.md', 'Repair the existing plan fence before applying the draft.');
    if (source !== next) writeMathTextDurable(file, next);
    return { ...result, file };
  } catch (error) { return failure(error, 'RESEARCH.md'); }
}
