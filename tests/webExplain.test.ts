import http from 'node:http';
import type net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { askProvider, explainInput, failedFeedback, webExplainInstructions, WebExplainer, webExplainLimits } from '../apps/web/explain';
import type { WebCheckReceipt } from '../apps/web/collaboration';
import type { TrajectoryVersionDetail } from '../apps/web/trajectory';

const key = 'sk-explain-offline-test';
type Seen = { headers: http.IncomingHttpHeaders; body: Record<string, unknown>; url: string };
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }))); });

/** A local stand-in for the provider; `reply` answers each request after its body has arrived. */
async function provider(reply: (response: http.ServerResponse, seen: Seen) => void) {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const item = { headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')), url: request.url ?? '' };
      seen.push(item); reply(response, item);
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { seen, baseUrl: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1` };
}
const sse = (events: unknown[]) => events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
const completed = (text: string) => [
  { type: 'response.created', response: { id: 'resp_1' } },
  ...[...text].map(delta => ({ type: 'response.output_text.delta', delta })),
  { type: 'response.completed', response: { id: 'resp_1', usage: { input_tokens: 812, output_tokens: 96, total_tokens: 908 } } },
];
const check = (id: string, record: Record<string, unknown>): WebCheckReceipt =>
  ({ id, taskId: 'goal_2', taskVersion: 'v1', commit: 'c'.repeat(40), sourceDigest: 'd'.repeat(64), environmentDigest: 'env', record });
const version: TrajectoryVersionDetail = { taskId: 'goal_2', commit: 'c'.repeat(40), checks: [],
  source: { taskId: 'goal_2', taskVersion: 'v1', commit: 'c'.repeat(40), sourceDigest: 'd'.repeat(64), environmentDigest: 'env',
    file: 'Submission.lean', source: 'theorem zero_add (n : Nat) : 0 + n = n := by rfl', scope: 'owned-file' } };
const call = (baseUrl: string, timeoutMs?: number) => ({ baseUrl, apiKey: key, model: 'fixture-model', input: [{ type: 'message', role: 'user', content: [] }],
  ...(timeoutMs ? { timeoutMs } : {}) });

describe('explaining a failed version', () => {
  it('passes on what Lean said about the failed checks only, without the checker\'s delimiters', () => {
    const feedback = failedFeedback([
      check('passed', { passed: true, theoremName: 'Tutorial.add_zero', stdoutPreview: 'all good' }),
      check('failed', { passed: false, status: 'failed', theoremName: 'Tutorial.zero_add',
        stdoutPreview: 'DEEPSCIENTIST_DECL_BEGIN_0123456789abcdef\nerror: The rfl tactic failed.\nDEEPSCIENTIST_DECL_END_0123456789abcdef', error: 'error: The rfl tactic failed.' }),
    ]);
    expect(feedback).toBe('Tutorial.zero_add (failed)\nerror: The rfl tactic failed.');
    expect(failedFeedback([check('passed', { passed: true })])).toBeUndefined();
    expect(failedFeedback([check('long', { passed: false, error: 'x'.repeat(20_000) })])!.length).toBeLessThan(12_100);
  });

  it('puts the problem, the code and Lean\'s output ahead of the first question and alternates the roles after it', () => {
    const run = { source: 'theorem zero_add (n : Nat) : 0 + n = n := by sorry', task: 'Prove ```both``` theorems.' };
    const input = explainInput(run, { ...version, source: { ...version.source!, source: 'a ```` b' } }, 'error: The rfl tactic failed.',
      [{ question: 'Why?', answer: 'Because `rfl` needs definitional equality.' }], 'Which lemma then?', 'Prove zero_add');
    expect(input.map(item => item.role)).toEqual(['user', 'assistant', 'user']);
    const first = (input[0]!.content[0] as { text: string }).text;
    for (const part of [run.source, run.task, 'Prove zero_add', 'Submission.lean', 'error: The rfl tactic failed.', 'Question: Why?']) expect(first).toContain(part);
    expect(first).toContain('`````lean\na ```` b\n`````');
    expect(input[1]!.content[0]).toEqual({ type: 'output_text', text: 'Because `rfl` needs definitional equality.' });
    expect(input[2]!.content[0]).toEqual({ type: 'input_text', text: 'Which lemma then?' });
    expect(explainInput(run, { ...version, source: undefined }, 'out', [], 'Why?')[0]!.content[0]).toMatchObject({ text: expect.stringContaining('was not recorded') });
  });

  it('streams the answer from the provider\'s Responses API with the key, the run\'s model and light reasoning', async () => {
    const mock = await provider(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Byte by byte, so events and multi-byte characters arrive split across reads.
      const bytes = Buffer.from(sse(completed('因为 `rfl` 只看定义。')));
      let offset = 0;
      const next = () => { if (offset >= bytes.length) { response.end(); return; } response.write(bytes.subarray(offset, offset += 7)); setImmediate(next); };
      next();
    });
    const partials: string[] = [];
    expect(await askProvider({ ...call(mock.baseUrl), onText: text => partials.push(text) })).toEqual({ answer: '因为 `rfl` 只看定义。', usage: { inputTokens: 812, outputTokens: 96, totalTokens: 908 } });
    expect(partials[0]).toBe('因');
    expect(partials.at(-1)).toBe('因为 `rfl` 只看定义。');
    expect(partials.every((text, index) => text.startsWith(partials[index - 1] ?? ''))).toBe(true);
    expect(JSON.stringify(mock.seen[0]!.body)).not.toContain('onText');
    expect(mock.seen[0]!.url).toBe('/v1/responses');
    expect(mock.seen[0]!.headers.authorization).toBe(`Bearer ${key}`);
    expect(mock.seen[0]!.body).toMatchObject({ model: 'fixture-model', stream: true, store: false, reasoning: { effort: 'low' }, instructions: webExplainInstructions });
  });

  it('reads a plain JSON reply, keeps what an unfinished stream sent and cuts a long answer', async () => {
    const json = await provider(response => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text: 'Plain answer.' }] }],
        usage: { input_tokens: 10, output_tokens: 3 } }));
    });
    expect(await askProvider(call(json.baseUrl))).toEqual({ answer: 'Plain answer.', usage: { inputTokens: 10, outputTokens: 3 } });
    const cut = await provider(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(sse(completed('partial').slice(0, -1)));
    });
    expect(await askProvider(call(cut.baseUrl))).toEqual({ answer: 'partial', truncated: true });
    const long = await provider(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(sse([{ type: 'response.output_text.delta', delta: 'x'.repeat(webExplainLimits.answer + 10) }, { type: 'response.completed', response: {} }]));
    });
    const answer = await askProvider(call(long.baseUrl));
    expect(answer.answer).toHaveLength(webExplainLimits.answer); expect(answer.truncated).toBe(true);
  });

  it('stops delivering buffered events and rejects completion when onText aborts the request', async () => {
    const mock = await provider(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(sse([
        { type: 'response.output_text.delta', delta: 'first' },
        { type: 'response.output_text.delta', delta: ' late' },
        { type: 'response.completed', response: {} },
      ]));
    });
    const stop = new AbortController(), partials: string[] = [];
    await expect(askProvider({ ...call(mock.baseUrl), onText: text => { partials.push(text); stop.abort(); } }, stop.signal))
      .rejects.toMatchObject({ status: 499 });
    expect(partials).toEqual(['first']);
  });

  it('names what went wrong without passing on the provider\'s text, and stops on abort or timeout', async () => {
    const rejected = await provider(response => { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: `bad key ${key}` })); });
    const error = await askProvider(call(rejected.baseUrl)).catch(caught => caught);
    expect(error).toMatchObject({ status: 502, message: '模型服务拒绝了这个 API Key。' });
    expect(JSON.stringify(error) + error.message).not.toContain(key);
    const failed = await provider(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse([{ type: 'response.failed', response: {} }])); });
    await expect(askProvider(call(failed.baseUrl))).rejects.toMatchObject({ status: 502, message: '模型服务没能完成回答。' });
    const empty = await provider(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse([{ type: 'response.completed', response: {} }])); });
    await expect(askProvider(call(empty.baseUrl))).rejects.toMatchObject({ status: 502, message: '模型服务没有给出回答。' });
    const silent = await provider(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.write(': waiting\n\n'); });
    await expect(askProvider(call(silent.baseUrl, 300))).rejects.toMatchObject({ status: 504 });
    const stop = new AbortController(), asked = askProvider(call(silent.baseUrl), stop.signal);
    setTimeout(() => stop.abort(), 100);
    await expect(asked).rejects.toMatchObject({ status: 499 });
    await expect(askProvider(call('http://127.0.0.1:9/v1'))).rejects.toMatchObject({ status: 502, message: '没能连上模型服务，或它的回答无法读取。' });
  });

  it('answers one question per owner at a time and at most twenty in ten minutes', async () => {
    let release = () => {};
    const mock = await provider(response => {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      release = () => response.end(sse(completed('ok')));
    });
    const explainer = new WebExplainer(5_000), first = explainer.ask('alice', call(mock.baseUrl));
    for (let wait = 0; !mock.seen.length && wait < 100; wait++) await new Promise(resolve => setTimeout(resolve, 10));
    await expect(explainer.ask('alice', call(mock.baseUrl))).rejects.toMatchObject({ status: 429 });
    release();
    expect((await first).answer).toBe('ok');
    const quick = await provider(response => { response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.end(sse(completed('ok'))); });
    for (let index = 0; index < 19; index++) await explainer.ask('alice', call(quick.baseUrl));
    await expect(explainer.ask('alice', call(quick.baseUrl))).rejects.toMatchObject({ status: 429, message: '提问太频繁，请过几分钟再问。' });
    expect((await explainer.ask('bob', call(quick.baseUrl))).answer).toBe('ok');
  });
});
