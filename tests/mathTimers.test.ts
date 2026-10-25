import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleMathTimeout } from '../src/math/mathTimers';

describe('mathematics budget timer', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps unlimited budgets timer-free', () => {
    vi.useFakeTimers();
    const expired = vi.fn(), cancel = scheduleMathTimeout(expired, Infinity);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(3_000_000_000);
    expect(expired).not.toHaveBeenCalled(); cancel();
  });
  it('does not overflow a long positive budget into immediate expiration', () => {
    vi.useFakeTimers();
    const expired = vi.fn(); scheduleMathTimeout(expired, 3_000_000_000);
    vi.advanceTimersByTime(2_147_483_647);
    expect(expired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3_000_000_000 - 2_147_483_647);
    expect(expired).toHaveBeenCalledOnce();
  });
  it('cancels the remaining timer after a long interval', () => {
    vi.useFakeTimers();
    const expired = vi.fn(), cancel = scheduleMathTimeout(expired, 3_000_000_000);
    vi.advanceTimersByTime(2_147_483_647); cancel();
    vi.advanceTimersByTime(3_000_000_000);
    expect(expired).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
});
