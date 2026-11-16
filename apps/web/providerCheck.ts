import type { WebProvider } from './shared';

export class WebProviderCheckError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
/** Lists models only. It never submits a prompt, follows a redirect, or returns an upstream error body. */
export async function checkWebProvider(provider: WebProvider, apiKey: string, model: string) {
  if (provider.harness === 'cli') return { status: 'unknown' as const, message: '此服务通过配置的 CLI 调用；本次没有调用模型，连接将在执行时验证。' };
  const anthropic = provider.harness === 'claude-code';
  const protocol = anthropic ? 'Messages API' : 'Responses API';
  let response: Response;
  try {
    const endpoint = anthropic ? provider.baseUrl.replace(/\/v1\/?$/u, '').replace(/\/$/u, '') + '/v1/models'
      : provider.baseUrl.replace(/\/$/u, '') + '/models';
    response = await fetch(endpoint, {
      headers: anthropic ? { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', Accept: 'application/json' }
        : { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
  } catch { throw new WebProviderCheckError(502, '暂时无法连接模型服务，请检查服务状态后重试。'); }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new WebProviderCheckError(400, '模型服务拒绝了这个 API Key，请检查所属服务商与权限。');
  }
  if (!response.ok) {
    await response.body?.cancel();
    if (response.status === 429) throw new WebProviderCheckError(429, '模型服务暂时限流，请稍后再检查。');
    return { status: 'unknown' as const, message: `服务未提供可查询的模型列表；Key、模型与 ${protocol} 兼容性将在发送时验证。` };
  }
  const body = await response.json().catch(() => undefined) as { data?: { id?: string }[] } | undefined;
  if (!Array.isArray(body?.data) || !body.data.some(item => item?.id === model))
    return { status: 'unknown' as const, message: '模型列表中没有找到这个名称，请核对服务商的模型名；本次没有调用模型。' };
  return { status: 'available' as const, message: `Key 可访问模型列表，所选模型在列表中。本次没有调用模型；实际发送仍需服务支持 ${protocol}。` };
}
