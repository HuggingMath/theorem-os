import { render } from 'preact';
import { useState } from 'preact/hooks';
import type { WebRun, WebSession } from '../shared';
import type { NextStep } from '../report';
import { locale } from '../i18n';
import { formatTokens, readableDuration } from '../presentation';
import { compareResearchRuns, recoveryDescription, type ContinuationPreview } from './productFlow';
import { Icon } from './ui/Icon';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
export function StartGuide(props: { onTemplate(): void; onLean(): void; onConfigure?(): void; ready: boolean }) {
  const [intent, setIntent] = useState<'statement' | 'lean'>('statement');
  return <section class="research-start-guide" data-start-guide aria-label={tx('准备第一道题', 'Prepare your first problem')}>
    <div class="research-intents" role="group" aria-label={tx('研究起点', 'Starting point')}>
      <button type="button" aria-pressed={intent === 'statement'} onClick={() => setIntent('statement')}>{tx('我有一个数学命题', 'I have a mathematical claim')}</button>
      <button type="button" aria-pressed={intent === 'lean'} onClick={() => setIntent('lean')}>{tx('我有 Lean 证明草稿', 'I have a Lean proof draft')}</button>
    </div>
    <p>{intent === 'statement' ? tx('写清对象、假设和结论。核对 Lean 陈述后，可选择先审初始路线再开始证明。', 'State the objects, assumptions and claim. After reviewing the Lean statement, you can choose to approve the initial route before proving.')
      : tx('准备完整的 import、定理声明和未完成证明，选择匹配环境后继续。', 'Prepare the imports, theorem statement and unfinished proof, then select the matching environment.')}</p>
    <p class="research-start-delivery">{tx('完成后可阅读证明路线、Lean 源码与独立验收记录。', 'Read the proof route, Lean source and independent acceptance record when the run finishes.')}</p>
    <button type="button" class="button" data-start-prepare onClick={intent === 'statement' ? props.onTemplate : props.onLean}>{intent === 'statement' ? tx('填写命题模板', 'Use a statement template') : tx('打开 Lean 编辑器', 'Open the Lean editor')}<Icon name="arrow-right" /></button>
    <p class="research-setup-state">{props.ready ? tx('模型连接信息已填写，发送前可在设置中检查连接与预算。', 'Model details are filled in. Check the connection and budget in settings before submitting.') : tx('首次提交还需配置模型连接。', 'Configure a model connection before your first submission.')} {!props.ready && <button type="button" class="text-button" onClick={props.onConfigure}>{tx('配置模型', 'Configure model')}</button>}</p>
  </section>;
}

export function RecoveryChoices(props: { run: WebRun; steps: NextStep[]; limits?: WebSession['limits']; onAction?(id: string, button: HTMLButtonElement): void }) {
  if (!props.steps.length) return null;
  return <section class="research-recovery-choices" data-recovery-choices aria-label={tx('选择怎样继续', 'Choose how to continue')}>
    <h4>{tx('接下来怎样继续？', 'How would you like to continue?')}</h4>
    {props.steps.map(step => <div key={step.id} class="research-recovery-choice">
      <button type="button" class="button" data-action={props.onAction ? undefined : 'recover'} data-recovery={step.id} data-chat-recovery={props.onAction ? step.id : undefined}
        onClick={props.onAction ? event => props.onAction!(step.id, event.currentTarget) : undefined}>{step.label}</button>
      <p>{recoveryDescription(props.run, step, props.limits)}</p>
    </div>)}
  </section>;
}

export function RunResearchComparison({ before, after }: { before: WebRun; after: WebRun }) {
  const comparison = compareResearchRuns(before, after);
  return <section class="research-run-comparison" data-research-comparison data-comparable={comparison.comparable}>
    <h3>{tx('两次研究取得了什么进展', 'Progress across the two runs')}</h3>
    {!comparison.comparable && <p role="note">{tx('题意、Lean 陈述或环境不同，下面分别列出记录，不计算进展增量。', 'The original meaning, Lean statement or environment differs. These are separate records; no progress delta is calculated.')}</p>}
    <div class="research-comparison-scroll" tabIndex={0} aria-label={tx('研究结果比较', 'Research result comparison')}><table>
      <thead><tr><th scope="col">{tx('项目', 'Item')}</th><th scope="col"><a href={`?run=${encodeURIComponent(before.id)}`}>{tx('这次研究', 'This run')}</a></th><th scope="col"><a href={`?run=${encodeURIComponent(after.id)}`}>{tx('对照研究', 'Compared run')}</a></th></tr></thead>
      <tbody>{comparison.rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td translate={false}>{row.before}</td><td translate={false}>{row.after}</td></tr>)}</tbody>
    </table></div>
    {before.observation?.plan && after.observation?.plan && <details><summary>{tx('任务与依赖变化', 'Task and dependency changes')} · {comparison.changedTasks.length}</summary>
      {comparison.changedTasks.length ? <ul>{comparison.changedTasks.map(task => <li key={task.id}><span>{task.kind === 'added' ? tx('新增', 'Added') : task.kind === 'removed' ? tx('移除', 'Removed') : tx('调整', 'Changed')} · </span><span translate={false}>{task.label}</span></li>)}</ul>
        : <p>{tx('已记录的任务目标和前置依赖相同。', 'The recorded task objectives and prerequisites are unchanged.')}</p>}</details>}
    <div class="chat-task-actions"><a class="button" href={`?run=${encodeURIComponent(before.id)}`}>{tx('查看这次研究', 'View this run')}</a><a class="button" href={`?run=${encodeURIComponent(after.id)}`}>{tx('查看对照研究并继续', 'View the compared run and continue')}</a></div>
  </section>;
}

export function renderContinuationPreview(host: HTMLElement, context: ContinuationPreview | undefined, settings: { seconds: number; turns: number; tokens?: number }) {
  host.hidden = !context;
  if (!context) { render(null, host); return; }
  render(<section class="research-continuation-preview" data-continuation-preview>
    <h3>{tx('确认续研究起点', 'Review the continuation')}</h3><p translate={false}>{context.title}</p>
    <dl><dt>{tx('带入版本', 'Carried version')}</dt><dd>{context.from ? <><span translate={false}>{context.from.label}</span><code translate={false}>{context.from.commit}</code></> : tx('原始题目；不自动带入候选代码', 'Original problem; candidate code is not carried automatically')}</dd>
      <dt>{tx('下一步', 'Next step')}</dt><dd>{tx('核对原题、研究要求和预算后提交；带入代码仅供参考，仍需检查与独立验收。', 'Review the problem, instructions and limits before submitting. Carried code is reference material and still needs checking and independent acceptance.')}</dd>
      <dt>{tx('证明时间', 'Proof time limit')}</dt><dd>{readableDuration(context.originalSeconds * 1000)} → {readableDuration(settings.seconds * 1000)}</dd>
      <dt>{tx('轮次上限', 'Turn limit')}</dt><dd>{context.originalTurns} → {settings.turns}</dd>
      <dt>{tx('Token 上限', 'Token limit')}</dt><dd>{context.originalTokens ? formatTokens(context.originalTokens) : tx('未设置', 'Unset')} → {settings.tokens ? formatTokens(settings.tokens) : tx('未设置', 'Unset')}</dd></dl>
    <a href={`?run=${encodeURIComponent(context.runId)}`}>{tx('查看来源研究', 'View source run')}</a>
  </section>, host);
}
