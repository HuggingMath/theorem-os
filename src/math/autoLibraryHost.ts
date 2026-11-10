import { bootstrapLeanTask, leanTaskId, type LeanTaskInput } from './leanTask';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from './leanTaskEnvironment';
import { authorizeHostAutoTask, resolveHostLibrary } from './libraryHostConfig';
import type { EffectiveLibraryBinding } from './libraryEffectivePack';

export function autoLibraryHostTarget(environmentId: string) {
  const environment = getLeanTaskEnvironment(environmentId as LeanTaskEnvironment);
  return { toolchain: environment.toolchain, lakeManifest: environment.files['lake-manifest.json']!,
    runtimeEnvironmentDigest: environment.dependencyDigest };
}
export function resolveAutoLibraryBase(challengeId: string, environment: string, workspace: string) {
  return resolveHostLibrary({ taskId: challengeId }, autoLibraryHostTarget(environment), workspace);
}
export type AutoLibraryHostContext = { binding: EffectiveLibraryBinding; provenance: unknown };

/** Called by the host build, never by the task JSON interface. Resume resolves the same registry independently. */
export function bootstrapAutoLibraryTask(workspace: string, input: LeanTaskInput, host?: AutoLibraryHostContext) {
  if (!host) return bootstrapLeanTask(workspace, input);
  authorizeHostAutoTask({ parent: { taskId: host.binding.taskId }, binding: host.binding,
    target: autoLibraryHostTarget(input.environment ?? 'standard'), workspace, taskId: leanTaskId(input.source),
    pack: input.libraryPack, provenance: host.provenance });
  const { libraryPack: _pack, ...task } = input;
  return bootstrapLeanTask(workspace, task);
}
