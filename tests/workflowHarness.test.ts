import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { temporaryDirectory } from './helpers/files';
import { bindResearchHarness } from '../src/runtime/researchHarness';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/agentSession';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { formalizationModelConfigurationDigest, formalizationModelConfigurationSchema } from '../src/math/formalizationWorkflow';
import { assertWorkflowSessionSupported, openWorkflowSession, workflowProfileFiles } from '../src/solver/workflowSession';
import { withWorkflowHarness } from '../scripts/mathematics/workflowHarness';

const model = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../src/runtime/codexSession', async original => ({
  ...await original<typeof import('../src/runtime/codexSession')>(), createCodexMathSession: model.open,
}));
vi.mock('../src/runtime/claudeCodeSession', () => ({ createClaudeCodeMathSession: model.open }));
vi.mock('../src/runtime/openCodeSession', () => ({ createOpenCodeMathSession: model.open }));
vi.mock('../src/runtime/cliSession', () => ({ createCliMathSession: model.open }));
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => { model.open.mockReset(); });
function fixture() {
  const root = temporaryDirectory('workflow-harness-'); roots.push(root);
  const profile = path.join(root, 'profile'); fs.mkdirSync(profile);
  const executable = path.join(root, 'native'); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'config.toml'), 'model = "fixture"\n');
  const config = { model: 'fixture', effort: 'high', profile, executable };
  const bound = { ...config, agentHarness: bindResearchHarness('codex', executable, profile) };
  const workspace = path.join(root, 'role'); fs.mkdirSync(workspace);
  const options: MathAgentOptions = { ...config, workspace, instructions: 'Read the sealed task.',
    readIsolation: { environment: 'standard' }, onUsage: () => {} };
  return { root, config, bound, options };
}
function native(): MathAgentSession {
  return { threadId: 'native-fixture', run: vi.fn(async () => 'completed'), close: vi.fn(async () => {}), interrupt: vi.fn(async () => {}) };
}

describe('complete workflow harness selection', () => {
  it('keeps historical configuration digests and does not bind default CLI selections', () => {
    const f = fixture();
    expect(formalizationModelConfigurationDigest(f.config)).toBe(mathDigest(canonicalMathJson(f.config)));
    expect(withWorkflowHarness(new Map(), f.config, { environment: 'standard' })).toBe(f.config);
    expect(workflowProfileFiles(f.config, () => ['legacy-model-catalog'], {})).toEqual(['legacy-model-catalog']);
    expect(formalizationModelConfigurationSchema.parse(f.bound)).toEqual(f.bound);
    expect(formalizationModelConfigurationDigest(f.bound)).not.toBe(formalizationModelConfigurationDigest(f.config));
  });

  it.each(['claude-code', 'opencode', 'cli'] as const)('dispatches %s sealed roles through the frozen production binding', async id => {
    const f = fixture();
    fs.writeFileSync(path.join(f.config.profile, 'settings.json'), '{}');
    fs.writeFileSync(path.join(f.config.profile, 'opencode.json'), '{"provider":{"fixture":{}}}');
    fs.writeFileSync(path.join(f.config.profile, 'cli.json'), JSON.stringify({ schema: 'theorem-os.cli-harness.v1',
      executable: f.config.executable, args: ['--model', '{model}', '--effort', '{effort}'], efforts: ['high'],
      sealedRole: { provider: { wireApi: 'responses', baseUrl: 'https://example.com/v1', apiKeyEnvironment: 'FIXTURE_API_KEY' },
        client: { baseUrlEnvironment: 'OPENAI_BASE_URL', apiKeyEnvironment: 'OPENAI_API_KEY' } } }));
    const bound = { ...f.config, agentHarness: bindResearchHarness(id, f.config.executable, f.config.profile) };
    expect(() => assertWorkflowSessionSupported(bound, { environment: 'standard' })).not.toThrow();
    const flags = new Map([['harness', id], ['model', 'fixture'], ['harness-profile', f.config.profile], ['harness-executable', f.config.executable]]);
    expect(withWorkflowHarness(flags, f.config, { environment: 'standard' }).agentHarness).toEqual(bound.agentHarness);
    model.open.mockResolvedValue(native());
    const session = await openWorkflowSession(bound, f.options);
    expect(model.open).toHaveBeenCalledOnce(); await session.close();
  });

  it('uses the production adapter for an explicit Codex binding and checks identity before every dispatch and after closing', async () => {
    const f = fixture(), backend = native(), dispatch = backend.run, close = backend.close;
    model.open.mockResolvedValue(backend);
    const selected = withWorkflowHarness(new Map([['harness', 'codex']]), f.config, { environment: 'standard' });
    expect(selected.agentHarness).toEqual(f.bound.agentHarness);
    const session = await openWorkflowSession(selected, f.options);
    expect(model.open).toHaveBeenCalledOnce();
    await session.run('task', 'message', f.options.workspace, () => {});
    expect(dispatch).toHaveBeenCalledOnce();
    fs.appendFileSync(path.join(f.config.profile, 'config.toml'), '\n');
    await expect(session.run('task', 'message-2', f.options.workspace, () => {})).rejects.toThrow('math_harness_identity_changed');
    expect(dispatch).toHaveBeenCalledOnce();
    await expect(session.close()).rejects.toThrow('math_harness_identity_changed');
    expect(close).toHaveBeenCalledOnce();
  });

  it('detects changed executable bytes before native creation and rejects a mismatched role configuration', async () => {
    const f = fixture();
    fs.appendFileSync(f.config.executable, '# changed\n');
    await expect(openWorkflowSession(f.bound, f.options)).rejects.toThrow('math_harness_identity_changed');
    expect(model.open).not.toHaveBeenCalled();
    expect(() => assertWorkflowSessionSupported({ ...f.bound, profile: f.root }, { environment: 'standard' }))
      .toThrow('math_workflow_harness_binding_mismatch');
  });

  it('retains legacy Codex profile observations alongside explicit harness identity', () => {
    const f = fixture();
    const catalog = path.join(f.config.profile, 'models.json'); fs.writeFileSync(catalog, '{"model":"first"}');
    const observe = () => workflowProfileFiles(f.bound, () => fs.readFileSync(catalog, 'utf8'), {});
    const previous = observe(); fs.writeFileSync(catalog, '{"model":"second"}');
    expect(observe()).not.toEqual(previous);
  });

  it('keeps preset injection distinct from a frozen production harness', async () => {
    const f = fixture(), preset = native(), injected = vi.fn(async () => preset);
    expect(await openWorkflowSession(f.config, f.options, injected)).toBe(preset);
    await expect(openWorkflowSession(f.bound, f.options, injected)).rejects.toThrow('math_workflow_harness_injection_conflict');
    expect(injected).toHaveBeenCalledOnce(); expect(model.open).not.toHaveBeenCalled();
  });
});
