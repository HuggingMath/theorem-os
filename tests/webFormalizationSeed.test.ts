import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { webDefaults } from '../apps/web/config';
import type { WebRunInput } from '../apps/web/shared';
import { formalizationDigest, readFormalizationArtifact, type FormalizationEvidence } from '../src/math/formalization';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { readSolverProblem } from '../src/solver/problem';
import { approvedFormalization } from './helpers/approvedFormalizationFixture';

describe('confirmed formalization handoff to a frozen proof problem', () => {
  const roots: string[] = [], id = crypto.randomUUID();
  let evidence: FormalizationEvidence;
  const directory = () => {
    const value = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'web-formalization-seed-')));
    roots.push(value); return value;
  };
  const input = (): WebRunInput => ({ ...webDefaults, providerId: 'sub2api', apiKey: 'sk-fixture-never-used',
    source: evidence.candidate.source, environment: evidence.request.environment, formalizationId: id,
    task: 'Explain the induction steps clearly.\nKeep the original goal intact.' });

  beforeAll(async () => {
    const original = await approvedFormalization(roots, id);
    evidence = readFormalizationArtifact(path.join(original, 'artifact'));
    // The preceding disposable worker and its build/profile paths no longer exist at handoff.
    fs.rmSync(path.dirname(original), { recursive: true, force: true });
  });
  afterAll(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

  it('reconstructs the exact approved original and evidence identity in another container directory', () => {
    const destination = directory(), request = input();
    const seed = prepareWebProblem(destination, { input: request, formalization: evidence });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath);
    const task = fs.readFileSync(seed.taskFile, 'utf8');
    const restored = readFormalizationArtifact(path.join(destination, 'formalized/artifact'));
    expect(restored).toEqual(evidence);
    expect(formalizationDigest(restored)).toBe(formalizationDigest(evidence));
    expect(receipt.workspaceRoot).toBe(seed.workspaceRoot);
    expect(receipt.environment).toBe(evidence.request.environment);
    expect(receipt.environmentDigest).toBe(evidence.request.environmentDigest);
    expect(receipt.contract.formalStatement).toBe(evidence.candidate.source);
    expect(receipt.contract.informalStatement).toContain('Original SHA256: ' + evidence.request.statementSha256);
    expect(receipt.contract.informalStatement).toContain('Formalization evidence SHA256: ' + formalizationDigest(evidence));
    expect(task).toContain('Original problem (verbatim):\n\n' + evidence.request.statement + '\n');
    expect(task).toContain('Additional research instructions:\n' + request.task + '\n');
    expect(receipt.contract.informalStatement).not.toContain(request.task);
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    expect(problem.contract.formalStatement).toBe(evidence.candidate.source);
    expect(problem.targets.map(target => target.theoremName)).toEqual(evidence.targets.map(target => target.name));
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(evidence.candidate.source);
  });

  it.each(['source', 'environment', 'id'] as const)('refuses a changed %s before creating a solver workspace', field => {
    const destination = directory(), request = input();
    if (field === 'source') request.source += '\n-- edited';
    else if (field === 'environment') request.environment = 'mathlib';
    else request.formalizationId = crypto.randomUUID();
    expect(() => prepareWebProblem(destination, { input: request, formalization: evidence })).toThrow('formalization_binding_changed');
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it('requires both the confirmed identifier and trusted evidence', () => {
    expect(() => prepareWebProblem(directory(), { input: input() })).toThrow('formalization_binding_missing');
    const request = input(); delete request.formalizationId;
    expect(() => prepareWebProblem(directory(), { input: request, formalization: evidence })).toThrow('formalization_binding_missing');
  });

  it('revalidates evidence before freezing a new proof problem', () => {
    const changed = structuredClone(evidence);
    changed.translation.mathematics = 'Changed after confirmation';
    const destination = directory();
    expect(() => prepareWebProblem(destination, { input: input(), formalization: changed })).toThrow();
    expect(fs.existsSync(path.join(destination, 'formalized/workspace'))).toBe(false);
  });

  it('preserves ordinary Lean bootstrap behavior without a formalization binding', () => {
    const destination = directory(), request = input(); delete request.formalizationId;
    const seed = prepareWebProblem(destination, { input: request });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath);
    expect(seed.workspaceRoot).toBe(path.join(destination, 'workspace'));
    expect(receipt.contract.formalStatement).toBe(request.source);
    expect(receipt.contract.informalStatement).toBe(request.task);
    expect(receipt.environment).toBe(request.environment);
    expect(fs.readFileSync(seed.taskFile, 'utf8')).toBe(request.task +
      '\nPreserve all original declarations. Prove every target in generated/problem/Submission.lean.\n');
    expect(fs.existsSync(path.join(destination, 'formalized'))).toBe(false);
  });
});
