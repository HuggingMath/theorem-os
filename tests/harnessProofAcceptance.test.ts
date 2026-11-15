import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_EXAMPLE_FAILED_PROOF, LOCAL_EXAMPLE_PROOF, LOCAL_EXAMPLE_STATEMENT } from '../src/math/localExample';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { researchHarness } from '../src/runtime/researchHarness';
import { directSolverModules } from '../src/solver/modules';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';
import { runResearchWorkers } from '../src/solver/research';
import { leadWorker, localExample, solverState } from './helpers/solver';

// Only the unrelated build receipt is a double. Native processes, filesystem isolation,
// writer shutdown, source freezing, helper checks and all original-target checks are real.
vi.mock('../src/math/mathBuildManifest', async original => ({
  ...await original<typeof import('../src/math/mathBuildManifest')>(), readMathBuildManifest: vi.fn(),
}));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('portable native research retains independent real Lean acceptance', () => {
  it.each(['claude-code', 'opencode', 'cli'] as const)('checks whole candidates and reusable helpers from %s', async harnessId => {
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    if (!fs.existsSync(path.join(toolchain, 'bin/lean'))) throw new Error('Real Lean 4.33.0 is required.');
    for (const mode of ['valid', 'invalid', 'helper'] as const) {
      const example = localExample('portable-native-proof-'); roots.push(example.directory);
      const { workspace, problem, directory } = example;
      const profile = path.join(directory, 'profile'); fs.mkdirSync(profile);
      if (harnessId === 'opencode') fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: {
        fixture: { npm: '@ai-sdk/openai-compatible', models: { model: { name: 'Fixture', variants: { high: {} } } } },
      } }));
      const source = mode === 'valid' ? LOCAL_EXAMPLE_PROOF : mode === 'invalid' ? LOCAL_EXAMPLE_FAILED_PROOF :
        LOCAL_EXAMPLE_STATEMENT.replace('end Tutorial', 'theorem reusable_helper : True := by trivial\nend Tutorial');
      if (harnessId === 'cli') fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify({
        schema: 'theorem-os.cli-harness.v1', executable: 'unused-override', args: ['--model', '{model}', '--effort', '{effort}'],
        efforts: ['high'], output: { format: 'json', usage: { inputTokens: '/input', outputTokens: '/output', completeness: 'complete' } },
      }));
      const peer = path.join(repository, 'tests/fixtures', harnessId === 'claude-code' ? 'claudeCodeProtocolPeer.cjs' : 'openCodeNativePeer.mjs');
      const executable = path.join(directory, harnessId === 'opencode' ? 'peer.mjs' : 'peer.cjs');
      const write = `fs.writeFileSync(${JSON.stringify(path.join(workspace, problem.projectRelative, 'Submission.lean'))}, ${JSON.stringify(source)});\n` +
        (mode === 'helper' ? `fs.writeFileSync(${JSON.stringify(path.join(workspace, '.scratch/declaration-submission.json'))},` +
          `${JSON.stringify(JSON.stringify({ declarations: [{ file: 'Submission.lean', name: 'Tutorial.reusable_helper', type: 'True' }] }))});\n` : '');
      fs.writeFileSync(executable, '#!/usr/bin/env node\n' + (harnessId === 'cli'
        ? `const fs=require('node:fs'); fs.readFileSync(0,'utf8');\n${write}process.stdout.write(JSON.stringify({input:11,output:5}));\n`
        : harnessId === 'claude-code'
        ? `const fs=require('node:fs');\n${write}require(${JSON.stringify(peer)});\n`
        : `import fs from 'node:fs';\n${write}await import(${JSON.stringify(peer)});\n`), { mode: 0o700 });
      const researchSkill = researchSkillIdentity(readMathAgentSkill(path.join(repository, 'skills/theoremos-research/SKILL.md'), 'file'));
      const skill = prepareResearchSkill(repository, workspace, researchSkill, problem);
      const state = solverState(problem, workspace, { runId: 'native-acceptance-' + mode,
        environmentDigest: mathDigest('isolated-native-acceptance'), model: harnessId === 'claude-code' ? 'claude-fixture' : 'fixture/model',
        effort: 'high', phase: 'running', researchMode: 'skill', researchSkill });
      const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`, ELAN_HOME: path.join(os.homedir(), '.elan'),
        LEAN_PATH: '', LEAN_SYSROOT: '', DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap',
        DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'absent.env') };
      const events: string[] = [];
      const winner = await runResearchWorkers({ state, workers: [leadWorker(problem, workspace)],
        access: new Map([['solver', { environment, researchSkill: skill, retrievalRoot: workspace,
          ...(harnessId === 'cli' ? { nativeContinuity: false } : {}) }]]),
        modules: { ...directSolverModules, M1: { ...directSolverModules.M1, open: researchHarness(harnessId).open } },
        root: repository, buildFile: path.join(directory, 'unused-build.json'), taskText: 'Check the frozen tutorial statements.',
        executable, profile, signal: new AbortController().signal, deadline: Infinity,
        maxTurns: 1, maxTurnMs: Infinity, maxTotalTokens: 1000, proofTimeoutMs: 30_000,
        save: () => {}, emit: event => { events.push(event); } });
      expect(state.usage!.totalTokens).toBe(harnessId === 'cli' ? 16 : harnessId === 'claude-code' ? 36 : 32);
      expect(state.writerStopUnconfirmed).toBeUndefined();
      if (mode === 'valid') {
        expect(winner?.check.passed).toBe(true);
        expect(winner!.check.verification.results).toHaveLength(problem.targets.length);
        expect(winner!.check.verification.results.every(result => result.status === 'kernel_verified')).toBe(true);
      } else {
        expect(winner).toBeUndefined(); expect(state.check?.passed).not.toBe(true);
        if (mode === 'invalid') expect(state.check?.verification.status).toBe('failed');
        else {
          expect(events).toContain('declarations_checked');
          const records = JSON.parse(fs.readFileSync(path.join(directory, 'declarations.json'), 'utf8'));
          expect(records.artifacts).toHaveLength(1);
          expect(records.artifacts[0].declaration.name).toBe('Tutorial.reusable_helper');
          expect(records.artifacts[0].proof.verification.results[0].status).toBe('kernel_verified');
        }
      }
    }
  }, 90_000);
});
