import type { TrajectoryVersionDetail } from './trajectory';
import type { WebCheckReceipt } from './collaboration';
import type { WebRun } from './shared';
import { withoutCheckMarkers } from './report';

/** One answered question about a failed version, as the browser keeps it and sends it back for a follow-up. */
export type WebExplainTurn = { question: string; answer: string };
export type WebExplainUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
export type WebExplainAnswer = { answer: string; truncated?: true; usage?: WebExplainUsage };
// The browser mirrors these in client/trajectoryView.tsx.
export const webExplainLimits = { question: 2_000, answer: 6_000, turns: 5 } as const;
const contextLimits = { problem: 12_000, task: 4_000, objective: 1_000, source: 24_000, feedback: 12_000 } as const;
// Per owner: one question at a time, at most `questions` in any `ms`, so a stuck tab cannot run up a bill.
const pace = { ms: 10 * 60_000, questions: 20 } as const;

const clip = (text: string, limit: number) => text.length > limit ? `${text.slice(0, limit)}\n… (truncated)` : text;
// A fence longer than any run of backticks inside, so Lean or Markdown in the text cannot close it.
function fenced(text: string, language = '') {
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/gu)].map(run => run[0].length + 1)));
  return `${fence}${language}\n${text}\n${fence}`;
}

export const webExplainInstructions = [
  'You help a mathematician understand why one attempt at a Lean 4 proof was rejected by Lean.',
  'Work only from the problem, the attempt\'s code and Lean\'s output given in the first message. If they do not show the cause, say so instead of guessing.',
  'Explain the mathematical reason first, then the Lean detail behind the error, then the smallest change likely to fix it, with a short code snippet when it helps.',
  'Never claim a suggested change compiles or that the proof is finished: nothing you write is checked by Lean.',
  'Be brief. Answer in the language of the latest question.',
].join('\n');

/** What Lean said about the version's failed checks, with the checker's own delimiter lines removed; undefined when none failed. */
export function failedFeedback(checks: readonly WebCheckReceipt[]): string | undefined {
  const failed = checks.filter(check => check.record.passed !== true);
  if (!failed.length) return undefined;
  const parts = failed.map(check => {
    const record = check.record, name = typeof record.theoremName === 'string' ? record.theoremName : check.taskId;
    const status = typeof record.status === 'string' ? record.status : 'failed', seen = new Set<string>();
    const texts = (['error', 'stdoutPreview', 'stderrPreview'] as const).flatMap(key => {
      const raw = record[key], text = typeof raw !== 'string' ? '' : key === 'error' ? raw.trim() : withoutCheckMarkers(raw);
      if (!text || seen.has(text)) return [];
      seen.add(text);
      return [text];
    });
    return [`${name} (${status})`, ...texts].join('\n');
  });
  return clip(parts.join('\n\n'), contextLimits.feedback);
}

/**
 * The Responses API input for one question: the problem, the version's code and Lean's output ahead of the first
 * question, then the earlier turns, then the new question. Roles alternate, as some Chat-compatible gateways require.
 */
export function explainInput(run: Pick<WebRun, 'source' | 'task'>, version: TrajectoryVersionDetail, feedback: string,
  turns: readonly WebExplainTurn[], question: string, objective?: string) {
  const context = [
    `Problem, as given to the run (Lean, with \`sorry\` where proofs go):\n${fenced(clip(run.source, contextLimits.problem), 'lean')}`,
    `What the reader asked the run to do:\n${clip(run.task, contextLimits.task)}`,
    objective && `This attempt's task (${version.taskId}): ${clip(objective, contextLimits.objective)}`,
    version.source ? `The attempt (${version.source.file}):\n${fenced(clip(version.source.source, contextLimits.source), 'lean')}`
      : 'The attempt\'s code was not recorded.',
    `Lean's output for the attempt:\n${fenced(feedback)}`,
  ].filter(Boolean).join('\n\n');
  const questions = [...turns.map(turn => turn.question), question];
  return questions.flatMap((text, index) => [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: index ? text : `${context}\n\nQuestion: ${text}` }] },
    ...(index < turns.length ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: turns[index]!.answer }] }] : []),
  ]);
}

export class WebExplainError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
// The provider's own error text is not passed on: some echo part of the key.
const upstreamStatus: Record<number, string> = {
  401: '模型服务拒绝了这个 API Key。', 403: '模型服务拒绝了这个 API Key。',
  404: '模型服务不认识这个模型，或不支持 Responses API。', 429: '模型服务限流或额度不足，请稍后再问。',
};

export type WebExplainCall = { baseUrl: string; apiKey: string; model: string; input: unknown[]; timeoutMs?: number; instructions?: string; onText?(text: string): void };
/**
 * One streamed call to the provider's Responses API, the endpoint the run's workers use, with light reasoning and
 * nothing stored. Aborting `signal` (the reader closed the panel) stops it; so does running past `timeoutMs`.
 */
