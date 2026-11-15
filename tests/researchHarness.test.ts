import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertResearchHarnessCurrent, bindResearchHarness, researchHarness, researchHarnessEnvironment } from '../src/runtime/researchHarness';
import { resolveMathematicsRuntimeEnvironment } from '../src/math/mathRuntimeEnvironment';
import { temporaryDirectory } from './helpers/files';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
describe('research harness launch identity and execution-only configuration', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('pins %s executable and configuration while allowing native session files to grow', id => {
    const root = temporaryDirectory('research-harness-'); roots.push(root);
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const executable = path.join(root, 'native'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    const file = path.join(profile, id === 'codex' ? 'config.toml' : id === 'claude-code' ? 'settings.json' : 'opencode.json');
    fs.writeFileSync(file, id === 'codex' ? 'model = "fixture"\n' : '{}');
    const env = { PATH: root, ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' };
    const binding = bindResearchHarness(id, 'native', profile, env);
    fs.writeFileSync(path.join(profile, 'native-session.json'), '{"turn":2}');
    expect(() => assertResearchHarnessCurrent(binding, env)).not.toThrow();
    fs.appendFileSync(file, '\n'); expect(() => assertResearchHarnessCurrent(binding, env)).toThrow('math_harness_identity_changed');
    expect(researchHarness(id).nativeSkills).toBe(id === 'codex');
  });

  it('passes only selected native credentials and keeps host Lean environments free of them', () => {
    const source = { ANTHROPIC_API_KEY: 'anthropic-fixture-key', OPENAI_API_KEY: 'openai-fixture-key',
      UNRELATED_SECRET: 'private', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' };
    const claude = researchHarnessEnvironment('claude-code', source);
    expect(claude).toEqual({ ANTHROPIC_API_KEY: source.ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL });
    expect(researchHarnessEnvironment('opencode', source).OPENAI_API_KEY).toBe(source.OPENAI_API_KEY);
    const environment = resolveMathematicsRuntimeEnvironment({ ...source, DEEPSCIENTIST_MATH_ENV_FILE: '/absent-native-test.env' });
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined(); expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(() => researchHarness('unimplemented')).toThrow('invalid --harness');
  });

  it('pins custom OpenCode endpoint references and passes explicitly referenced authentication without freezing rotated keys', () => {
    const root = temporaryDirectory('research-harness-environment-'); roots.push(root);
    const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
    const executable = path.join(root, 'native'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: {
      selected: { options: { baseURL: '{env:RESEARCH_ENDPOINT}', apiKey: '{env:RESEARCH_API_KEY}' } },
      unused: { options: { apiKey: '{env:UNRELATED_API_KEY}' } },
    } }));
    const source = { RESEARCH_ENDPOINT: 'http://127.0.0.1:1', RESEARCH_API_KEY: 'fixture-key', UNRELATED_API_KEY: 'unselected' };
    const binding = bindResearchHarness('opencode', executable, profile, source, 'selected/model');
    const environment = researchHarnessEnvironment('opencode', source, { profile, model: 'selected/model' });
    expect(environment).toEqual({ RESEARCH_ENDPOINT: source.RESEARCH_ENDPOINT, RESEARCH_API_KEY: source.RESEARCH_API_KEY });
    expect(() => assertResearchHarnessCurrent(binding, { ...environment, RESEARCH_API_KEY: 'rotated' }, 'selected/model')).not.toThrow();
    expect(() => assertResearchHarnessCurrent(binding, { ...environment, RESEARCH_ENDPOINT: 'http://127.0.0.1:2' }, 'selected/model'))
      .toThrow('math_harness_identity_changed');
    fs.writeFileSync(path.join(profile, 'opencode.json'), '{"provider":{"selected":{"options":{"baseURL":"{file:endpoint}"}}}}');
    expect(() => bindResearchHarness('opencode', executable, profile, source, 'selected/model'))
      .toThrow('math_opencode_file_configuration_unsupported');
  });
});
