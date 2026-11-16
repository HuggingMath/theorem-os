import type { MathAgentHarnessId, MathAgentOptions, MathAgentSessionPlan } from './agentSession';
import type { CliConfiguration } from './cliConfiguration';
import { validateNativeDelegation } from './nativeDelegation';

type Request = Pick<MathAgentOptions, 'skills' | 'readIsolation' | 'outputSchema' | 'completedOutput' | 'delegation'>;

/** Resolve actual workflow requirements before a native process or provider request.
 * A read-only host-root mount is not the sealed, credential-free role sandbox.
 * Unsupported role isolation therefore has no silent research-sandbox fallback. */
export function planMathAgentSession(harness: MathAgentHarnessId, request: Request,
  cli?: Pick<CliConfiguration, 'session' | 'sealedRole'>): MathAgentSessionPlan {
  const prefix = harness === 'claude-code' ? 'claude' : harness;
  if (request.readIsolation && request.skills?.length) throw new Error(`math_${prefix}_skill_read_isolation_unsupported`);
  if (request.readIsolation && harness === 'cli' && !cli?.sealedRole)
    throw new Error('math_cli_sealed_role_configuration_required');
  if (request.delegation) {
    if (harness !== 'codex') throw new Error(`math_${prefix}_delegation_unsupported`);
    validateNativeDelegation(request.delegation);
    if (request.readIsolation) throw new Error('math_native_delegation_read_isolation_unsupported');
  }
  const loading = new Set(request.skills?.map(skill => skill.loading));
  if (harness !== 'codex' && loading.has('native')) throw new Error(harness === 'claude-code'
    ? 'math_claude_native_skill_loading_unsupported' : `math_${prefix}_requires_file_skill`);
  if (harness === 'cli' && request.outputSchema && !request.completedOutput)
    throw new Error('math_cli_output_schema_unsupported');
  if (harness === 'cli' && !cli) throw new Error('math_cli_session_configuration_required');
  return Object.freeze({ schema: 'theorem-os.agent-session-plan.v1', harness,
    skillLoading: loading.size > 1 ? 'mixed' : loading.has('native') ? 'native' : loading.has('file') ? 'file' : 'none',
    roleIsolation: request.readIsolation ? 'sealed-role' : 'run-workspace',
    structuredOutput: request.outputSchema ? harness === 'cli' ? 'validated-output-file' : 'native-schema'
      : request.completedOutput ? 'validated-output-file' : 'none',
    continuation: harness === 'cli' && cli!.session.mode === 'fresh' ? 'source-context' : 'native-session' });
}
