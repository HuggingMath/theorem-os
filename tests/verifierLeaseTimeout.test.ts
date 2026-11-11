import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { localExample } from './helpers/solver';
import { commitSolverSources } from '../src/solver/problem';
import { LOCAL_EXAMPLE_PROOF } from '../src/math/localExample';
import { MathProofEnvironmentLeaseTimeoutError } from '../src/math/mathProofEnvironment';
import { checkManyFormalVerifications } from '../src/math/verifier';
import { limitMathOutput, MATH_PROCESS_OUTPUT_LIMIT } from '../src/math/mathProcess';
import { hasDeterministicLeanFailure } from '../src/solver/proofReuse';
import { checkpointVerification, VerificationCheckpointError, withVerificationCheckpoints,
  type VerificationCheckpoint } from '../src/solver/verificationCheckpoint';

const host = vi.hoisted(() => ({ lease: vi.fn(), compile: vi.fn() }));
vi.mock('../src/math/mathProofEnvironment', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathProofEnvironment')>(),
  resolveMathProofEnvironment: () => undefined,
  acquireMathProofEnvironmentLease: host.lease,
}));
vi.mock('../src/math/mathProcess', async importOriginal => ({
  ...await importOriginal<typeof import('../src/math/mathProcess')>(),
  runLeanProcess: host.compile,
}));

let example: ReturnType<typeof localExample>, checkpoints: VerificationCheckpoint[], saved: number;
let run: () => ReturnType<typeof checkManyFormalVerifications>;
let events: { event: string; details?: Record<string, unknown> }[];

