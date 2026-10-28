import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { readContinuationInput } from '../src/solver/continuationInput';
import { readSolverProblem } from '../src/solver/problem';
import { writeWebContinuation } from '../apps/web/worker';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('continuing a web run from a recorded version', () => {
  it('writes a continuation input the solver accepts for the same task and problem, and only for them', () => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-web-continuation-'))); roots.push(directory);
    const receipt = bootstrapLeanTask(path.join(directory, 'workspace'), {
      source: 'namespace Tutorial\n\ntheorem zero_add (n : Nat) : 0 + n = n := by sorry\n\nend Tutorial\n', task: 'Prove it.' });
    const taskFile = path.join(directory, 'task.md');
    fs.writeFileSync(taskFile, 'Prove it.\nPreserve all original declarations.\n', { mode: 0o600 });
    const previous = 'namespace Tutorial\n\ntheorem zero_add (n : Nat) : 0 + n = n := by\n  induction n <;> simp_all\n\nend Tutorial\n';
    const manifest = writeWebContinuation(directory, { runId: '0'.repeat(8) + '-0000-4000-8000-' + '0'.repeat(12), taskId: 'goal_2',
      commit: 'c'.repeat(40), label: 'zero_add · 第 2 次', file: 'Submission.lean', source: previous },
      { taskFile, workspace: receipt.workspaceRoot, receiptFile: receipt.activeProblemPath });
    expect((fs.statSync(manifest).mode & 0o777).toString(8)).toBe('600');
    const identity = { taskDigest: mathDigest(fs.readFileSync(taskFile, 'utf8')),
      problemReceiptDigest: readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath).receiptDigest };
    const input = readContinuationInput(manifest, identity);
    const [attachment] = input.manifest.attachments;
    expect(attachment).toMatchObject({ id: 'previous-version', kind: 'proof-source', bytes: Buffer.byteLength(previous),
      provenance: { evidence: 'recorded-not-replayed', source: 'zero_add · 第 2 次 (Submission.lean)', commit: 'c'.repeat(40) } });
    expect(input.contents.get(attachment!.sha256)).toBe(previous);
    // Another task text or problem is another identity: the solver refuses the attachment rather than mixing runs.
    expect(() => readContinuationInput(manifest, { ...identity, taskDigest: mathDigest('Another task') })).toThrow('math_continuation_identity_changed');
  });
});
