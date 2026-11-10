import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareWebProblem } from '../apps/web/formalizationSeed';
import { webDefaults } from '../apps/web/config';
import type { WebRunInput } from '../apps/web/shared';
import { formalizationCompiledCandidate, formalizationCompiledCandidateDigest, formalizationDigest,
  readFormalizationArtifact, type FormalizationEvidence } from '../src/math/formalization';
import { readLeanTaskReceipt } from '../src/math/leanTask';
import { readSolverProblem } from '../src/solver/problem';
import { LIBRARY_PACK_SCHEMA, libraryPackDigest } from '../src/math/libraryPacks';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { defaultResearchModulePlan } from '../src/solver/modules/policy';
import { approvedFormalization } from './helpers/approvedFormalizationFixture';
import { webDirectFormalizationEvidence, webFormalizationStatement } from './helpers/webFormalizationFixture';

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
    changed.candidate.definitionsExplanation = 'Changed after confirmation';
    const destination = directory();
    expect(() => prepareWebProblem(destination, { input: input(), formalization: changed })).toThrow();
    expect(fs.existsSync(path.join(destination, 'formalized/workspace'))).toBe(false);
  });

  it('hands a direct compilation to the same frozen proof targets without claiming semantic review', () => {
    const direct = webDirectFormalizationEvidence({ id, original: webFormalizationStatement, environment: 'standard',
      model: 'gpt-6.1-sol', effort: 'max', apiKey: 'sk-fixture-never-used', reviewMode: 'direct',
      provider: { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
      maxRunSeconds: 0, maxTotalTokens: 0, maxRounds: 0, maxPlanningRounds: 0, reviewers: 2 });
    const request = { ...input(), source: direct.candidate.source, environment: direct.request.environment };
    const destination = directory(), seed = prepareWebProblem(destination, { input: request, formalization: direct });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath), task = fs.readFileSync(seed.taskFile, 'utf8');
    expect(readFormalizationArtifact(path.join(destination, 'formalized/artifact'))).toEqual(direct);
    expect(receipt.contract.formalStatement).toBe(direct.candidate.source);
    expect(task).toContain(direct.request.statement); expect(task).toContain('No independent semantic review was performed');
    expect(readSolverProblem(seed.workspaceRoot, seed.activeProblemPath).targets.map(target => target.theoremName))
      .toEqual(direct.targets.map(target => target.name));
  });

  it('preserves ordinary Lean bootstrap behavior without a formalization binding', () => {
    const destination = directory(), request = input(); delete request.formalizationId;
    const seed = prepareWebProblem(destination, { input: request });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath);
    expect(seed.workspaceRoot).toBe(path.join(destination, 'workspace'));
    expect(receipt.contract.formalStatement).toBe(request.source);
    expect(receipt.contract.informalStatement).toBe(request.task);
    expect(receipt.environment).toBe(request.environment);
    const task = fs.readFileSync(seed.taskFile, 'utf8');
    expect(task).toContain(request.task);
    expect(task).toContain('Overall run objective: prove every original target');
    expect(task).toContain('In cooperative mode, complete only your current assignment');
    expect(task).toContain('preserve other original goal proofs, including existing sorry placeholders');
    expect(task).toContain('the host integrates checked tasks and verifies all targets');
    expect(fs.existsSync(path.join(destination, 'formalized'))).toBe(false);
  });

  it('freezes the compiled candidate and original problem before semantic review without an approved artifact', () => {
    const destination = directory(), request = input(), compiled = formalizationCompiledCandidate(evidence);
    const seed = prepareWebProblem(destination, { input: request, compiledFormalization: compiled });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath), task = fs.readFileSync(seed.taskFile, 'utf8');
    expect(receipt.contract.formalStatement).toBe(compiled.candidate.source);
    expect(receipt.environment).toBe(compiled.request.environment);
    expect(receipt.environmentDigest).toBe(compiled.request.environmentDigest);
    expect(receipt.contract.informalStatement).toContain('Natural-language meaning is still under independent review.');
    expect(receipt.contract.informalStatement).toContain('Original problem:\n' + compiled.request.statement);
    expect(receipt.contract.informalStatement).toContain('Original SHA256: ' + compiled.request.statementSha256);
    expect(receipt.contract.informalStatement).toContain('Compiled candidate SHA256: ' + formalizationCompiledCandidateDigest(compiled));
    expect(receipt.contract.informalStatement).not.toContain('Formalization evidence SHA256:');
    expect(task).toContain(request.task);
    expect(task).toContain(receipt.contract.informalStatement);
    expect(fs.readFileSync(path.join(receipt.projectRoot, 'Submission.lean'), 'utf8')).toBe(compiled.candidate.source);
    expect(readSolverProblem(seed.workspaceRoot, seed.activeProblemPath).targets.map(target => target.theoremName))
      .toEqual(compiled.targets.map(target => target.name));
    const snapshotFile = path.join(destination, 'compiled-formalization.json');
    expect(JSON.parse(fs.readFileSync(snapshotFile, 'utf8'))).toEqual(compiled);
    expect(fs.statSync(snapshotFile).mode & 0o777).toBe(0o400);
    expect(fs.existsSync(path.join(destination, 'formalized'))).toBe(false);
  });

  it.each(['source', 'environment', 'id'] as const)(
    'rejects a compiled %s binding mismatch before creating the proof workspace', field => {
      const destination = directory(), request = input(), compiled = formalizationCompiledCandidate(evidence);
      if (field === 'source') request.source += '\n-- changed';
      else if (field === 'environment') request.environment = 'mathlib';
      else request.formalizationId = crypto.randomUUID();
      expect(() => prepareWebProblem(destination, { input: request, compiledFormalization: compiled }))
        .toThrow('formalization_binding_changed');
      expect(fs.readdirSync(destination)).toEqual([]);
    });

  it('requires a candidate identifier and refuses simultaneous compiled and approved inputs', () => {
    const compiled = formalizationCompiledCandidate(evidence), missingId = input(); delete missingId.formalizationId;
    expect(() => prepareWebProblem(directory(), { input: missingId, compiledFormalization: compiled }))
      .toThrow('formalization_binding_missing');
    expect(() => prepareWebProblem(directory(), { input: input(), formalization: evidence, compiledFormalization: compiled }))
      .toThrow('formalization_binding_missing');
  });

  it('revalidates the compiler receipt before freezing a compiled candidate', () => {
    const destination = directory(), compiled = formalizationCompiledCandidate(evidence);
    compiled.snapshot.targets[0].context.type = 'False';
    compiled.snapshotDigest = formalizationDigest(compiled.snapshot);
    expect(() => prepareWebProblem(destination, { input: input(), compiledFormalization: compiled })).toThrow();
    expect(fs.readdirSync(destination)).toEqual([]);
  });

  it('installs the exact selected Library snapshot into the native worker problem', () => {
    const destination = directory(), request = input(); delete request.formalizationId;
    const file = 'Submission/Library/Pinned.lean', source = 'theorem pinned_fact : True := by trivial\n';
    const libraryPack = { schema: LIBRARY_PACK_SCHEMA, modules: [{ file, source,
      origin: { kind: 'run' as const, runId: 'original-publisher', commit: 'a'.repeat(40), file: 'Shared.lean' } }] };
    request.source = 'import Submission.Library.Pinned\ntheorem consumer : True := by sorry\n';
    const seed = prepareWebProblem(destination, { input: request, researchConfiguration: {
      schema: 'theorem-os.research-configuration.v1', environment: request.environment!,
      modulePlan: defaultResearchModulePlan(), preferences: {}, skills: [], libraries: [], libraryPack,
      digest: mathDigest(JSON.stringify(libraryPack)),
    } });
    const receipt = readLeanTaskReceipt(seed.activeProblemPath);
    expect(fs.readFileSync(path.join(receipt.projectRoot, file), 'utf8')).toBe(source);
    expect(receipt.libraryPack?.digest).toBe(libraryPackDigest(libraryPack));
    expect(receipt.libraryPack?.files[file]).toBe(mathDigest(source));
    const problem = readSolverProblem(seed.workspaceRoot, seed.activeProblemPath);
    expect(problem.frozenFiles[file]).toBe(mathDigest(source));
    expect(problem.targets.map(target => target.theoremName)).toEqual(['consumer']);
  });
});