beforeEach(() => {
  example = localExample('verifier-lease-timeout-');
  const environmentFile = path.join(example.directory, 'empty.env');
  fs.writeFileSync(environmentFile, '');
  fs.writeFileSync(path.join(example.receipt.projectRoot, 'Submission.lean'), LOCAL_EXAMPLE_PROOF);
  const request = { projectRoot: example.receipt.projectRoot,
    targetCommit: commitSolverSources(example.problem, example.workspace), timeoutMs: 1_800_000,
    items: [{ proofPath: 'Submission.lean', statementHash: 'lease-timeout-fixture', leanStatementHash: 'lease-timeout-fixture' }] };
  const env = { ...process.env, DEEPSCIENTIST_MATH_ENV_FILE: environmentFile };
  checkpoints = []; events = []; saved = 0;
  host.lease.mockReset();
  host.compile.mockReset().mockImplementation(() => { throw new Error('compiler must not start'); });
  run = () => withVerificationCheckpoints({ environmentDigest: 'lease-fixture',
    problemReceiptDigest: example.problem.receiptDigest, checkpoints, save: () => { saved++; },
    emit: (event, details) => events.push({ event, details }) },
  () => checkpointVerification(request, bound => checkManyFormalVerifications(bound, { env })));
});
afterEach(() => {
  fs.rmSync(example.directory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

it('preserves a lease handshake failure and retries the same frozen input without increasing its budget', async () => {
  host.lease.mockRejectedValueOnce(new MathProofEnvironmentLeaseTimeoutError(
    'handshake', 'Proof environment lease handshake timed out.'));
  const result = await run();
  expect(result.results[0]).toMatchObject({ status: 'blocked',
    error: 'Lean could not be executed: Proof environment lease handshake timed out.' });
  expect(host.lease).toHaveBeenCalledOnce();
  expect(host.compile).not.toHaveBeenCalled();
  expect(checkpoints).toEqual([]); expect(saved).toBe(0);
  expect(events.at(-1)).toMatchObject({ event: 'verification_finished', details: { diagnostics: [{
    error: 'Lean could not be executed: Proof environment lease handshake timed out.',
    stderrPreview: 'Proof environment lease handshake timed out.',
  }] } });

  // Restored lease acquisition must execute the compiler again, even for identical source bytes.
  host.lease.mockResolvedValueOnce(undefined);
  host.compile.mockResolvedValueOnce({ started: true, exitCode: 1, signal: null, stdout: '', stderr: 'Fixture Lean error.',
    timedOut: false, aborted: false, durationMs: 1 });
  expect((await run()).results[0]).toMatchObject({ status: 'failed', error: 'Lean exited with status 1.' });
  expect(host.lease).toHaveBeenCalledTimes(2); expect(host.compile).toHaveBeenCalledOnce();
  expect(events.filter(item => item.event === 'verification_started').map(item => item.details?.timeoutMs))
    .toEqual([1_800_000, 1_800_000]);
  expect(checkpoints).toEqual([]);
});

it('keeps a real lease operation deadline eligible for a checkpoint', async () => {
  host.lease.mockRejectedValueOnce(new MathProofEnvironmentLeaseTimeoutError(
    'operation-deadline', 'Proof environment lease deadline exceeded.'));
  await expect(run()).rejects.toBeInstanceOf(VerificationCheckpointError);
  expect(checkpoints).toMatchObject([{ timeoutMs: 1_800_000, attempts: 1 }]);
  expect(host.compile).not.toHaveBeenCalled();
  expect(events.at(-1)).toMatchObject({ event: 'verification_checkpoint', details: { diagnostics: [{
    error: 'Lean verification timed out.', stderrPreview: 'Proof environment lease deadline exceeded.',
  }] } });
});

it('keeps cancellation on the abort path without generating a checkpoint', async () => {
  host.lease.mockRejectedValueOnce(new DOMException('Proof environment lease cancelled.', 'AbortError'));
  expect((await run()).results[0]).toMatchObject({ status: 'blocked', error: 'Formal verification was aborted.' });
  expect(host.compile).not.toHaveBeenCalled();
  expect(checkpoints).toEqual([]); expect(saved).toBe(0);
});

it('preserves checkpoint generation for a real compiler timeout', async () => {
  host.lease.mockResolvedValue(undefined);
  host.compile.mockResolvedValue({ started: true, exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '',
    timedOut: true, aborted: false, durationMs: 1_800_000 });
  await expect(run()).rejects.toBeInstanceOf(VerificationCheckpointError);
  expect(host.compile).toHaveBeenCalledOnce();
  expect(checkpoints).toMatchObject([{ timeoutMs: 1_800_000, attempts: 1 }]);
});

it('identifies an exhausted batch deadline separately from the compiler allowance', async () => {
  host.lease.mockResolvedValue(undefined);
  host.compile.mockImplementationOnce(() => {
    const expiredAt = Date.now() + 1_800_001;
    vi.spyOn(Date, 'now').mockReturnValue(expiredAt);
    return { started: true, exitCode: null, signal: 'SIGTERM', stdout: '', stderr: '',
      timedOut: true, aborted: false, durationMs: 1_800_000 };
  });
  await expect(run()).rejects.toBeInstanceOf(VerificationCheckpointError);
  expect(events.at(-1)).toMatchObject({ event: 'verification_checkpoint', details: { diagnostics: [{
    error: 'Formal verification batch deadline exceeded.',
  }] } });
});

it.each(['stdout', 'stderr'] as const)('retains a located source error before a giant %s body is truncated', async stream => {
  host.lease.mockResolvedValue(undefined);
  const output = 'build progress\n'.repeat(2000) +
    'Submission.lean:99:17: error: Type mismatch\n' + 'huge proof expression\n'.repeat(3000);
  host.compile.mockImplementationOnce((_command, _args, options) => {
    expect(options.onOutput).toBeTypeOf('function');
    for (let offset = 0; offset < output.length; offset += 97)
      options.onOutput(stream, Buffer.from(output.slice(offset, offset + 97)));
    return { started: true, exitCode: 1, signal: null, stdout: '', stderr: '', [stream]: limitMathOutput(output),
      timedOut: false, aborted: false, durationMs: 1 };
  });
  const result = await run(), preview = result.results[0]![`${stream}Preview`]!;
  expect(result.results[0]).toMatchObject({ status: 'failed', error: 'Lean exited with status 1.' });
  expect(preview).toContain('Submission.lean:99:17: error: Type mismatch');
  expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(MATH_PROCESS_OUTPUT_LIMIT);
  expect(hasDeterministicLeanFailure(result)).toBe(true);
  expect(checkpoints).toEqual([]);
});

it('does not classify a bare failed invocation as a deterministic source rejection', async () => {
  host.lease.mockResolvedValue(undefined);
  host.compile.mockImplementationOnce((_command, _args, options) => {
    const output = 'Submission.lean:5:1: warning: unused variable\n' + 'unattributed output\n'.repeat(3000);
    options.onOutput('stderr', Buffer.from(output));
    return { started: true, exitCode: 1, signal: null, stdout: '', stderr: limitMathOutput(output),
      timedOut: false, aborted: false, durationMs: 1 };
  });
  const result = await run();
  expect(result.results[0]).toMatchObject({ status: 'failed', error: 'Lean exited with status 1.' });
  expect(hasDeterministicLeanFailure(result)).toBe(false);
});
