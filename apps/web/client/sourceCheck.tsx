import { render } from 'preact';
import type { WebEnvironment, WebPrecheck, WebPrecheckDiagnostic } from '../shared';
import { Icon, Spinner } from './ui/Icon';
import { t } from '../i18n';

/** Structural findings carry a code; Lean's own diagnostics keep Lean's wording. */
const codeMessages: Record<string, () => string> = {
  lean_task_input_invalid: () => t('这里有控制字符或无法编码的字符，提交时会被拒绝'),
  lean_task_declarations_limit: () => t('声明超过 256 个，请拆分题目'),
  lean_task_declaration_names_ambiguous: () => t('与前面的声明同名；不同命名空间里的同名声明也会被拒绝'),
  lean_task_targets_missing: () => t('没有找到 theorem 或 lemma，题目至少需要一个待证定理'),
  lean_task_declaration_invalid: () => t('这里的 theorem/lemma 没有被识别为顶层定理声明，请检查名称写法，且不要用它作标识符'),
};
export const diagnosticText = (diagnostic: WebPrecheckDiagnostic) =>
  diagnostic.code ? (codeMessages[diagnostic.code]?.() ?? t('原题不符合提交要求')) : diagnostic.message ?? '';

/** Lean reports lines from 1 and columns in code points; the textarea selects by UTF-16 index. */
export function sourceOffset(source: string, line: number, column: number) {
  const lines = source.split('\n');
  let offset = 0;
  for (let index = 0; index < Math.min(line - 1, lines.length - 1); index++) offset += lines[index].length + 1;
  const text = lines[Math.min(line - 1, lines.length - 1)] ?? '';
  let units = 0;
  for (const character of [...text].slice(0, column)) units += character.length;
  return offset + units;
}

export type SourceCheckState =
  | { phase: 'idle' }
  | { phase: 'checking'; key: string; previous?: WebPrecheck }
  | { phase: 'done'; key: string; result: WebPrecheck }
  | { phase: 'failed'; key: string; message: string };
type Input = { environment: WebEnvironment; source: string };
const keyOf = (input: Input) => `${input.environment}\0${input.source}`;

/**
 * Compiles the statement shortly after it stops changing. Only a finished result for the exact current text can
 * block a submission, and the user can dismiss it; a check that is slow, busy or unavailable never blocks.
 */
export class SourceCheck {
  state: SourceCheckState = { phase: 'idle' };
  private overridden = '';
  private scheduled = '';
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  constructor(private readonly options: {
    input(): Input; enabled(): boolean; render(): void;
    post(input: Input, signal: AbortSignal): Promise<WebPrecheck>;
    superseded(error: unknown): boolean; message(error: unknown): string; delay?: number;
  }) {}

  /** Called on every draft change; repeated calls for the same text do nothing. */
  schedule() {
    const input = this.options.input(), key = keyOf(input);
    if (!this.options.enabled() || !input.source.trim()) {
      const shown = this.state.phase !== 'idle' || this.scheduled !== '';
      clearTimeout(this.timer); this.scheduled = '';
      this.controller?.abort(); this.controller = undefined;
      this.state = { phase: 'idle' };
      if (shown) this.options.render();
      return;
    }
    if (this.scheduled === key) return;
    clearTimeout(this.timer);
    // Back to text that was already checked (or is being checked): nothing new to compile.
    if ('key' in this.state && this.state.key === key) {
      if (this.scheduled) { this.scheduled = ''; this.options.render(); }
      return;
    }
    this.scheduled = key;
    this.options.render();
    this.timer = setTimeout(() => { void this.run(); }, this.options.delay ?? 900);
  }

  async run() {
    clearTimeout(this.timer); this.scheduled = '';
    if (!this.options.enabled()) return;
    const input = this.options.input(), key = keyOf(input);
    if (!input.source.trim()) return;
    this.controller?.abort();
    const controller = this.controller = new AbortController();
    this.state = { phase: 'checking', key, previous: this.latest() };
    this.options.render();
    try {
      const result = await this.options.post(input, controller.signal);
      if (controller === this.controller) this.state = { phase: 'done', key, result };
    } catch (error) {
      if (controller !== this.controller || controller.signal.aborted || this.options.superseded(error)) return;
      this.state = { phase: 'failed', key, message: this.options.message(error) };
    } finally {
      if (controller === this.controller) { this.controller = undefined; this.options.render(); }
    }
  }

  /** The last finished result, for whatever text it was for. */
  latest() {
    return this.state.phase === 'done' ? this.state.result : this.state.phase === 'checking' ? this.state.previous : undefined;
  }
  /** The finished result for exactly the text in the editor, if there is one. */
  current() {
    return this.state.phase === 'done' && !this.stale() ? this.state.result : undefined;
  }
  /** True when the shown result no longer describes the text in the editor. */
  stale() {
    if (this.scheduled) return true;
    return this.state.phase !== 'idle' && this.state.key !== keyOf(this.options.input());
  }
  /** Errors in the current text that would stop a submission, unless the user chose to submit anyway. */
  blocking(): WebPrecheckDiagnostic | undefined {
    if (this.state.phase !== 'done' || this.stale() || this.overridden === this.state.key) return;
    const { result } = this.state;
    // A structural failure is rejected by the server as well, so it cannot be dismissed.
    if (result.status === 'invalid') return result.diagnostics[0];
    if (result.status === 'errors') return result.diagnostics.find(item => item.severity === 'error');
  }
  dismissible() { return this.state.phase === 'done' && this.state.result.status === 'errors' && Boolean(this.blocking()); }
  dismiss() { if (this.state.phase === 'done') { this.overridden = this.state.key; this.options.render(); } }
}

