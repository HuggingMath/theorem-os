import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_DELIVERY_LINE_BYTES, readDeliveryLines, readMathResponse } from '../src/solver/deliveries';
import { readMathText } from '../src/math/mathRuntimeIo';

const roots: string[] = [];
const temp = () => { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'math-input-'))); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe('solver input boundaries', () => {
  it('rejects linked research inputs while accepting ordinary Markdown', () => {
    const root = temp(), workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
    const outside = path.join(root, 'outside.md'), response = path.join(workspace, 'RESEARCH.md');
    fs.writeFileSync(outside, '{"summary":"outside"}'); fs.symlinkSync(outside, response);
    expect(() => readMathResponse(workspace, 'math-result')).toThrow('missing_or_too_large');
    fs.unlinkSync(response); fs.writeFileSync(response, '# Research\nA useful explanation.');
    expect(readMathResponse(workspace, 'math-result', {}, 'summary').summary).toContain('useful explanation');
  });

  it('rejects oversized and invalid UTF-8 inputs', () => {
    const file = path.join(temp(), 'input');
    fs.writeFileSync(file, '数'.repeat(30));
    expect(() => readMathText(file, 64)).toThrow('too_large');
    expect(readMathText(file, 5, { headOnly: true })).toBe('数');
    fs.writeFileSync(file, Buffer.from([0xff]));
    expect(() => readMathText(file, 64)).toThrow();
  });

  it('tracks log byte offsets across blank lines, CRLF and partial writes', () => {
    const file = path.join(temp(), 'edits.jsonl');
    const prefix = '\n' + JSON.stringify({ summary: '\u6570\u5b66' }) + '\r\n';
    fs.writeFileSync(file, prefix + '{"partial":');
    const batch = readDeliveryLines(file, 0);
    expect(batch.entries.map(entry => entry.line)).toEqual(['', JSON.stringify({ summary: '\u6570\u5b66' }) + '\r']);
    expect(batch.entries.map(entry => entry.offset)).toEqual([1, Buffer.byteLength(prefix)]);
    expect(batch.offset).toBe(Buffer.byteLength(prefix));
    fs.appendFileSync(file, 'true}\n');
    expect(readDeliveryLines(file, batch.offset).entries)
      .toEqual([{ line: '{"partial":true}', offset: fs.statSync(file).size, discardingOversized: false }]);
  });

  it('rereads an incomplete UTF-8 line crossing the chunk boundary', () => {
    const file = path.join(temp(), 'edits.jsonl'), prefix = 'x'.repeat(MAX_DELIVERY_LINE_BYTES - 2) + '\n', tail = '\u6570\u5b66\n';
    fs.writeFileSync(file, prefix + tail);
    const batch = readDeliveryLines(file, 0);
    expect(batch.entries.map(entry => entry.line)).toEqual([prefix.slice(0, -1)]);
    expect(batch.offset).toBe(Buffer.byteLength(prefix));
    expect(readDeliveryLines(file, batch.offset)).toMatchObject({
      entries: [{ line: tail.slice(0, -1) }], offset: fs.statSync(file).size });
  });

  it('accepts a complete line filling the read chunk', () => {
    const file = path.join(temp(), 'edits.jsonl'), line = 'x'.repeat(MAX_DELIVERY_LINE_BYTES);
    fs.writeFileSync(file, line + '\n');
    expect(readDeliveryLines(file, 0))
      .toMatchObject({ offset: MAX_DELIVERY_LINE_BYTES + 1,
        entries: [{ line, offset: MAX_DELIVERY_LINE_BYTES + 1, discardingOversized: false }] });
  });

  it('skips a log rewritten below the cursor and discards its unfinished line', () => {
    const file = path.join(temp(), 'DELIVERIES.jsonl'), first = '{"summary":"first"}\n', second = '{"summary":"second"}\n';
    fs.writeFileSync(file, first + second);
    const end = readDeliveryLines(file, 0).offset;
    fs.writeFileSync(file, second);
    expect(readDeliveryLines(file, end)).toMatchObject({ offset: second.length,
      entries: [{ error: 'math_delivery_log_rewritten', offset: second.length, discardingOversized: false }], discardingOversized: false });
    fs.writeFileSync(file, second + '{"summ');
    const rewritten = readDeliveryLines(file, end);
    const rewrittenEnd = fs.statSync(file).size;
    expect(rewritten).toMatchObject({ offset: rewrittenEnd, discardingOversized: true,
      entries: [{ error: 'math_delivery_log_rewritten', offset: rewrittenEnd, discardingOversized: true }] });
    fs.appendFileSync(file, 'ary":"fragment"}\n' + first);
    expect(readDeliveryLines(file, rewritten.offset, rewritten.discardingOversized))
      .toMatchObject({ entries: [{ line: first.slice(0, -1) }], offset: fs.statSync(file).size, discardingOversized: false });
    fs.writeFileSync(file, '');
    expect(readDeliveryLines(file, end, true)).toMatchObject({ offset: 0,
      entries: [{ error: 'math_delivery_log_rewritten', offset: 0, discardingOversized: false }], discardingOversized: false });
  });

  it('bounds the read of a rewritten log whose last line is oversized', () => {
    const file = path.join(temp(), 'DELIVERIES.jsonl');
    fs.writeFileSync(file, 'x'.repeat(MAX_DELIVERY_LINE_BYTES * 2));
    const read = vi.spyOn(fs, 'readSync');
    try {
      expect(readDeliveryLines(file, MAX_DELIVERY_LINE_BYTES * 3)).toMatchObject({
        offset: MAX_DELIVERY_LINE_BYTES * 2, discardingOversized: true, entries: [{ error: 'math_delivery_log_rewritten' }] });
      expect(read.mock.calls.every(call => (call[3] as number) <= MAX_DELIVERY_LINE_BYTES + 1)).toBe(true);
    } finally { read.mockRestore(); }
  });

  it.skipIf(process.platform === 'win32')('rejects FIFOs without waiting for a writer', () => {
    const root = temp(), file = path.join(root, 'RESEARCH.md');
    expect(spawnSync('mkfifo', [file], { timeout: 1000 }).status).toBe(0);
    expect(() => readDeliveryLines(file, 0)).toThrow('math_delivery_log_invalid');
    expect(() => readMathResponse(root, 'math-result')).toThrow('missing_or_too_large');
  });
});
