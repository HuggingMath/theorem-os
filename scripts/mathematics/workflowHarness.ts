import path from 'node:path';
import type { FormalizationModelConfiguration } from '../../src/math/formalizationWorkflow';
import type { MathAgentOptions } from '../../src/runtime/agentSession';
import { planMathAgentSession } from '../../src/runtime/agentSessionPlan';
import { bindResearchHarness, researchHarness } from '../../src/runtime/researchHarness';
import { readCliConfiguration } from '../../src/runtime/cliConfiguration';

export const workflowHarnessFlags = ['harness', 'harness-profile', 'harness-executable'] as const;

/** Only explicit new selections add a binding; historical default request bytes remain unchanged. */
export function withWorkflowHarness(flags: ReadonlyMap<string, string>, configuration: FormalizationModelConfiguration,
  readIsolation?: MathAgentOptions['readIsolation'], prefix = ''): FormalizationModelConfiguration {
  if (!workflowHarnessFlags.some(name => flags.has(prefix + name))) return configuration;
  const id = researchHarness(flags.get(prefix + 'harness') ?? 'codex').id;
  const codex = prefix ? undefined : flags.get('codex');
  if (codex && id !== 'codex') throw new Error('--codex requires --harness codex');
  const selectedExecutable = flags.get(prefix + 'harness-executable');
  if (codex && selectedExecutable && codex !== selectedExecutable)
    throw new Error('conflicting --codex and --harness-executable');
  if (id !== 'codex' && !flags.has(prefix + 'model') && !(prefix && flags.has('model')))
    throw new Error('--model is required for --harness ' + id);
  const profileValue = flags.get(prefix + 'harness-profile') ?? (prefix ? undefined : flags.get('profile'));
  if (id !== 'codex' && !profileValue) throw new Error('--harness-profile is required for --harness ' + id);
  const profile = path.resolve(profileValue ?? configuration.profile);
  const cli = id === 'cli' ? readCliConfiguration(profile) : undefined;
  // Native provider/runtime configuration is validated before creating a request directory.
  planMathAgentSession(id, { readIsolation }, cli);
  const executable = selectedExecutable ?? (id === 'cli' ? cli!.executable :
    id === 'claude-code' ? 'claude' : id === 'opencode' ? 'opencode' : configuration.executable);
  const binding = bindResearchHarness(id, executable, profile, process.env, configuration.model);
  return { ...configuration, profile: binding.profile, executable: binding.executable, agentHarness: binding };
}
