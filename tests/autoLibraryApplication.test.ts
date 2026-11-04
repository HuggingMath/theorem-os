import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { checkAutoLibraryApplication } from '../src/solver/autoLibraryApplication';
import * as diagnostics from '../src/math/leanTypeDiagnostics';
import { LIBRARY_PACK_SCHEMA } from '../src/math/libraryPacks';
import { temporaryDirectory } from './helpers/files';

let directory: string;
beforeEach(() => { directory = temporaryDirectory('library-application-'); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }); });
const selected = { declaration: 'TheoremOS.Auto.Truth.truth', application: { expression: 'TheoremOS.Auto.Truth.truth',
  expectedType: 'True', context: { file: 'Submission.lean', declaration: 'target' }, remainingGoals: ['Prove the other original target'] } };
const input = () => ({ workspace: path.join(directory, 'consumer'), source: 'theorem target : True := by sorry\n',
  environment: 'standard' as const, moduleName: 'Truth', selected, env: {}, prepare: vi.fn(async () => {}),
  pack: { schema: LIBRARY_PACK_SCHEMA, modules: [{ file: 'Submission/Library/Auto/Truth.lean',
    source: 'namespace TheoremOS.Auto.Truth\ntheorem truth : True := trivial\nend TheoremOS.Auto.Truth\n',
    origin: { kind: 'run' as const, runId: 'fixture', commit: 'a'.repeat(40), file: 'Submission.lean' } }] } });

it.each(['selected-theorem', 'other-theorem', 'wrong-type'] as const)(
  'separates module verification from consumer application for %s', outcome => {
    const result = { status: outcome === 'wrong-type' ? 'failed' : 'elaborated', exitCode: outcome === 'wrong-type' ? 1 : 0,
      timedOut: false, constants: outcome === 'other-theorem' ? ['True.intro'] : [selected.declaration],
      sourceSnapshotDigest: 'source', projectionDigest: 'projection', sourceFiles: [],
      environment: { environmentDigest: 'environment', toolIdentity: 'lean' }, artifact: { path: 'artifact.json', digest: 'artifact' },
      type: 'True', stdout: '', stderr: 'type mismatch' } as Awaited<ReturnType<typeof diagnostics.checkLeanType>>;
    const check = vi.spyOn(diagnostics, 'checkLeanType').mockResolvedValue(result);
    const request = { ...input(), signal: new AbortController().signal };
    return checkAutoLibraryApplication(request).then(checked => {
      expect(request.prepare).toHaveBeenCalledOnce();
      expect(check).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: Infinity, signal: request.signal }));
      expect(checked.check).toMatchObject({ status: outcome === 'wrong-type' ? 'failed' : 'elaborated',
        authority: 'advisory-application-elaboration', proofAcceptance: 'not-assessed', consumerCoverage: 'not-assessed' });
      if (outcome !== 'wrong-type') expect(checked.check.selectedDeclarationUsed).toBe(outcome === 'selected-theorem');
      expect(checked.application.remainingGoals).toEqual(['Prove the other original target']);
      expect(fs.readFileSync(path.join(request.workspace, 'workspace/generated/problem/Submission.lean'), 'utf8'))
        .toContain('theorem target : True := by sorry');
    });
  });

it('reports an unavailable consumer environment separately without claiming application success', async () => {
  const request = input(); request.prepare.mockRejectedValue(new Error('fixture_environment_unavailable'));
  const check = vi.spyOn(diagnostics, 'checkLeanType');
  expect(await checkAutoLibraryApplication(request)).toMatchObject({ check: {
    status: 'unavailable', reason: 'fixture_environment_unavailable', proofAcceptance: 'not-assessed',
  } });
  expect(check).not.toHaveBeenCalled();
});

it('keeps an original definition target in the independent consumer snapshot', async () => {
  const request = { ...input(), source: 'def witness : True := by sorry\n', definitionTargets: ['witness'],
    selected: { ...selected, application: { ...selected.application, context: { file: 'Submission.lean', declaration: 'witness' } } } };
  request.prepare.mockRejectedValue(new Error('fixture_stop_after_bootstrap'));
  expect(await checkAutoLibraryApplication(request)).toMatchObject({ check: { reason: 'fixture_stop_after_bootstrap' } });
  const receipt = JSON.parse(fs.readFileSync(path.join(request.workspace, 'workspace/active-problem.json'), 'utf8'));
  expect(receipt.publicObligations).toEqual([expect.objectContaining({ name: 'witness' })]);
});

it('propagates cancellation during preparation before starting an application diagnostic', async () => {
  const controller = new AbortController(), request = { ...input(), signal: controller.signal };
  request.prepare.mockImplementation(async () => { controller.abort(); });
  const check = vi.spyOn(diagnostics, 'checkLeanType');
  await expect(checkAutoLibraryApplication(request)).rejects.toMatchObject({ name: 'AbortError' });
  expect(check).not.toHaveBeenCalled();
});
