import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { bootstrapLeanTask, readLeanTaskReceipt } from '../math/leanTask';
import type { LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { autoLibraryModule } from '../math/autoLibrary';
import { checkLeanType } from '../math/leanTypeDiagnostics';
import { canonicalMathJson, mathDigest } from '../math/mathRuntimeIo';
import type { LibraryPack } from '../math/libraryPacks';
import { knowledgeApplicationCheckSchema, knowledgeApplicationReportSchema } from './knowledgeUsage';

export const autoLibraryApplicationCheckSchema = z.object({
  declaration: z.string(), application: knowledgeApplicationReportSchema, check: knowledgeApplicationCheckSchema,
}).strict();

/** Test a library theorem at the original consumer without changing the active problem or its frozen pack. */
export async function checkAutoLibraryApplication(input: {
  workspace: string; source: string; environment: LeanTaskEnvironment; pack: LibraryPack; moduleName: string;
  definitionTargets?: string[];
  selected: { declaration: string; application: z.infer<typeof knowledgeApplicationReportSchema> };
  env: NodeJS.ProcessEnv; signal?: AbortSignal; prepare: () => Promise<void>;
}): Promise<z.infer<typeof autoLibraryApplicationCheckSchema>> {
  const { selected } = input;
  const base = { authority: 'advisory-application-elaboration' as const, proofAcceptance: 'not-assessed' as const,
    consumerCoverage: 'not-assessed' as const, commit: '', environmentDigest: '' };
  try {
    input.signal?.throwIfAborted();
    const file = path.join(input.workspace, 'workspace', 'active-problem.json');
    const source = `import ${autoLibraryModule(input.moduleName)}\n${input.source}`;
    const receipt = fs.existsSync(file) ? readLeanTaskReceipt(file) :
      bootstrapLeanTask(path.join(input.workspace, 'workspace'), { source, task: 'Check the selected library application at its original consumer.',
        environment: input.environment, libraryPack: input.pack,
        ...(input.definitionTargets ? { definitionTargets: input.definitionTargets } : {}) });
    if (receipt.contract.formalStatement !== source)
      throw new Error('auto_library_application_source_changed');
    base.commit = receipt.baseCommit; base.environmentDigest = receipt.environmentDigest ?? '';
    const selectionDigest = mathDigest(canonicalMathJson({ source, pack: receipt.libraryPack, selected,
      ...(input.definitionTargets ? { definitionTargets: input.definitionTargets } : {}) }));
    const identityFile = path.join(input.workspace, 'application.sha256');
    if (fs.existsSync(identityFile) && fs.readFileSync(identityFile, 'utf8') !== selectionDigest)
      throw new Error('auto_library_application_identity_changed');
    if (!fs.existsSync(identityFile)) fs.writeFileSync(identityFile, selectionDigest, { mode: 0o400, flag: 'wx' });
    await input.prepare();
    input.signal?.throwIfAborted();
    const report = selected.application;
    const result = await checkLeanType({ projectRoot: receipt.projectRoot, file: report.context.file,
      context: report.context.declaration, type: report.expectedType, expression: report.expression,
      env: input.env, signal: input.signal, timeoutMs: Infinity });
    const elaborated = result.status === 'elaborated';
    return { ...selected, check: { ...base, status: elaborated ? 'elaborated' : result.exitCode === 1 && !result.timedOut ? 'failed' : 'unavailable',
      reason: elaborated ? 'selected-expression-elaborated-against-requested-type' : 'selected-expression-did-not-elaborate',
      sourceSnapshotDigest: result.sourceSnapshotDigest, projectionDigest: result.projectionDigest,
      diagnosticEnvironmentDigest: result.environment.environmentDigest, toolIdentity: result.environment.toolIdentity,
      files: result.sourceFiles, artifact: result.artifact, elaboratedType: result.type,
      ...(elaborated ? { selectedDeclarationUsed: result.constants?.includes(selected.declaration.replace(/^_root_\./u, '')) ?? false } : {}),
      ...(!elaborated ? { diagnostic: (result.firstBlocking?.message || result.stderr || result.stdout || 'No diagnostic').slice(0, 8000) } : {}) } };
  } catch (cause) {
    input.signal?.throwIfAborted();
    return { ...selected, check: { ...base, status: 'unavailable',
      reason: (cause instanceof Error ? cause.message : String(cause)).slice(0, 1000) } };
  }
}
