import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexShellRejectionReader } from '../src/runtime/codexShellRejection';

const rejection = '`justification` requires an explicit `sandbox_permissions`; use `sandbox_permissions: "require_escalated"` for unsandboxed execution, or omit `justification`.';
const context = (turn = 'current-turn') => ({ type: 'turn_context', payload: { turn_id: turn } });
const call = (callId: string, name = 'exec_command') => ({ type: 'response_item', payload: {
  type: 'function_call', call_id: callId, name, arguments: '{"cmd":"private fixture command"}',
} });
const output = (callId: string, text = rejection) => ({ type: 'response_item', payload: {
  type: 'function_call_output', call_id: callId, output: text,
} });

describe('the exact native rollout argument-rejection boundary', () => {
  let profile: string, file: string, reader: CodexShellRejectionReader;
  const append = (...records: unknown[]) => fs.appendFileSync(file, records.map(value => JSON.stringify(value) + '\n').join(''));
  beforeEach(() => {
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shell-rejection-'));
    const directory = path.join(profile, 'sessions', '2026', '11', '11'); fs.mkdirSync(directory, { recursive: true });
    file = path.join(directory, 'rollout-fixture-thread.jsonl'); fs.writeFileSync(file, '');
    reader = CodexShellRejectionReader.create(profile, 'fixture-thread', file)!; reader.beginTurn();
  });
  afterEach(() => { fs.rmSync(profile, { recursive: true, force: true }); });

  it('matches concurrent call IDs, reports each refusal once and exposes no command or output', () => {
    append(context(), call('first'), call('second'), call('third'), output('third'), output('first'), output('second'));
    expect(reader.poll('current-turn')).toEqual([
      { callId: 'third', reason: 'justification' }, { callId: 'first', reason: 'justification' },
      { callId: 'second', reason: 'justification' },
    ]);
    append(call('first'), output('first'), output('second'));
    expect(reader.poll('current-turn')).toEqual([]);
  });

  it('skips retained history on a resumed run, and requires the new remote turn context', () => {
    append(context('previous-turn'), call('retained'), output('retained'));
    reader.beginTurn();
    expect(reader.poll('current-turn')).toEqual([]);
    append(call('without-current-context'), output('without-current-context'), context(), call('fresh'), output('fresh'));
    expect(reader.poll('current-turn')).toEqual([{ callId: 'fresh', reason: 'justification' }]);
  });

  it('ignores old turns, non-exec tools, unpaired outputs, invalid records and arbitrary prose', () => {
    append(context('previous-turn'), call('old'), output('old'), context(), call('other', 'apply_patch'), output('other'),
      output('unpaired'), { type: 'event_msg', payload: { type: 'agent_message', message: rejection } });
    fs.appendFileSync(file, '{not a JSON record}\n');
    expect(reader.poll('current-turn')).toEqual([]);
    append(context('previous-turn'), call('old-again'), context(), output('old-again'));
    expect(reader.poll('current-turn')).toEqual([]);
  });

  it('does not infer a safe retry from a real shell exit failure, echoed rejection or an unclear result', () => {
    append(context(), call('nonzero'), output('nonzero', 'Process exited with code 1\n' + rejection),
      call('unclear'), output('unclear', 'Execution result unavailable'),
      call('echo'), output('echo', 'Chunk ID: fixture\nExit code: 0\nOutput:\n' + rejection),
      call('incomplete'), output('incomplete', 'Invalid arguments: the command may have started'));
    expect(reader.poll('current-turn')).toEqual([]);
  });

  it('waits for complete JSONL records, preserving split UTF-8 and a refusal split across polls', () => {
    const start = Buffer.from(JSON.stringify({ type: 'event_msg', payload: { type: 'reasoning', text: '数学' } }) + '\n');
    const split = start.indexOf(Buffer.from('数')) + 1;
    fs.appendFileSync(file, start.subarray(0, split)); expect(reader.poll('current-turn')).toEqual([]);
    fs.appendFileSync(file, start.subarray(split)); append(context(), call('partial'));
    const raw = JSON.stringify(output('partial'));
    fs.appendFileSync(file, raw.slice(0, 70)); expect(reader.poll('current-turn')).toEqual([]);
    fs.appendFileSync(file, raw.slice(70)); expect(reader.poll('current-turn')).toEqual([]);
    fs.appendFileSync(file, '\n');
    expect(reader.poll('current-turn')).toEqual([{ callId: 'partial', reason: 'justification' }]);
  });

  it.each(['truncate', 'replace'] as const)('rejoins at the end after %s without replaying prior calls', mode => {
    append(context(), call('old'), output('old'));
    expect(reader.poll('current-turn')).toHaveLength(1);
    if (mode === 'replace') { fs.renameSync(file, file + '.old'); fs.writeFileSync(file, ''); }
    else fs.truncateSync(file);
    expect(reader.poll('current-turn')).toEqual([]);
    append(output('old'), call('no-context'), output('no-context'));
    expect(reader.poll('current-turn')).toEqual([]);
    append(context(), call('new'), output('new'));
    expect(reader.poll('current-turn')).toEqual([{ callId: 'new', reason: 'justification' }]);
  });

  it('allows a newly created rollout but rejects paths outside this profile or for another thread', () => {
    expect(CodexShellRejectionReader.create(profile, 'other-thread', file)).toBeUndefined();
    expect(CodexShellRejectionReader.create(path.join(profile, 'other-profile'), 'fixture-thread', file)).toBeUndefined();
    expect(CodexShellRejectionReader.create(profile, 'fixture-thread', undefined)).toBeUndefined();
    fs.unlinkSync(file); reader.beginTurn();
    append(context(), call('created-later'), output('created-later'));
    expect(reader.poll('current-turn')).toEqual([{ callId: 'created-later', reason: 'justification' }]);
  });

  it('does not follow a replaced rollout symlink', () => {
    const outside = path.join(profile, 'outside.jsonl');
    fs.writeFileSync(outside, [context(), call('outside'), output('outside')].map(value => JSON.stringify(value) + '\n').join(''));
    fs.unlinkSync(file); fs.symlinkSync(outside, file);
    expect(reader.poll('current-turn')).toEqual([]);
    expect(CodexShellRejectionReader.create(profile, 'fixture-thread', file)).toBeUndefined();
  });
});
