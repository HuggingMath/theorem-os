import { describe, expect, it } from 'vitest';
import type { SolverRunState } from '../src/solver/archive';
import type { MathAgentSession } from '../src/runtime/agentSession';
import { ResearchUsage } from '../src/solver/researchUsage';
import { buildTokenBudget, initializeUsageAccounting } from '../src/solver/usageBudget';

const receipt = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
function fixture(prior?: SolverRunState) {
  const state = prior ?? { turns: 0 } as SolverRunState;
  initializeUsageAccounting(state);
  const events: string[] = [];
  const usage = new ResearchUsage({ state, research: state, signal: new AbortController().signal,
    remainingMs: () => Infinity, changed: () => { state.tokenBudget = buildTokenBudget(100, [state]); },
    emit: event => { events.push(event); } });
  const open = (id: string, source: MathAgentSession['usageSource'] = 'native-turn-totals') => {
    const callbacks = usage.bindSession(id, () => undefined);
    usage.sessionOpened({ threadId: 'same-native-conversation', usageSource: source,
      run: async () => 'completed', close: async () => {}, interrupt: async () => {} });
    return callbacks;
  };
  return { state, usage, open, events };
}

describe('native invocation usage at the shared solver boundary', () => {
  it('adds each turn once across same-conversation reopening and a serialized host restart', () => {
    const f = fixture(), first = f.open('process-1');
    f.usage.begin(); f.usage.turnStarted('turn-1'); first.onUsage(receipt(20, 5), { turnId: 'turn-1' });
    first.onUsage(receipt(20, 5), { turnId: 'turn-1' }); f.usage.finish(true);
    f.usage.sessionClosed('process-1');
    const second = f.open('process-2'); f.usage.begin(); f.usage.turnStarted('turn-2');
    second.onUsage(receipt(3, 2), { turnId: 'turn-2' }); f.usage.finish(true);
    expect(f.state.usage).toEqual(receipt(23, 7));
    const restored = fixture(JSON.parse(JSON.stringify(f.state)) as SolverRunState), third = restored.open('process-3');
    restored.usage.begin(); restored.usage.turnStarted('turn-3'); third.onUsage(receipt(60, 15), { turnId: 'turn-3' });
    restored.usage.finish(true);
    expect(restored.state.usage).toEqual(receipt(83, 22));
    expect(restored.state.tokenBudget).toMatchObject({ status: 'exhausted', reportedTotalTokens: 105, usageComplete: true });
    expect(restored.state.requestUsageAccounting).toBeUndefined();
  });

  it('keeps historical Codex cumulative usage as a maximum, rather than adding it', () => {
    const f = fixture(), callbacks = f.open('codex', 'native-thread-totals');
    for (const [id, tokens] of [['a', 10], ['b', 15]] as const) {
      f.usage.begin(); f.usage.turnStarted(id); callbacks.onUsage({ totalTokens: tokens }, { turnId: id }); f.usage.finish(true);
    }
    expect(f.state.usage!.totalTokens).toBe(15); expect(f.state.tokenBudget!.usageComplete).toBe(true);
  });

  it.each(['missing', 'invalid', 'unscoped', 'conflicting-duplicate', 'late'] as const)
    ('blocks finite dispatch with %s native usage without inventing zero consumption', kind => {
      const f = fixture(), callbacks = f.open('old'); f.usage.begin(); f.usage.turnStarted('a');
      if (kind === 'invalid') callbacks.onUsage({ ...receipt(4, 2), totalTokens: 99 }, { turnId: 'a' });
      if (kind === 'unscoped') callbacks.onUsage(receipt(4, 2));
      if (kind === 'conflicting-duplicate') {
        callbacks.onUsage(receipt(4, 2), { turnId: 'a' }); callbacks.onUsage(receipt(5, 2), { turnId: 'a' });
      }
      f.usage.finish(true);
      if (kind === 'late') { f.usage.sessionClosed('old'); f.open('new'); callbacks.onUsage(receipt(4, 2), { turnId: 'a' }); }
      expect(f.state.tokenBudget).toMatchObject({ status: 'usage-unavailable', usageComplete: false });
      expect(f.state.usage?.totalTokens).toBe(kind === 'conflicting-duplicate' ? 6 : undefined);
    });

  it('retains valid consumption of a failed native invocation when the native total is complete', () => {
    const f = fixture(), callbacks = f.open('native'); f.usage.begin(); f.usage.turnStarted('failed');
    callbacks.onUsage(receipt(6, 3), { turnId: 'failed' }); f.usage.finish(false);
    expect(f.state.tokenBudget).toMatchObject({ reportedTotalTokens: 9, usageComplete: true });
  });
});
