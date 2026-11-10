import { maskLeanCommentsAndStrings } from '../math/leanSyntax';
import type { CooperativeTask } from './tasks';

type TypedTask = Pick<CooperativeTask, 'id' | 'kind' | 'type'>;

/** Declaration commands cannot be used as type terms, even when their elaboration context is unavailable. */
export function taskTypeContractError(task: TypedTask): string | undefined {
  if (task.kind !== 'lemma' || typeof task.type !== 'string') return;
  const type = maskLeanCommentsAndStrings(task.type).trimStart();
  if (!/^(?:@\[[^\]]*\]\s*)*(?:(?:private|protected|noncomputable|nonrec|unsafe|partial|public|meta)\s+)*(?:theorem|lemma|def|abbrev|example)(?=\s|$)/u.test(type)) return;
  return `Task ${task.id}: helper type starts with a Lean declaration command. Supply a closed type term, ` +
    'for example `∀ (n : Nat), n = n`, instead of `theorem name (n : Nat) : n = n`. ' +
    'Keep the declaration name in theoremName and explicitly quantify every parameter and instance in type. ' +
    'Revise the task contract; the host has not changed its statement or inferred missing binders.';
}

export function assertTaskTypeContract(task: TypedTask): void {
  const reason = taskTypeContractError(task);
  if (reason) throw new Error('math_task_type_invalid\n' + reason);
}

/** Unchanged legacy contracts remain readable so a plan revision can repair them without losing the run. */
export function assertPlanTaskTypeContracts(tasks: readonly CooperativeTask[], previousTasks: readonly CooperativeTask[] = []): void {
  const previous = new Map(previousTasks.map(task => [task.id, task]));
  for (const task of tasks) {
    const before = previous.get(task.id);
    if (before?.kind === task.kind && before.type === task.type) continue;
    const reason = taskTypeContractError(task);
    if (reason) throw new Error('math_plan_invalid_helper_type: ' + reason);
  }
}
