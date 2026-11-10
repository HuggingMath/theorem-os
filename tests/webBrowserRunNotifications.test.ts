import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebRun } from '../apps/web/shared';
import { browserNotificationState, notifyRunEvent, runNoticeIdentity } from '../apps/web/client/browserRunNotifications';
import { notifyStorageKey } from '../apps/web/client/runAwareness';

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const stored = new Map<string, string>([[notifyStorageKey, 'on']]);
  const notices: { title: string; onclick?: () => void; close(): void }[] = [];
  class TestNotification {
    static permission = 'granted';
    onclick?: () => void;
    constructor(readonly title: string) { notices.push(this); }
    close = vi.fn();
  }
  vi.stubGlobal('Notification', TestNotification);
  vi.stubGlobal('localStorage', { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value) });
  vi.stubGlobal('document', { hidden: true });
  vi.stubGlobal('window', { focus: vi.fn() });
  let chain = Promise.resolve();
  vi.stubGlobal('navigator', { locks: { request: (_key: string, action: () => boolean) => { const result = chain.then(action); chain = result.then(() => {}); return result; } } });
  const run = { id: crypto.randomUUID(), status: 'completed', finishedAt: '2026-11-10T14:00:00Z', updatedAt: '2026-11-10T14:00:00Z' } as WebRun;
  const input = { owner: 'account:fixture', run, kind: 'finished' as const, title: 'TheoremOS · 已结束', body: 'Run finished', activate: vi.fn(), current: () => true };
  return { stored, notices, input, Notification: TestNotification };
}

describe('shared browser run reminders', () => {
  it('honors browser permission, preference and foreground state', async () => {
    const f = fixture();
    f.stored.set(notifyStorageKey, 'off'); expect(browserNotificationState()).toBe('off'); expect(await notifyRunEvent(f.input)).toBe(false);
    f.stored.set(notifyStorageKey, 'on'); f.Notification.permission = 'denied'; expect(browserNotificationState()).toBe('blocked'); expect(await notifyRunEvent(f.input)).toBe(false);
    f.Notification.permission = 'granted'; vi.stubGlobal('document', { hidden: false }); expect(await notifyRunEvent(f.input)).toBe(false);
    expect(f.notices).toHaveLength(0);
  });

  it('shows one notification for simultaneous workbench and research consumers', async () => {
    const f = fixture();
    expect(await Promise.all([notifyRunEvent(f.input), notifyRunEvent(f.input)])).toEqual([true, false]);
    expect(f.notices).toHaveLength(1);
    f.notices[0].onclick!(); expect(f.input.activate).toHaveBeenCalledOnce();
    const other = { ...f.input, owner: 'account:other' };
    expect(await notifyRunEvent(other)).toBe(true);
  });

  it('uses a stored event from another page and distinguishes revised plans', async () => {
    const f = fixture(), identity = runNoticeIdentity(f.input.owner, f.input.run, 'finished');
    f.stored.set(identity.key, identity.revision); expect(await notifyRunEvent(f.input)).toBe(false);
    const plan = { ...f.input.run, observation: { inspection: { planApproval: { planVersion: 'plan-v1' } } } } as WebRun;
    expect(await notifyRunEvent({ ...f.input, kind: 'waiting', run: plan })).toBe(true);
    expect(await notifyRunEvent({ ...f.input, kind: 'waiting', run: plan })).toBe(false);
    const revised = { ...plan, observation: { inspection: { planApproval: { planVersion: 'plan-v2' } } } } as WebRun;
    expect(await notifyRunEvent({ ...f.input, kind: 'waiting', run: revised })).toBe(true);
  });

  it('does not deliver a queued reminder or activate it after the owner leaves', async () => {
    const f = fixture(); let current = false;
    const input = { ...f.input, current: () => current };
    expect(await notifyRunEvent(input)).toBe(false);
    current = true; expect(await notifyRunEvent(input)).toBe(true);
    current = false; f.notices[0].onclick!(); expect(f.input.activate).not.toHaveBeenCalled();
  });
});
