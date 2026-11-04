import fs from 'node:fs';
import path from 'node:path';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { bootstrapFormalizedProblem, formalizationEvidenceSchema, writeFormalizationArtifact } from '../../src/math/formalization';
import type { WorkerInput } from './shared';

/** Keep the approved original and evidence digest in the native frozen problem, across disposable containers. */
export function prepareWebProblem(directory: string, request: Pick<WorkerInput, 'input' | 'formalization'>) {
  const { input } = request;
  const taskFile = path.join(directory, 'task.md');
  if (input.formalizationId || request.formalization) {
    if (!input.formalizationId || !request.formalization) throw new Error('formalization_binding_missing');
    const evidence = formalizationEvidenceSchema.parse(request.formalization);
    if (evidence.request.problemId !== input.formalizationId || evidence.candidate.source !== input.source ||
        evidence.request.environment !== (input.environment ?? 'standard')) throw new Error('formalization_binding_changed');
    const frozen = path.join(directory, 'formalized');
    fs.mkdirSync(frozen, { mode: 0o700 });
    writeFormalizationArtifact(frozen, evidence);
    const seed = bootstrapFormalizedProblem(frozen);
    fs.writeFileSync(taskFile, fs.readFileSync(seed.taskFile, 'utf8') + '\n\nAdditional research instructions:\n' + input.task + '\n', { mode: 0o600 });
    return { workspaceRoot: seed.workspaceRoot, activeProblemPath: seed.receiptFile, taskFile };
  }
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
    source: input.source, task: input.task, environment: input.environment ?? 'standard' });
  fs.writeFileSync(taskFile, input.task + '\nPreserve all original declarations. Prove every target in generated/problem/Submission.lean.\n', { mode: 0o600 });
  return { workspaceRoot: receipt.workspaceRoot, activeProblemPath: receipt.activeProblemPath, taskFile };
}
