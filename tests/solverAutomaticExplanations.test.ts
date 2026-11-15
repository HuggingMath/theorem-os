import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { INFORMALIZATION_ALIGNMENT, INFORMALIZATION_EXPLANATION_POLICY, INFORMALIZATION_OUTLINE_POLICY,
  readInformalizationRequest } from '../src/math/informalization';
import { generateSolverExplanations, type SolverExplanations } from '../src/solver/automaticExplanations';
import type { SolverProblem } from '../src/solver/problem';
import { informalizationFixture, PROOF_SOURCE, presetAuthor } from './helpers/informalizationFixture';

const forbidden = vi.hoisted(() => ({ model: vi.fn(() => { throw new Error('model_must_not_open'); }) }));
vi.mock('../src/runtime/codexSession', async original => ({
  ...await original<typeof import('../src/runtime/codexSession')>(), createCodexMathSession: forbidden.model,
}));
const roots: string[] = [];
afterEach(() => {
  expect(forbidden.model).not.toHaveBeenCalled();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function fixture() {
  const f = informalizationFixture(roots);
  const environment = getLeanTaskEnvironment('standard');
  for (const [name, text] of Object.entries(environment.files)) fs.writeFileSync(path.join(f.project, name), text);
  const problem = { kind: 'example', projectRelative: 'project', contract: { informalStatement: 'Prove the two original targets.' },
    targets: ['double_eq', 'double_add_zero'].map(theoremName => ({ theoremName, proofPath: 'Proof.lean', declarationHash: 'unused' })) } as SolverProblem;
  const input = { problem, worktree: f.base, directory: path.join(f.base, 'accepted-run.runtime'), root: f.root,
    buildManifest: f.preparation.buildManifestRef, language: 'zh' as const, writer: presetAuthor };
  const run = vi.fn(async (directory: string) => ({ status: 'approved' as const, directory,
    artifact: path.join(directory, 'artifact'), proof: path.join(directory, 'artifact', 'proof.md'),
    batches: 1, approvedBatches: 1, rounds: 1, modelInvoked: false, tokenBudget: {} as never }));
  return { ...f, input, run };
}

describe('automatic solver explanations', () => {
  it('prepares every original target from the accepted proof, with audited step and outline policies', async () => {
    const f = fixture(), progress: unknown[] = [];
    const result = await generateSolverExplanations({ ...f.input, onUpdate: summary => progress.push(structuredClone(summary)) }, { run: f.run });
    expect(result.status).toBe('approved');
    expect(result.targets.map(item => item.target)).toEqual(['double_eq', 'double_add_zero']);
    expect(f.run).toHaveBeenCalledTimes(2);
    for (const item of result.targets) {
      const { request, sources } = readInformalizationRequest(item.directory);
      expect(request).toMatchObject({ target: item.target, language: 'zh', environment: 'standard', writer: presetAuthor,
        alignment: INFORMALIZATION_ALIGNMENT, explanationPolicy: INFORMALIZATION_EXPLANATION_POLICY,
        outlinePolicy: INFORMALIZATION_OUTLINE_POLICY, auditors: [{ id: 'auditor-1' }, { id: 'auditor-2' }] });
      expect(sources.map(source => source.module)).toEqual(['Lib', 'Proof']);
      expect(sources.at(-1)?.text).toBe(PROOF_SOURCE);
      expect(item.proof).toBe(path.join(item.directory, 'artifact/proof.md'));
    }
    expect(progress[0]).toMatchObject({ status: 'running', targets: [{ status: 'pending' }, { status: 'pending' }] });
    expect(progress.at(-1)).toMatchObject({ status: 'approved' });
  });

  it('continues with other targets after an error and records only the reason code', async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error('informalization_role_incomplete: provider detail and secret'));
    const result = await generateSolverExplanations(f.input, { run: f.run });
    expect(result).toMatchObject({ status: 'partial', targets: [
      { status: 'error', reason: 'informalization_role_incomplete' }, { status: 'approved' },
    ] });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('reuses each frozen request on resume and keeps the same explanation directories', async () => {
    const f = fixture();
    f.run.mockResolvedValueOnce({ status: 'stopped' } as never);
    const first = await generateSolverExplanations(f.input, { run: f.run });
    const requests = first.targets.map(item => fs.statSync(path.join(item.directory, 'request.json')).mtimeMs);
    const second = await generateSolverExplanations(f.input, { run: f.run });
    expect(second.status).toBe('approved');
    expect(second.targets.map(item => item.directory)).toEqual(first.targets.map(item => item.directory));
    expect(second.targets.map(item => fs.statSync(path.join(item.directory, 'request.json')).mtimeMs)).toEqual(requests);
  });

  it('refuses to reuse explanations when an imported proof source changed', async () => {
    const f = fixture();
    await generateSolverExplanations(f.input, { run: f.run });
    f.run.mockClear();
    fs.appendFileSync(path.join(f.project, 'Lib.lean'), '\n-- changed after acceptance\n');
    const result = await generateSolverExplanations(f.input, { run: f.run });
    expect(result.status).toBe('error');
    expect(result.targets.every(item => item.reason === 'informalization_resume_identity_changed')).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('stops pending targets without preparing or invoking a model after cancellation', async () => {
    const f = fixture(), controller = new AbortController(); controller.abort();
    const updates: SolverExplanations[] = [];
    const result = await generateSolverExplanations({ ...f.input, signal: controller.signal,
      onUpdate: summary => updates.push(structuredClone(summary)) }, { run: f.run });
    expect(result.status).toBe('stopped');
    expect(result.targets.every(item => item.status === 'stopped')).toBe(true);
    expect(fs.existsSync(result.directory)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
    expect(updates.at(-1)?.status).toBe('stopped');
  });

  it('records an unsupported proof environment rather than changing its toolchain', async () => {
    const f = fixture();
    fs.writeFileSync(path.join(f.project, 'lean-toolchain'), 'leanprover/lean4:unsupported-fixture');
    const result = await generateSolverExplanations(f.input, { run: f.run });
    expect(result.status).toBe('error');
    expect(result.targets.every(item => item.reason === 'informalization_environment_unsupported')).toBe(true);
    expect(f.run).not.toHaveBeenCalled();
  });

  it('freezes the matching pinned Mathlib environment and requested language', async () => {
    const f = fixture(), environment = getLeanTaskEnvironment('openai-math');
    for (const [name, text] of Object.entries(environment.files)) fs.writeFileSync(path.join(f.project, name), text);
    const result = await generateSolverExplanations({ ...f.input, language: 'en' }, { run: f.run });
    expect(result).toMatchObject({ status: 'approved', language: 'en' });
    for (const target of result.targets) expect(readInformalizationRequest(target.directory).request)
      .toMatchObject({ environment: 'openai-math', toolchain: environment.toolchain,
        mathlibRevision: environment.mathlibRevision, language: 'en' });
  });
});
