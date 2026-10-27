import crypto from 'node:crypto';
import { inspectScopedLeanDeclarations } from '../../src/math/leanSource';
import { maskLeanCommentsAndStrings } from '../../src/math/leanSyntax';
import type { WebEnvironment, WebPrecheck, WebPrecheckDiagnostic } from './shared';

/** What the runner reports for one compile of the statement; `output` is Lean's `--json` stream. */
export type WebPrecheckOutput = { output: string; exitCode: number | null; timedOut: boolean };
export type WebPrecheckRunner = (input: { environment: WebEnvironment; source: string }, signal: AbortSignal) => Promise<WebPrecheckOutput>;

const maxDiagnostics = 40, maxMessage = 1_500;
// Lean counts lines from 1 and columns in code points from 0; offsets here are JavaScript string indexes.
function position(source: string, offset: number) {
  const before = source.slice(0, offset), start = before.lastIndexOf('\n') + 1;
  return { line: before.split('\n').length, column: [...before.slice(start)].length };
}

/**
 * The checks bootstrapLeanTask makes before a run starts, with a position for each, so the editor can point at the
 * problem without starting Lean. tests/webPrecheck.test.ts keeps the codes in step with src/math/leanTask.ts.
 */
export function inspectStatement(source: string): WebPrecheckDiagnostic[] {
  const found: WebPrecheckDiagnostic[] = [];
  const add = (code: string, offset: number, name?: string) =>
    found.push({ severity: 'error', code, ...position(source, offset), ...(name ? { name } : {}) });
  // With the u flag a surrogate class only matches unpaired halves, which do not survive UTF-8.
  const invalid = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff]/u.exec(source);
  if (invalid) { add('lean_task_input_invalid', invalid.index); return found; }
  const declarations = inspectScopedLeanDeclarations(source);
  if (declarations.length > 256) { add('lean_task_declarations_limit', declarations[256].startOffset); return found; }
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const name = declaration.name.split('.').at(-1)!;
    if (seen.has(name)) add('lean_task_declaration_names_ambiguous', declaration.startOffset, name);
    seen.add(name);
  }
  const targets = new Set(declarations.filter(item => item.kind === 'theorem').map(item => item.startOffset));
  if (!targets.size) add('lean_task_targets_missing', 0);
  for (const keyword of maskLeanCommentsAndStrings(source).matchAll(
    /(?<![\p{L}\p{M}\p{N}_'.?!])(?:theorem|lemma)(?![\p{L}\p{M}\p{N}_'.?!])/gu))
    if (!targets.has(keyword.index)) add('lean_task_declaration_invalid', keyword.index);
  return found.slice(0, maxDiagnostics);
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const place = (value: unknown) => isRecord(value) && Number.isSafeInteger(value.line) && Number(value.line) >= 1 &&
  Number.isSafeInteger(value.column) && Number(value.column) >= 0 ? { line: Number(value.line), column: Number(value.column) } : undefined;

