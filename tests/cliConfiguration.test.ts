import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliFieldMatches, cliFieldValue, expandCliTemplate, readCliConfiguration } from '../src/runtime/cliConfiguration';
import { assertResearchHarnessCurrent, bindResearchHarness, researchHarnessEnvironment } from '../src/runtime/researchHarness';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture(overrides: Record<string, unknown> = {}) {
  const root = temporaryDirectory('cli-configuration-'); roots.push(root);
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const executable = path.join(root, 'command'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const config = { schema: 'theorem-os.cli-harness.v1', executable, args: ['--model', '{model}'], ...overrides };
  const write = (value: unknown) => fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify(value));
  write(config);
  return { root, profile, executable, config, write };
}

describe('declarative headless CLI configuration', () => {
  it.each(['generic', 'gemini', 'qwen', 'aider'])('ships a schema-valid %s profile with all declared settings present', name => {
    expect(() => readCliConfiguration(path.resolve('resources/cli-harnesses', name))).not.toThrow();
  });

  it('defaults a one-shot command to stdin, plain text and explicit no reasoning control', () => {
    const f = fixture();
    expect(readCliConfiguration(f.profile)).toMatchObject({ prompt: 'stdin', session: { mode: 'fresh' },
      output: { format: 'text' }, efforts: ['none'], environment: {}, inheritEnvironment: [] });
  });

  it.each([
    [{ args: [] }, 'math_cli_model_binding_missing'],
    [{ efforts: ['high'] }, 'math_cli_effort_binding_missing'],
    [{ prompt: 'file' }, 'math_cli_prompt_binding_invalid'],
    [{ args: ['{model}', '{prompt}'] }, 'math_cli_prompt_binding_invalid'],
    [{ args: ['{model}', '{unknown}'] }, 'math_cli_placeholder_unsupported'],
    [{ args: ['{model}', '{sessionId}'] }, 'math_cli_resume_binding_invalid'],
    [{ output: { format: 'json', usage: { inputTokens: '/input', outputTokens: '/output', scope: 'session' } } }, 'math_cli_usage_scope_invalid'],
    [{ environment: { TMPDIR: 'override' } }, 'math_cli_runtime_environment_reserved'],
    [{ inheritEnvironment: ['PATH'] }, 'math_cli_runtime_environment_reserved'],
    [{ environment: { THEOREMOS_PRIVATE: 'override' } }, 'math_cli_runtime_environment_reserved'],
    [{ configurationFiles: ['../outside.json'] }, 'math_cli_configuration_path_invalid'],
  ])('rejects an unusable launch contract %j', (overrides, reason) => {
    const f = fixture(overrides); expect(() => readCliConfiguration(f.profile)).toThrow(reason);
  });

  it('requires model, effort and prompt bindings on both initial and resumed commands', () => {
    const f = fixture({ args: [], prompt: 'argument', efforts: ['high'],
      session: { mode: 'generated', startArgs: ['{sessionId}'], resumeArgs: ['{sessionId}', '{model}', '{effort}', '{prompt}'] } });
    expect(() => readCliConfiguration(f.profile)).toThrow('math_cli_model_binding_missing');
    f.config.args = ['{model}']; f.write(f.config);
    expect(() => readCliConfiguration(f.profile)).toThrow('math_cli_effort_binding_missing');
    f.config.args = ['{model}', '{effort}']; f.write(f.config);
    expect(() => readCliConfiguration(f.profile)).toThrow('math_cli_prompt_binding_invalid');
    f.config.args = ['{model}', '{effort}', '{prompt}']; f.write(f.config);
    expect(readCliConfiguration(f.profile).session.mode).toBe('generated');
  });

  it('requires an exact saved ID for reported-session resume', () => {
    const f = fixture({ session: { mode: 'reported', startArgs: [], resumeArgs: ['--resume', 'latest'] },
      output: { format: 'jsonl', sessionId: { field: '/id' } } });
    expect(() => readCliConfiguration(f.profile)).toThrow('math_cli_resume_binding_invalid');
    f.write({ ...f.config, session: { mode: 'reported', startArgs: [], resumeArgs: ['--resume', '{sessionId}'] } });
    expect(readCliConfiguration(f.profile).session.mode).toBe('reported');
  });

  it('uses only declared JSON pointers and conjunctive event filters', () => {
    const value = { type: 'result', status: 'error', 'a/b': { '~value': [7] } };
    expect(cliFieldValue(value, '/a~1b/~0value/0')).toBe(7);
    expect(cliFieldValue(value, '/toString')).toBeUndefined();
    const rule = { when: [{ field: '/type', value: 'result' }, { field: '/status', value: 'error' }] };
    expect(cliFieldMatches(value, rule)).toBe(true);
    expect(cliFieldMatches({ type: 'tool_result', status: 'error' }, rule)).toBe(false);
    expect(cliFieldMatches({ type: 'result', status: 'success' }, rule)).toBe(false);
    const f = fixture({ output: { format: 'jsonl', failures: [{ ...rule, reason: 'request' }] } });
    expect(readCliConfiguration(f.profile).output.format).toBe('jsonl');
  });

  it('preserves shell metacharacters and does not recursively substitute prompt content', () => {
    const prompt = 'spaces\n$(touch /never) `literal` {model}';
    expect(expandCliTemplate('{prompt}', { model: 'selected', effort: 'none', profile: '/profile', workspace: '/work',
      prompt, promptFile: '/prompt', sessionId: 'id', turnId: 'turn' })).toBe(prompt);
    const f = fixture({ args: ['--model', '{model}', '--json', '{"allowed":true}'] });
    expect(() => readCliConfiguration(f.profile)).not.toThrow();
  });

  it('pins command, declared configuration files and endpoint values while allowing session data and key rotation', () => {
    const f = fixture({ configurationFiles: ['settings.json'], inheritEnvironment: ['RESEARCH_ENDPOINT', 'RESEARCH_API_KEY'] });
    fs.writeFileSync(path.join(f.profile, 'settings.json'), '{}');
    const env = { RESEARCH_ENDPOINT: 'http://127.0.0.1:1', RESEARCH_API_KEY: 'fixture-secret', UNRELATED_SECRET: 'unused' };
    const binding = bindResearchHarness('cli', f.executable, f.profile, env);
    expect(researchHarnessEnvironment('cli', env, { profile: f.profile, model: 'fixture' }))
      .toEqual({ RESEARCH_ENDPOINT: env.RESEARCH_ENDPOINT, RESEARCH_API_KEY: env.RESEARCH_API_KEY });
    expect(JSON.stringify(binding)).not.toContain('fixture-secret');
    fs.writeFileSync(path.join(f.profile, 'session.json'), '{"turn":2}');
    expect(() => assertResearchHarnessCurrent(binding, { ...env, RESEARCH_API_KEY: 'rotated' })).not.toThrow();
    expect(() => assertResearchHarnessCurrent(binding, { ...env, RESEARCH_ENDPOINT: 'http://127.0.0.1:2' }))
      .toThrow('math_harness_identity_changed');
    fs.writeFileSync(path.join(f.profile, 'settings.json'), '{"different":true}');
    expect(() => assertResearchHarnessCurrent(binding, env)).toThrow('math_harness_identity_changed');
    fs.writeFileSync(path.join(f.profile, 'settings.json'), '{}');
    fs.appendFileSync(f.executable, '# changed\n');
    expect(() => assertResearchHarnessCurrent(binding, env)).toThrow('math_harness_identity_changed');
  });

  it('rejects malformed and unknown configuration without disclosing its contents', () => {
    const f = fixture({ unknown: 'private-value' });
    expect(() => readCliConfiguration(f.profile)).toThrow(/^math_cli_configuration_invalid$/);
    fs.writeFileSync(path.join(f.profile, 'cli.json'), '{"secret":"private-value"');
    expect(() => readCliConfiguration(f.profile)).toThrow(/^math_cli_configuration_invalid$/);
  });
});