export async function askProvider(call: WebExplainCall, signal?: AbortSignal): Promise<WebExplainAnswer> {
  const timeout = AbortSignal.timeout(call.timeoutMs ?? 180_000);
  const active = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    // Redirects are refused so the key is never sent anywhere but the configured address.
    const response = await fetch(`${call.baseUrl}/responses`, { method: 'POST', redirect: 'error',
      signal: active,
      headers: { Authorization: `Bearer ${call.apiKey}`, 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ model: call.model, instructions: call.instructions ?? webExplainInstructions, input: call.input,
        reasoning: { effort: 'low' }, stream: true, store: false }) });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new WebExplainError(502, upstreamStatus[response.status] ?? `模型服务返回错误（HTTP ${response.status}）。`);
    }
    if (!/^text\/event-stream/iu.test(response.headers.get('content-type') ?? '')) {
      const body = await response.json() as Record<string, unknown>;
      active.throwIfAborted();
      return answerOf(outputText(body.output), true, body.usage);
    }
    const answer = await streamed(response.body!, active, call.onText);
    active.throwIfAborted();
    return answer;
  } catch (error) {
    if (error instanceof WebExplainError) throw error;
    if (signal?.aborted) throw new WebExplainError(499, '已停止。');
    if (timeout.aborted) throw new WebExplainError(504, '模型服务太久没有回答，请稍后再问。');
    throw new WebExplainError(502, '没能连上模型服务，或它的回答无法读取。');
  }
}

/** Reads the Responses event stream: text deltas until `response.completed`, whose usage it keeps. */
async function streamed(body: ReadableStream<Uint8Array>, signal: AbortSignal, onText?: (text: string) => void): Promise<WebExplainAnswer> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', usage: unknown, finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let end = /\r?\n\r?\n/u.exec(buffer); end; end = /\r?\n\r?\n/u.exec(buffer)) {
        const block = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        const data = block.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data) as Record<string, unknown>, response = event.response as Record<string, unknown> | undefined;
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
          text += event.delta;
          onText?.(text.trimStart().slice(0, webExplainLimits.answer));
          signal.throwIfAborted();
        }
        else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          usage = response?.usage; finished = event.type === 'response.completed';
          text ||= outputText(response?.output);
          return answerOf(text, finished, usage);
        } else if (event.type === 'response.failed' || event.type === 'error') throw new WebExplainError(502, '模型服务没能完成回答。');
      }
      // Far past what is shown, the rest would only cost more.
      if (text.length > webExplainLimits.answer * 2) return answerOf(text, false, usage);
    }
    return answerOf(text, finished, usage);
  } finally { await reader.cancel().catch(() => {}); }
}

function answerOf(raw: string, finished: boolean, usage: unknown): WebExplainAnswer {
  const text = raw.trim();
  if (!text) throw new WebExplainError(502, '模型服务没有给出回答。');
  const counted = usageOf(usage), cut = text.length > webExplainLimits.answer || !finished;
  return { answer: text.slice(0, webExplainLimits.answer), ...(cut ? { truncated: true } : {}), ...(counted ? { usage: counted } : {}) };
}
function outputText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  return output.flatMap(item => item && typeof item === 'object' && Array.isArray(item.content) ? item.content : [])
    .flatMap(part => part && typeof part === 'object' && part.type === 'output_text' && typeof part.text === 'string' ? [part.text] : []).join('');
}
function usageOf(value: unknown): WebExplainUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>, count = (raw: unknown) => Number.isSafeInteger(raw) && Number(raw) >= 0 ? Number(raw) : undefined;
  const usage = { inputTokens: count(row.input_tokens), outputTokens: count(row.output_tokens), totalTokens: count(row.total_tokens) };
  const kept = Object.fromEntries(Object.entries(usage).filter(([, item]) => item !== undefined)) as WebExplainUsage;
  return Object.keys(kept).length ? kept : undefined;
}

/**
 * Answers a reader's questions about a failed version with the run's own model and provider: a call the reader pays
 * for, separate from the run, which it never reaches. Nothing is stored; the browser keeps the thread.
 */
export class WebExplainer {
  private readonly busy = new Set<string>();
  private readonly asked = new Map<string, number[]>();
  constructor(private readonly timeoutMs = 180_000) {}
  counts() { return { running: this.busy.size, queued: 0 }; }

  async ask(owner: string, call: Omit<WebExplainCall, 'timeoutMs'>, signal?: AbortSignal): Promise<WebExplainAnswer> {
    const now = Date.now(), recent = (this.asked.get(owner) ?? []).filter(at => now - at < pace.ms);
    if (this.busy.has(owner)) throw new WebExplainError(429, '上一个问题还在回答，请等它结束或先停止。');
    if (recent.length >= pace.questions) throw new WebExplainError(429, '提问太频繁，请过几分钟再问。');
    this.busy.add(owner); this.asked.set(owner, [...recent, now]);
    try { return await askProvider({ ...call, timeoutMs: this.timeoutMs }, signal); }
    finally { this.busy.delete(owner); }
  }
  prune() {
    const now = Date.now();
    for (const [owner, times] of this.asked) if (times.every(at => now - at >= pace.ms)) this.asked.delete(owner);
  }
}
