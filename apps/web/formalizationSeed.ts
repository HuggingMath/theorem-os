import fs from 'node:fs';
import path from 'node:path';
import { bootstrapLeanTask } from '../../src/math/leanTask';
import { assertFormalizationCompiledCandidate, bootstrapFormalizedProblem, formalizationCompiledCandidateDigest,
  formalizationCompiledCandidateSchema, formalizationEvidenceSchema, writeFormalizationArtifact } from '../../src/math/formalization';
import type { WorkerInput } from './shared';
import { selectWebLibraryPack } from './frozenLibrary';
import { LIBRARY_PACK_SCHEMA, parseLibraryPack, type LibraryPack } from '../../src/math/libraryPacks';
import { canonicalMathJson } from '../../src/math/mathRuntimeIo';

/** Combining imports keeps identical dependencies once and rejects a changed module. */
export function combineWebLibraryPacks(...packs: (LibraryPack | undefined)[]): LibraryPack | undefined {
  const modules = new Map<string, LibraryPack['modules'][number]>();
  const requirements = new Map<string, string>();
  for (const pack of packs) {
    for (const module of pack?.modules ?? []) {
      const previous = modules.get(module.file);
      if (previous && previous.source !== module.source) throw new Error(`math_library_pack_source_conflict: ${module.file}`);
      if (!previous) modules.set(module.file, module);
    }
    for (const requirement of pack?.requires ?? []) {
      if (requirements.has(requirement.file) && requirements.get(requirement.file) !== requirement.digest)
        throw new Error(`math_library_pack_requirement_conflict: ${requirement.file}`);
      requirements.set(requirement.file, requirement.digest);
    }
  }
  return modules.size ? parseLibraryPack(JSON.parse(canonicalMathJson({ schema: LIBRARY_PACK_SCHEMA, modules: [...modules.values()],
    ...(requirements.size ? { requires: [...requirements].map(([file, digest]) => ({ file, digest })) } : {}) }))) : undefined;
}

/** Keep the approved original and evidence digest in the native frozen problem, across disposable containers. */
export function prepareWebProblem(directory: string, request: Pick<WorkerInput, 'input' | 'formalization' | 'compiledFormalization' | 'researchConfiguration'>,
  options: { libraryPack?: LibraryPack } = {}) {
  const { input } = request;
  const libraryPack = options.libraryPack ?? request.researchConfiguration?.libraryPack ?? selectWebLibraryPack(input);
  const taskFile = path.join(directory, 'task.md');
  if (request.compiledFormalization) {
    if (request.formalization || !input.formalizationId) throw new Error('formalization_binding_missing');
    const compiled = formalizationCompiledCandidateSchema.parse(request.compiledFormalization);
    assertFormalizationCompiledCandidate(compiled);
    if (compiled.request.problemId !== input.formalizationId || compiled.candidate.source !== input.source ||
        compiled.request.environment !== (input.environment ?? 'standard')) throw new Error('formalization_binding_changed');
    const task = 'Prove every frozen Lean target. Natural-language meaning is still under independent review.\n'
      + 'Original problem:\n' + compiled.request.statement + '\nOriginal SHA256: ' + compiled.request.statementSha256
      + '\nCompiled candidate SHA256: ' + formalizationCompiledCandidateDigest(compiled)
      + '\nPreserve all definitions, assumptions and target declarations.\n' + input.task;
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
      source: compiled.candidate.source, task, environment: compiled.request.environment, libraryPack });
    fs.writeFileSync(path.join(directory, 'compiled-formalization.json'), JSON.stringify(compiled), { flag: 'wx', mode: 0o400 });
    fs.writeFileSync(taskFile, task + '\nProve every target in generated/problem/Submission.lean.\n', { mode: 0o600 });
    return { workspaceRoot: receipt.workspaceRoot, activeProblemPath: receipt.activeProblemPath, taskFile };
  }
  if (input.formalizationId || request.formalization) {
    if (!input.formalizationId || !request.formalization) throw new Error('formalization_binding_missing');
    const evidence = formalizationEvidenceSchema.parse(request.formalization);
    if (evidence.request.problemId !== input.formalizationId || evidence.candidate.source !== input.source ||
        evidence.request.environment !== (input.environment ?? 'standard')) throw new Error('formalization_binding_changed');
    const frozen = path.join(directory, 'formalized');
    fs.mkdirSync(frozen, { mode: 0o700 });
    writeFormalizationArtifact(frozen, evidence);
    const seed = bootstrapFormalizedProblem(frozen, { libraryPack });
    fs.writeFileSync(taskFile, fs.readFileSync(seed.taskFile, 'utf8') + '\n\nAdditional research instructions:\n' + input.task + '\n', { mode: 0o600 });
    return { workspaceRoot: seed.workspaceRoot, activeProblemPath: seed.receiptFile, taskFile };
  }
  const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
    source: input.source, task: input.task, environment: input.environment ?? 'standard',
    libraryPack });
  fs.writeFileSync(taskFile, input.task + '\nOverall run objective: prove every original target in generated/problem/Submission.lean, preserving all original declarations. ' +
    'In cooperative mode, complete only your current assignment and preserve other original goal proofs, including existing sorry placeholders; the host integrates checked tasks and verifies all targets.\n', { mode: 0o600 });
  return { workspaceRoot: receipt.workspaceRoot, activeProblemPath: receipt.activeProblemPath, taskFile };
}
