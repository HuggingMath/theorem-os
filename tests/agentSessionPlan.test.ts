import { describe, expect, it } from 'vitest';
import { planMathAgentSession } from '../src/runtime/agentSessionPlan';
import type { MathAgentSkill } from '../src/runtime/agentSkills';

const skill = (loading: 'native' | 'file'): MathAgentSkill => ({ name: 'fixture',
  path: '/frozen/SKILL.md', digest: 'a'.repeat(64), loading });

describe('workflow session requirements and selected execution contracts', () => {
  it.each(['codex', 'claude-code', 'opencode', 'cli'] as const)('selects the actual %s research execution contract', harness => {
    const plan = planMathAgentSession(harness, { skills: [skill(harness === 'codex' ? 'native' : 'file')] },
      { session: { mode: 'fresh' } });
    expect(plan).toEqual({ schema: 'theorem-os.agent-session-plan.v1', harness,
      skillLoading: harness === 'codex' ? 'native' : 'file', roleIsolation: 'run-workspace', structuredOutput: 'none',
      continuation: harness === 'cli' ? 'source-context' : 'native-session' });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(plan).not.toHaveProperty('usageSource');
    expect(plan).not.toHaveProperty('notify');
    expect(plan).not.toHaveProperty('compact');
  });

  it.each(['claude-code', 'opencode', 'cli'] as const)('retains %s native capability restrictions', harness => {
    expect(() => planMathAgentSession(harness, { delegation: { mode: 'read-only', maxAgents: 2 } }))
      .toThrow('delegation_unsupported');
    expect(() => planMathAgentSession(harness, { skills: [skill('native')] }))
      .toThrow(harness === 'claude-code' ? 'native_skill_loading_unsupported' : 'requires_file_skill');
  });

  it('retains Codex sealed roles and the skill/delegation isolation guards', () => {
    expect(planMathAgentSession('codex', { readIsolation: { environment: 'standard' }, outputSchema: {} }))
      .toMatchObject({ skillLoading: 'none', roleIsolation: 'sealed-role', structuredOutput: 'native-schema' });
    expect(() => planMathAgentSession('codex', { readIsolation: { environment: 'standard' }, skills: [skill('file')] }))
      .toThrow('math_codex_skill_read_isolation_unsupported');
    expect(planMathAgentSession('codex', { delegation: { mode: 'read-only', maxAgents: 2 } }))
      .toMatchObject({ roleIsolation: 'run-workspace' });
    expect(() => planMathAgentSession('codex', { delegation: { mode: 'read-only', maxAgents: 0 } }))
      .toThrow('math_native_delegation_configuration_invalid');
    expect(() => planMathAgentSession('codex', { readIsolation: { environment: 'standard' },
      delegation: { mode: 'read-only', maxAgents: 2 } })).toThrow('math_native_delegation_read_isolation_unsupported');
    expect(planMathAgentSession('codex', { skills: [skill('native'), skill('file')] }).skillLoading).toBe('mixed');
  });

  it('only uses a structured CLI fallback when a host validator and exact output file are supplied', () => {
    const configuration = { session: { mode: 'fresh' as const } };
    expect(() => planMathAgentSession('cli', { outputSchema: {} }, configuration))
      .toThrow('math_cli_output_schema_unsupported');
    expect(planMathAgentSession('cli', { outputSchema: {}, completedOutput: { file: '/run/OUTPUT.json', validate() {} } }, configuration))
      .toMatchObject({ structuredOutput: 'validated-output-file', continuation: 'source-context' });
    expect(planMathAgentSession('claude-code', { outputSchema: {} }).structuredOutput).toBe('native-schema');
    expect(planMathAgentSession('opencode', { outputSchema: {} }).structuredOutput).toBe('native-schema');
  });

  it('requires the frozen CLI session mapping to distinguish resumable sessions from source continuation', () => {
    expect(() => planMathAgentSession('cli', {})).toThrow('math_cli_session_configuration_required');
    for (const mode of ['generated', 'reported'] as const) {
      expect(planMathAgentSession('cli', {}, { session: { mode, startArgs: [], resumeArgs: [] } }).continuation)
        .toBe('native-session');
    }
  });

  it.each(['claude-code', 'opencode'] as const)('plans %s sealed schema roles', harness => {
    expect(planMathAgentSession(harness, { readIsolation: { environment: 'standard' }, outputSchema: {} }))
      .toMatchObject({ roleIsolation: 'sealed-role', structuredOutput: 'native-schema', skillLoading: 'none' });
    expect(() => planMathAgentSession(harness, { readIsolation: { environment: 'standard' }, skills: [skill('file')] }))
      .toThrow('skill_read_isolation_unsupported');
  });

  it('requires an explicit generic CLI sealed projection before startup', () => {
    expect(() => planMathAgentSession('cli', { readIsolation: { environment: 'standard' } }, { session: { mode: 'fresh' } }))
      .toThrow('math_cli_sealed_role_configuration_required');
    expect(planMathAgentSession('cli', { readIsolation: { environment: 'standard' }, outputSchema: {},
      completedOutput: { file: '/output', validate: () => {} } }, { session: { mode: 'fresh' }, sealedRole: {
      provider: { wireApi: 'responses', baseUrl: 'http://127.0.0.1/v1', apiKeyEnvironment: 'FIXTURE_PROVIDER_KEY' },
      client: { baseUrlEnvironment: 'FIXTURE_BASE_URL', apiKeyEnvironment: 'FIXTURE_RELAY_KEY' }, profileFiles: {},
    } })).toMatchObject({ roleIsolation: 'sealed-role', structuredOutput: 'validated-output-file', continuation: 'source-context' });
  });
});
