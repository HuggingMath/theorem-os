import path from 'node:path';
import type { AgentHarnessIdentity } from '../math/agentHarnessIdentity';
import type { FormalizationModelConfiguration } from '../math/formalizationWorkflow';
import type { ResearchHarnessIdentity } from '../runtime/researchHarness';
import type { MathAgentOptions, MathAgentSession } from '../runtime/agentSession';
import { planMathAgentSession } from '../runtime/agentSessionPlan';
import { assertResearchHarnessCurrent, researchHarness, researchHarnessEnvironment } from '../runtime/researchHarness';
import { readCliConfiguration } from '../runtime/cliConfiguration';

type Configuration = FormalizationModelConfiguration;

function assertBinding(config: Configuration): void {
  if (config.agentHarness && (config.executable !== config.agentHarness.executable || path.resolve(config.profile) !== config.agentHarness.profile))
    throw new Error('math_workflow_harness_binding_mismatch');
}

/** These workflows consume sealed role inputs; run-workspace isolation is a different contract. */
export function assertWorkflowSessionSupported(config: Configuration, readIsolation: NonNullable<MathAgentOptions['readIsolation']>): void {
  if (!config.agentHarness) return;
  assertBinding(config);
  planMathAgentSession(config.agentHarness.id, { readIsolation }, config.agentHarness.id === 'cli' ? readCliConfiguration(config.profile) : undefined);
}

/** The existing profile digest is unchanged when a historical request has no explicit harness binding. */
export function workflowProfileFiles<T>(config: Configuration, legacy: () => T, environment: NodeJS.ProcessEnv): T | { agentHarness: AgentHarnessIdentity; files?: T } {
  if (!config.agentHarness) return legacy();
  assertBinding(config);
  assertResearchHarnessCurrent(config.agentHarness as ResearchHarnessIdentity, { ...environment, ...researchHarnessEnvironment(config.agentHarness.id, process.env,
    { profile: config.profile, model: config.model }) }, config.model);
  return { agentHarness: config.agentHarness, ...(config.agentHarness.id === 'codex' ? { files: legacy() } : {}) };
}

/** A production harness is selected here, rather than being mislabeled as an injected preset session. */
export async function openWorkflowSession(config: Configuration, options: MathAgentOptions,
  injected?: (options: MathAgentOptions) => Promise<MathAgentSession>): Promise<MathAgentSession> {
  assertBinding(config);
  if (config.agentHarness && (['executable', 'profile', 'model', 'effort'] as const).some(key => config[key] !== options[key]))
    throw new Error('math_workflow_harness_binding_mismatch');
  if (config.agentHarness && options.readIsolation) assertWorkflowSessionSupported(config, options.readIsolation);
  if (injected) {
    if (config.agentHarness) throw new Error('math_workflow_harness_injection_conflict');
    return injected(options);
  }
  const id = config.agentHarness?.id ?? 'codex';
  const environment = config.agentHarness ? { ...options.environment,
    ...researchHarnessEnvironment(id, process.env, { profile: config.profile, model: config.model }) } : options.environment;
  const current = () => {
    if (config.agentHarness) assertResearchHarnessCurrent(config.agentHarness as ResearchHarnessIdentity, environment ?? process.env, config.model);
  };
  current();
  const session = await researchHarness(id).open({ ...options, environment });
  if (!config.agentHarness) return session;
  const run = session.run, close = session.close;
  session.run = async (...args) => { current(); return run(...args); };
  session.close = async () => { await close(); current(); };
  return session;
}
