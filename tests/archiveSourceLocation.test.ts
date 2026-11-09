import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readSourceLocation, verifiedSourceLocation, writeSourceLocation, type SourceLocation } from '../docs/web/sourceLocation';
import type { ArchiveIndexRecord, ArchiveProcess } from '../docs/web/types';

function fixture() {
  const code = '-- first line\n\ntheorem final : True := by\n  trivial\n';
  const sha256 = createHash('sha256').update(code).digest('hex'), name = 'proofs/示例 proof.lean';
  const record: Pick<ArchiveIndexRecord, 'id' | 'sources'> = { id: 'unseen-proof', sources: [{ name, sha256, lines: 4, path: name, url: 'proof.lean' }] };
  const process: ArchiveProcess = { sources: { [sha256]: { path: name, sha256, code } }, runs: [{
    runId: 'saved-run', phase: 'finished', turns: 0, workers: 0, tasks: [], events: [], checks: [{
      id: 'saved-check', at: '2026-11-10T00:00:00Z', scope: 'original', status: 'kernel_verified', sourceDigest: sha256, receiptIds: [],
    }],
  }] };
  const context = { record, tab: 'process', run: 'saved-run', step: 'check:saved-check', code: 'source', process };
  const location: SourceLocation = { recordId: record.id, tab: 'process', name, sha256, line: 3, endLine: 4, run: context.run, step: context.step };
  const params = new URLSearchParams({ proof: record.id, tab: context.tab, run: context.run, step: context.step, code: context.code });
  return { code, name, sha256, record, process, context, location, params };
}

describe('archive source locations', () => {
  it('round-trips an exact checked range and gives different proof steps different addresses', () => {
    const { context, location, params } = fixture();
    writeSourceLocation(params, location, context);
    const restored = readSourceLocation(new URLSearchParams(params.toString()));
    expect(verifiedSourceLocation(restored, context)).toEqual(location);
    const first = new URLSearchParams({ proof: context.record.id, tab: 'process', run: context.run, step: context.step, code: 'source' });
    writeSourceLocation(first, { ...location, line: 1, endLine: 1 }, context);
    expect(first.toString()).not.toBe(params.toString());
    expect(restored?.name).toBe('proofs/示例 proof.lean');
  });

  it('keeps a checked location through lazy loading and rejects a stale binding once data is available', () => {
    const { location, params, context } = fixture();
    const stale = { ...location, sha256: 'a'.repeat(64) };
    writeSourceLocation(params, stale, { ...context, process: undefined });
    expect(readSourceLocation(params)).toEqual(stale);
    expect(verifiedSourceLocation(stale, { ...context, process: undefined })).toBeUndefined();
    const canonical = new URLSearchParams();
    writeSourceLocation(canonical, stale, context);
    expect(canonical.toString()).toBe('');
    expect(verifiedSourceLocation(stale, context)).toBeUndefined();
  });

  it('binds the range to its record, run, check, source path and exact digest', () => {
    const { location, context, process } = fixture();
    for (const changed of [
      { ...location, recordId: 'another-proof' }, { ...location, run: 'another-run' },
      { ...location, step: 'check:another-check' }, { ...location, name: 'different.lean' },
      { ...location, sha256: 'b'.repeat(64) }, { ...location, tab: 'source' as const },
    ]) expect(verifiedSourceLocation(changed, context)).toBeUndefined();
    expect(verifiedSourceLocation(location, { ...context, code: 'closed' })).toBeUndefined();
    expect(verifiedSourceLocation(location, { ...context, step: 'acceptance' })).toBeUndefined();
    const missing = structuredClone(process); missing.runs[0].checks = [];
    expect(verifiedSourceLocation(location, { ...context, process: missing })).toBeUndefined();
    const changed = structuredClone(process); changed.sources![location.sha256].sha256 = 'c'.repeat(64);
    expect(verifiedSourceLocation(location, { ...context, process: changed })).toBeUndefined();
  });

  it.each([
    ['line', '0'], ['line', '-1'], ['line', '1.5'], ['line', 'Infinity'], ['line', '9007199254740992'],
    ['line', '1e1'], ['endLine', '2'], ['endLine', 'NaN'], ['sourceSha256', 'wrong-digest'],
    ['source', ''], ['run', ''], ['step', 'acceptance'], ['code', 'closed'], ['tab', 'overview'],
  ])('ignores malformed URL field %s=%s', (key, value) => {
    const { location, params, context } = fixture(); writeSourceLocation(params, location, context); params.set(key, value);
    expect(readSourceLocation(params)).toBeUndefined();
  });

  it('rejects out-of-file and reversed ranges without treating the trailing newline as another displayed row', () => {
    const { location, context, params } = fixture();
    for (const [line, endLine] of [[0, 1], [4, 3], [3, 5], [5, 5], [1.5, 3], [1, Number.MAX_SAFE_INTEGER]]) {
      const invalid = { ...location, line, endLine };
      expect(verifiedSourceLocation(invalid, context)).toBeUndefined();
      const canonical = new URLSearchParams(); writeSourceLocation(canonical, invalid, context);
      expect(canonical.toString()).toBe('');
    }
    writeSourceLocation(params, location, context); params.set('endLine', '5');
    expect(readSourceLocation(params)).toBeDefined();
    expect(verifiedSourceLocation(readSourceLocation(params), context)).toBeUndefined();
    expect(verifiedSourceLocation({ ...location, line: 2, endLine: 2 }, context)).toBeDefined();
  });

  it('restores archived files using that record’s file metadata and rejects another file or tab', () => {
    const { location, context, record } = fixture();
    const source = { ...location, tab: 'source' as const, run: undefined, step: undefined };
    const archiveContext = { ...context, tab: 'source', process: undefined };
    const params = new URLSearchParams({ proof: record.id, tab: 'source' });
    writeSourceLocation(params, source, archiveContext);
    expect(verifiedSourceLocation(readSourceLocation(params), archiveContext)).toEqual(source);
    expect(verifiedSourceLocation({ ...source, endLine: 5 }, archiveContext)).toBeUndefined();
    expect(verifiedSourceLocation({ ...source, name: 'missing.lean' }, archiveContext)).toBeUndefined();
    expect(verifiedSourceLocation(source, { ...archiveContext, tab: 'overview' })).toBeUndefined();
  });
});
