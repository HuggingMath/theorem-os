import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { createLeanDiagnosticCapture, leanDiagnosticPreview, parseLeanDiagnosticOutput } from '../src/math/leanDiagnosticMessages';
import { MATH_PROCESS_OUTPUT_LIMIT, runMathProcess } from '../src/math/mathProcess';
import { mathDigest } from '../src/math/mathRuntimeIo';

describe('located Lean diagnostics across bounded process output', () => {
  it.each(['stdout', 'stderr'] as const)('retains a late source error before %s loses its giant body to tail capture', async stream => {
    const capture = createLeanDiagnosticCapture();
    const script = `const stream = process.${stream};
      stream.write('build progress\\n'.repeat(2000));
      stream.write('Submission.lean:293:17: error(lean.typeMismatch): Type mismatch\\n');
      stream.write('  huge proof expression 数😀\\n'.repeat(4000));
      stream.write('compiler output end');
      process.exitCode = 1;`;
    const result = await runMathProcess(process.execPath, ['-e', script], {
      cwd: os.tmpdir(), timeoutMs: 5000, onOutput: (channel, chunk) => { if (channel === stream) capture.append(chunk); },
    });
    expect(result.exitCode).toBe(1);
    expect(result[stream]).not.toContain('Submission.lean:293:17: error');
    expect(mathDigest(result[stream])).not.toBe(result[`${stream}Sha256`]);
    const preview = leanDiagnosticPreview(result[stream], capture.finish())!;
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(MATH_PROCESS_OUTPUT_LIMIT);
    expect(preview).not.toContain('�');
    expect(preview).toContain('Submission.lean:293:17: error(lean.typeMismatch): Type mismatch');
    expect(preview).toContain('compiler output end');
    expect(parseLeanDiagnosticOutput(preview).messages[0]).toMatchObject({ severity: 'error',
      file: 'Submission.lean', line: 293, column: 16, code: 'lean.typeMismatch' });
  });

  it('handles headers and Unicode split across chunks, an oversized first line and an unterminated error line', () => {
    const capture = createLeanDiagnosticCapture();
    capture.append('unstructured build output'.repeat(2000) + '\n');
    const bytes = Buffer.from('Submission/数学.lean:18:3: error: 类型不匹配 🧮');
    for (const byte of bytes) capture.append(Buffer.from([byte]));
    const message = capture.finish();
    expect(message).toMatchObject({ file: 'Submission/数学.lean', line: 18, column: 2, message: '类型不匹配 🧮' });
    expect(capture.finish()).toEqual(message);
  });

  it('uses the existing JSON diagnostic parser without treating warnings or unrelated exit output as source errors', () => {
    const warning = createLeanDiagnosticCapture();
    warning.append('Submission.lean:2:1: warning: unused variable\n');
    warning.append('fatal invocation failed\n');
    expect(warning.finish()).toBeUndefined();
    expect(leanDiagnosticPreview('fatal invocation failed', warning.finish())).toBe('fatal invocation failed');
    const error = createLeanDiagnosticCapture();
    error.append(JSON.stringify({ fileName: 'Submission.lean', pos: { line: 20, column: 7 },
      severity: 'error', data: 'Application type mismatch' }) + '\n');
    error.append('suffix'.repeat(4000));
    expect(error.finish()).toMatchObject({ format: 'lean-json', file: 'Submission.lean', line: 20, column: 7 });
    expect(leanDiagnosticPreview('suffix'.repeat(4000), error.finish())).toContain('Submission.lean:20:8: error: Application type mismatch');
  });

  it('bounds a one-line source error and keeps the location through a smaller final preview', () => {
    const capture = createLeanDiagnosticCapture();
    capture.append('Submission.lean:11:4: error: ' + 'bad term 数😀 '.repeat(5000));
    const diagnostic = capture.finish()!;
    expect(Buffer.byteLength(diagnostic.message)).toBeLessThanOrEqual(4096);
    const preview = leanDiagnosticPreview('tail'.repeat(5000), diagnostic, 1024)!;
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(1024);
    expect(preview).not.toContain('�');
    expect(parseLeanDiagnosticOutput(preview).messages[0]).toMatchObject({ file: 'Submission.lean', line: 11, column: 3 });
  });
});
