import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkWebProvider } from '../apps/web/providerCheck';

const provider = { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' };
describe('provider connection check', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('only lists models, with no prompt or redirects, and qualifies the result', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'gpt-6.1-sol' }] }));
    vi.stubGlobal('fetch', fetcher);
    const result = await checkWebProvider(provider, 'synthetic-key', 'gpt-6.1-sol');
    expect(result.status).toBe('available'); expect(result.message).toContain('Responses API');
    expect(fetcher).toHaveBeenCalledWith(provider.baseUrl + '/models', expect.objectContaining({ redirect: 'error',
      headers: { Authorization: 'Bearer synthetic-key', Accept: 'application/json' } }));
    expect(fetcher.mock.calls[0][1]).not.toHaveProperty('body');
  });
  it('reports unavailable listing or missing models as unknown, never as a working model call', async () => {
    for (const response of [new Response('unsupported', { status: 404 }), Response.json({ data: [] }), new Response('invalid-json')]) {
      vi.stubGlobal('fetch', vi.fn(async () => response));
      expect((await checkWebProvider(provider, 'synthetic-key', 'gpt-6.1-sol')).status).toBe('unknown');
    }
  });
  it('uses the selected native provider protocol and leaves an arbitrary CLI to its declared protocol', async () => {
    const fetcher = vi.fn(async () => Response.json({ data: [{ id: 'fixture-model' }] }));
    vi.stubGlobal('fetch', fetcher);
    for (const baseUrl of ['https://models.example.test/v1', 'https://models.example.test/v1/', 'https://models.example.test']) {
      const result = await checkWebProvider({ ...provider, harness: 'claude-code', baseUrl }, 'synthetic-key', 'fixture-model');
      expect(result.status).toBe('available'); expect(result.message).toContain('Messages API');
      expect(fetcher).toHaveBeenLastCalledWith('https://models.example.test/v1/models', expect.objectContaining({
        redirect: 'error', headers: { 'x-api-key': 'synthetic-key', 'anthropic-version': '2023-06-01', Accept: 'application/json' } }));
    }
    fetcher.mockClear();
    expect((await checkWebProvider({ ...provider, harness: 'cli' }, 'synthetic-key', 'fixture-model')).status).toBe('unknown');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns useful status errors without exposing upstream bodies or credentials', async () => {
    for (const [status, expected] of [[401, 400], [403, 400], [429, 429]]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream-secret-detail', { status })));
      await expect(checkWebProvider(provider, 'synthetic-key', 'gpt-6.1-sol')).rejects.toMatchObject({ status: expected });
    }
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('synthetic-key'); }));
    await expect(checkWebProvider(provider, 'synthetic-key', 'gpt-6.1-sol')).rejects.toMatchObject({ status: 502,
      message: '暂时无法连接模型服务，请检查服务状态后重试。' });
  });
});