/** Reads `lean --json` lines. Sorry warnings become the target count; `#eval` output and silent messages are dropped. */
export function leanDiagnostics(output: string) {
  const diagnostics: WebPrecheckDiagnostic[] = [];
  let sorries = 0, errors = 0;
  for (const line of output.split('\n')) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!isRecord(value) || value.isSilent === true || typeof value.data !== 'string') continue;
    const severity = value.severity, at = place(value.pos);
    if ((severity !== 'error' && severity !== 'warning') || !at) continue;
    if (severity === 'warning' && (value.kind === 'hasSorry' || /^declaration uses [`']sorry[`']$/u.test(value.data))) { sorries++; continue; }
    if (severity === 'error') errors++;
    if (diagnostics.length >= maxDiagnostics) continue;
    const end = place(value.endPos);
    diagnostics.push({ severity, ...at, ...(end ? { endLine: end.line, endColumn: end.column } : {}),
      message: value.data.length > maxMessage ? `${value.data.slice(0, maxMessage)}…` : value.data });
  }
  // Errors first, each group in source order, so the first entry is the one to fix.
  diagnostics.sort((a, b) => Number(a.severity === 'warning') - Number(b.severity === 'warning') || a.line - b.line || a.column - b.column);
  return { diagnostics, sorries, errors };
}

/** Turns one compile into a result. A crash without a diagnostic is the service's problem, not the statement's. */
export function precheckResult(environment: WebEnvironment, run: WebPrecheckOutput, targets: number): WebPrecheck {
  const { diagnostics, sorries, errors } = leanDiagnostics(run.output);
  const base = { environment, targets, sorries, diagnostics };
  if (run.timedOut) return { ...base, status: 'timeout' };
  if (errors) return { ...base, status: 'errors' };
  if (run.exitCode !== 0) return { ...base, status: 'unavailable' };
  return { ...base, status: sorries ? 'ready' : 'complete' };
}

export class PrecheckSuperseded extends Error {}

/**
 * Compiles statements for the editor. Each owner has at most one check in flight (a newer one replaces it), the
 * service runs a few at a time with a short queue, and identical statements come from a small cache.
 */
export class WebPrechecker {
  private readonly cache = new Map<string, WebPrecheck>();
  private readonly inflight = new Map<string, AbortController>();
  private readonly recent = new Map<string, number[]>();
  private readonly waiting: Array<() => void> = [];
  private running = 0;
  constructor(private readonly runner: WebPrecheckRunner,
    private readonly limits = { concurrency: 2, queue: 6, perMinute: 20, cache: 200 }) {}

  async check(owner: string, input: { environment: WebEnvironment; source: string }, signal: AbortSignal): Promise<WebPrecheck> {
    const structural = inspectStatement(input.source);
    const targets = structural.some(item => item.code === 'lean_task_input_invalid') ? 0
      : inspectScopedLeanDeclarations(input.source).filter(item => item.kind === 'theorem').length;
    if (structural.length) return { status: 'invalid', environment: input.environment, targets, sorries: 0, diagnostics: structural };
    const key = crypto.createHash('sha256').update(`${input.environment}\0${input.source}`).digest('hex');
    const cached = this.cache.get(key);
    if (cached) { this.cache.delete(key); this.cache.set(key, cached); return { ...cached, cached: true }; }
    const busy = (): WebPrecheck => ({ status: 'busy', environment: input.environment, targets, sorries: 0, diagnostics: [] });
    const now = Date.now(), times = (this.recent.get(owner) ?? []).filter(time => now - time < 60_000);
    if (times.length >= this.limits.perMinute) { this.recent.set(owner, times); return busy(); }
    this.inflight.get(owner)?.abort(new PrecheckSuperseded());
    const controller = new AbortController();
    this.inflight.set(owner, controller);
    const stop = () => controller.abort(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    try {
      if (this.running >= this.limits.concurrency) {
        if (this.waiting.length >= this.limits.queue) return busy();
        await new Promise<void>((resolve, reject) => {
          const turn = () => { controller.signal.removeEventListener('abort', leave); resolve(); };
          const leave = () => { this.waiting.splice(this.waiting.indexOf(turn), 1); reject(controller.signal.reason); };
          this.waiting.push(turn);
          controller.signal.addEventListener('abort', leave, { once: true });
        });
      } else this.running++;
      times.push(now); this.recent.set(owner, times);
      try {
        controller.signal.throwIfAborted();
        let output: WebPrecheckOutput | undefined;
        try { output = await this.runner(input, controller.signal); }
        catch { if (controller.signal.aborted) throw controller.signal.reason; }
        controller.signal.throwIfAborted();
        if (!output) return { status: 'unavailable', environment: input.environment, targets, sorries: 0, diagnostics: [] };
        const result = precheckResult(input.environment, output, targets);
        // Only a finished compile describes the statement; timeouts and failures may pass on the next try.
        if (['errors', 'ready', 'complete'].includes(result.status)) {
          this.cache.set(key, result);
          if (this.cache.size > this.limits.cache) this.cache.delete(this.cache.keys().next().value!);
        }
        return result;
      } finally {
        const next = this.waiting.shift();
        if (next) next(); else this.running--;
      }
    } finally {
      signal.removeEventListener('abort', stop);
      if (this.inflight.get(owner) === controller) this.inflight.delete(owner);
    }
  }

  prune() {
    const now = Date.now();
    for (const [owner, times] of this.recent) if (times.every(time => now - time >= 60_000)) this.recent.delete(owner);
  }

  close() { for (const controller of this.inflight.values()) controller.abort(new PrecheckSuperseded()); }
}