type Tone = 'good' | 'bad' | 'warn' | 'neutral' | 'busy';
function summary(check: SourceCheck): { tone: Tone; title: string; detail: string; chip: string } | undefined {
  const { state } = check;
  if (state.phase === 'idle') return check.stale() ? { tone: 'neutral', title: t('源码已修改，稍后自动检查'), detail: '', chip: t('待检查') } : undefined;
  if (state.phase === 'checking') return { tone: 'busy', title: t('正在用 Lean 检查原题'), detail: t('引入 Mathlib 时首次检查约需半分钟。'), chip: t('检查中') };
  if (state.phase === 'failed') return { tone: 'warn', title: t('检查未完成'), detail: t('{0}。仍可提交。', state.message), chip: t('未检查') };
  if (check.stale()) return { tone: 'neutral', title: t('源码已修改，稍后自动检查'), detail: t('下方是修改前的检查结果。'), chip: t('待检查') };
  const { result } = state;
  const errors = result.diagnostics.filter(item => item.severity === 'error').length;
  const warnings = result.diagnostics.filter(item => item.severity === 'warning').length;
  const extra = warnings ? t('另有 {0} 条警告。', warnings) : '';
  switch (result.status) {
    case 'invalid': return { tone: 'bad', title: t('原题不符合提交要求'), detail: t('修改下列位置后才能提交。'), chip: t('不符合要求') };
    case 'errors': return { tone: 'bad', title: t('Lean 报告 {0} 处错误', errors), detail: t('原题需要先能编译，Agent 才能开始证明。') + extra, chip: t('{0} 处错误', errors) };
    case 'ready': return { tone: 'good', title: t('原题可以编译'), detail: t('{0} 处 sorry 待证明。', result.sorries) + extra, chip: t('可编译') };
    case 'complete': return { tone: 'neutral', title: t('原题可以编译，且没有 sorry'), detail: t('没有需要证明的部分；如需研究，请把待证部分写成 sorry。') + extra, chip: t('无 sorry') };
    case 'timeout': return { tone: 'warn', title: t('检查超时'), detail: t('运行时有更长的时间预算，仍可提交。'), chip: t('未检查') };
    case 'busy': return { tone: 'warn', title: t('检查服务繁忙，本次未检查'), detail: t('仍可提交，或稍后重新检查。'), chip: t('未检查') };
    default: return { tone: 'warn', title: t('检查服务暂不可用'), detail: t('仍可提交。'), chip: t('未检查') };
  }
}

type ViewProps = { check: SourceCheck; onJump(diagnostic: WebPrecheckDiagnostic): void; onRecheck(): void };
function SourceCheckPanel({ check, onJump, onRecheck }: ViewProps) {
  const shown = summary(check);
  if (!shown) return null;
  const result = check.latest();
  const diagnostics = result?.diagnostics ?? [];
  return <div class="source-check" data-tone={shown.tone} data-stale={String(check.stale())}>
    <div class="source-check-head">
      <span class="source-check-icon" aria-hidden="true">{shown.tone === 'busy' ? <Spinner /> : <Icon name={shown.tone === 'good' ? 'circle-check' : 'circle-alert'} />}</span>
      <div class="source-check-copy"><p role="status" aria-atomic="true">{shown.title}</p>{shown.detail && <p>{shown.detail}</p>}</div>
      <button type="button" id="recheck-source" class="text-button" disabled={check.state.phase === 'checking'} onClick={onRecheck}><Icon name="refresh-cw" /><span>{t('重新检查')}</span></button>
    </div>
    {diagnostics.length > 0 && <ol class="source-check-list" aria-label={t('检查结果')}>
      {diagnostics.map((diagnostic, index) => <li key={index} data-severity={diagnostic.severity}>
        <button type="button" class="source-check-item" onClick={() => onJump(diagnostic)}>
          <span class="source-check-line">{t('第 {0} 行', diagnostic.line)}</span>
          <span class="source-check-severity">{diagnostic.severity === 'error' ? t('错误') : t('警告')}</span>
          <span class="source-check-message" translate={diagnostic.code ? undefined : false}>{diagnosticText(diagnostic)}</span>
        </button>
      </li>)}
    </ol>}
    {check.dismissible() && <button type="button" id="dismiss-source-check" class="text-button source-check-dismiss" onClick={() => check.dismiss()}>{t('忽略检查结果，仍然提交')}</button>}
  </div>;
}

function SourceCheckChip({ check, onOpen }: { check: SourceCheck; onOpen(): void }) {
  const shown = summary(check);
  if (!shown) return null;
  return <button type="button" id="source-check-chip" class="source-check-chip" data-tone={shown.tone} title={shown.title}
    aria-label={t('原题检查：{0}', shown.title)} onClick={onOpen}>
    {shown.tone === 'busy' ? <Spinner /> : <Icon name={shown.tone === 'good' ? 'circle-check' : 'circle-alert'} />}<span>{shown.chip}</span>
  </button>;
}

export function renderSourceCheck(panel: HTMLElement, chip: HTMLElement, props: ViewProps & { onOpen(): void }) {
  render(<SourceCheckPanel {...props} />, panel);
  render(<SourceCheckChip check={props.check} onOpen={props.onOpen} />, chip);
}
