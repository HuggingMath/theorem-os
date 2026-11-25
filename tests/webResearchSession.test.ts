import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, bindResearchSession, clearResearchSession, errorText, readResearchWebSession, ResearchHttpError, resetResearchCooldowns } from '../apps/web/client/researchShared';
import type { WebSession } from '../apps/web/shared';

const web = (csrfToken = 'first-session', draftOwner = 'same-person') => ({ csrfToken, draftOwner } as WebSession);
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status, headers: { 'Content-Type': 'application/json', 'X-Theoremos-Owner': 'same-person' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
afterEach(() => { clearResearchSession(); resetResearchCooldowns(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('research session generations and readable receipts', () => {
  it('keeps same-session work but cancels old requests when the same person signs in again', async () => {
    const changed = vi.fn(), started = deferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!; started.resolve(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    bindResearchSession(web(), changed);
    const pending = api('/api/research/people');
    const signal = await started.promise;
    bindResearchSession(web(), changed); expect(signal.aborted).toBe(false);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    bindResearchSession(web('next-session'), changed);
    await rejected; expect(signal.aborted).toBe(true); expect(changed).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => json({ item: 'next-session-data' })));
    await expect(api('/api/research/people')).resolves.toEqual({ item: 'next-session-data' });
  });

  it('rejects an old session body that finishes parsing after a renewed session is bound', async () => {
    const body = deferred<unknown>(), started = deferred<void>();
    const response = json(null);
    vi.spyOn(response, 'json').mockImplementation(() => { started.resolve(); return body.promise; });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    bindResearchSession(web(), vi.fn());
    const pending = api('/api/research/people'); await started.promise;
    bindResearchSession(web('next-session'), vi.fn()); body.resolve({ item: 'old-session-data' });
    const cancelled = await pending.catch(cause => cause);
    expect(cancelled).toMatchObject({ name: 'AbortError' });
    expect(errorText(cancelled)).toContain('当前输入已保留');
  });

  it('cancels a concurrent identity check when its bound session is replaced', async () => {
    const started = deferred<AbortSignal>();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!; started.resolve(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    bindResearchSession(web(), vi.fn());
    const pending = readResearchWebSession(new AbortController().signal); const signal = await started.promise;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    bindResearchSession(web('next-session'), vi.fn()); await rejected; expect(signal.aborted).toBe(true);
  });

  it('does not send an old form during session rotation and lets an explicit retry use the new session', async () => {
    const changed = vi.fn();
    const fetcher = vi.fn(async (url: string) => url === '/api/session' ? json(web('next-session')) : json({ item: 'saved' }, 201));
    vi.stubGlobal('fetch', fetcher); bindResearchSession(web(), changed);
    const input = { method: 'POST', body: JSON.stringify({ requestId: 'original-intent', name: 'My retained edit' }) };
    await expect(api('/api/research/library', input)).rejects.toThrow('当前输入已保留');
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/session']); expect(changed).not.toHaveBeenCalled();
    await expect(api('/api/research/library', input)).resolves.toEqual({ item: 'saved' });
    const writes = fetcher.mock.calls.filter(call => call[0] === '/api/research/library');
    expect(writes).toHaveLength(1);
    const [, options] = (writes[0] as unknown as [string, RequestInit]);
    expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('next-session');
    expect(JSON.parse(String(options.body)).requestId).toBe('original-intent');
  });

  it.each([200, 201, 202])('treats an unreadable successful %i receipt as uncertain instead of saved', async status => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"item":', { status, headers: { 'X-Theoremos-Owner': 'same-person' } })));
    bindResearchSession(web(), vi.fn());
    const error = await api('/api/research/library').catch(cause => cause);
    expect(error).toBeInstanceOf(Error); expect(error).not.toBeInstanceOf(ResearchHttpError);
    expect(error.message).toContain('响应未能完整读取');
  });

  it('keeps definite error statuses when their error body is unreadable and permits documented no-content replies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<broken error>', { status: 409, headers: { 'X-Theoremos-Owner': 'same-person' } })));
    bindResearchSession(web(), vi.fn());
    await expect(api('/api/research/library')).rejects.toMatchObject({ status: 409 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204, headers: { 'X-Theoremos-Owner': 'same-person' } })));
    await expect(api('/api/research/library')).resolves.toBeUndefined();
  });

  it('honors Retry-After address limits and Cloudflare 1015/challenge cooldowns without repeating requests', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T05:00:00Z'));
    const fetcher = vi.fn(async (url: string) => url === '/api/research/overview'
      ? new Response(JSON.stringify({ error: '请求过于频繁，请稍后重试。' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '15', 'X-Theoremos-Owner': 'same-person', 'X-Theoremos-Rate-Limit-Scope': 'api' },
      })
      : json({ items: [] }));
    vi.stubGlobal('fetch', fetcher);
    bindResearchSession(web(), vi.fn());

    await expect(api('/api/research/overview')).rejects.toMatchObject({ status: 429 });
    await expect(api('/api/research/people')).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(15_001);
    await expect(api('/api/research/people')).resolves.toEqual({ items: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const challengeFetcher = vi.fn(async () => new Response('<html>Challenge</html>', {
      status: 403, headers: { 'cf-mitigated': 'challenge' },
    }));
    vi.stubGlobal('fetch', challengeFetcher);
    await expect(api('/api/research/theorems')).rejects.toMatchObject({ status: 403 });
    await expect(api('/api/research/theorems')).rejects.toMatchObject({ status: 403 });
    expect(challengeFetcher).toHaveBeenCalledTimes(1);
  });
});
