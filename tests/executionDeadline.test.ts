import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecutionDeadline } from '../src/runtime/executionDeadline';

describe('execution time with human approval waits', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000); });
  afterEach(() => vi.useRealTimers());

  it('excludes repeated waits and expires after the remaining execution time', async () => {
    const expire = vi.fn(), clock = new ExecutionDeadline(1_000, expire);
    await vi.advanceTimersByTimeAsync(200);
    clock.setWaiting(true);
    await vi.advanceTimersByTimeAsync(3_600_000);
    clock.setWaiting(true);
    expect(clock.remainingMs()).toBe(800);
    expect(clock.waitingMs()).toBe(3_600_000);
    expect(expire).not.toHaveBeenCalled();
    clock.setWaiting(false);
    await vi.advanceTimersByTimeAsync(300);
    clock.setWaiting(true);
    await vi.advanceTimersByTimeAsync(60_000);
    clock.setWaiting(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledOnce();
    expect(clock.executionMs()).toBe(1_000);
    expect(clock.waitingMs()).toBe(3_660_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cannot pause an exhausted allowance, and stopping while paused removes every timer', () => {
    const expire = vi.fn(), clock = new ExecutionDeadline(100, expire);
    vi.setSystemTime(1_101);
    clock.setWaiting(true);
    expect(expire).toHaveBeenCalledOnce();
    expect(clock.waiting).toBe(false);
    expect(clock.remainingMs()).toBe(0);
    const waiting = new ExecutionDeadline(500, expire);
    waiting.setWaiting(true);
    vi.setSystemTime(10_000);
    waiting.stop();
    expect(waiting.executionMs()).toBe(0);
    expect(waiting.waitingMs()).toBe(8_899);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps unlimited runs cancellable without scheduling an infinite timer', () => {
    const clock = new ExecutionDeadline(Infinity, vi.fn());
    clock.setWaiting(true);
    vi.setSystemTime(5_000);
    clock.setWaiting(false);
    expect(clock.remainingMs()).toBe(Infinity);
    expect(vi.getTimerCount()).toBe(0);
    clock.stop();
  });
});
