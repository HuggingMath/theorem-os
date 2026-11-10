import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { isAttributedTaskProof, type TaskProof, type TaskProofRequest } from './cooperativeProof';
import { taskVersion } from './tasks';

type ConditionalCheckInput = TaskProofRequest & {
  environmentDigest: string; problemReceiptDigest: string; environment: NodeJS.ProcessEnv;
};
// This binds a seed receipt to its live inputs, not to persisted acceptance.
const freshConditionalChecks = new WeakMap<TaskProof, string>();
const inputDigest = ({ task, assignment, retainedGoals, conditions = [], environment,
  environmentDigest, problemReceiptDigest }: ConditionalCheckInput) => {
  // The loader's path can change from the host config to the solver's frozen
  // projection. Compare the effective settings, including the live proof seal.
  const { DEEPSCIENTIST_MATH_ENV_FILE: _file, ...runtime } =
    projectMathematicsRuntimeEnvironment(resolveMathematicsRuntimeEnvironment(environment));
  return mathDigest(canonicalMathJson({ taskDigest: taskVersion(task), assignment, retainedGoals: retainedGoals.toSorted(),
    conditions: conditions.map(task => ({ taskId: task.id, taskDigest: taskVersion(task) })),
    environmentDigest, problemReceiptDigest, environment: runtime }));
};

/** Only seeding with the caller's still-live prepared environment may hand off this receipt. */
export function rememberFreshConditionalCheck(proof: TaskProof, input: ConditionalCheckInput) {
  if (proof.passed && proof.conditions?.length && isAttributedTaskProof(proof))
    freshConditionalChecks.set(proof, inputDigest(input));
}

/** The caller must still apply its ordinary task, source, projection and receipt checks. */
export function reusableFreshConditionalCheck(proof: TaskProof, input: ConditionalCheckInput): boolean {
  return isAttributedTaskProof(proof) && freshConditionalChecks.get(proof) === inputDigest(input);
}
