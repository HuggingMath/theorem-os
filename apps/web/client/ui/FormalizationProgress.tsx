import type { WebFormalization } from '../../formalizationTypes';
import { t } from '../../i18n';
import type { ProcessTone, SolveProcess } from '../solveProcess';
import { downloadLean } from '../downloadLean';
import { ToneMark } from './SolveProcess';
import { Icon } from './Icon';

/** This is statement preparation, separate from both background review and proof acceptance. */
export function formalizationProgress(item: WebFormalization, process?: SolveProcess) {
  const active = item.status === 'queued' || item.status === 'running';
  const phase = item.progress?.phase ?? 'queued';
  const checks = process?.checks.filter(check => check.stage === 'formalize') ?? [];
  const latest = checks.at(-1);
  const ready = Boolean(item.report);
  const restoring = !ready && (item.status === 'review' || item.status === 'confirmed');
  const revising = active && latest?.state === 'failed' && ['planning', 'generating', 'compiling'].includes(phase);
  const saving = !ready && (phase === 'finishing' || phase === 'translating' || phase === 'reviewing'
    || phase === 'compiling' && latest?.state === 'passed');
  const current = ready ? 4 : saving || restoring ? 3 : revising ? 1
    : phase === 'compiling' || latest?.state === 'running' ? 2
      : phase === 'planning' || phase === 'generating' ? 1 : 0;
  const labels = [t('准备环境'), t('编写陈述'), t('编译检查'), t('代码就绪')];
  const steps = (['prepare', 'write', 'compile', 'ready'] as const).map((id, index) => ({
    id, label: labels[index]!, tone: (index < current ? 'done' : index > current ? 'pending'
      : active ? 'active' : item.status === 'cancelled' ? 'stopped'
        : item.status === 'error' || item.status === 'exhausted' ? 'failed' : 'pending') as ProcessTone,
  }));
  const description = ready ? t('Lean 陈述已可查看和下载，可以继续证明。')
    : restoring ? t('正在读取已保存的 Lean 陈述。')
      : revising ? t('Lean 检查未通过，正在根据报错修改陈述。')
      : phase === 'queued' ? t('任务已排队，开始后会在这里更新进度。')
        : phase === 'preparing' ? t('正在准备 Lean 与数学库，随后开始编写陈述。')
          : phase === 'translating' ? t('Lean 编译通过，正在核对陈述对应的自然语言。')
            : phase === 'reviewing' ? t('Lean 编译通过，正在核对陈述与原题的一致性。')
              : saving ? t('Lean 编译通过，正在保存代码与检查记录。')
                : current === 2 ? t('陈述已生成，正在用 Lean 检查类型、定义和语法。')
                  : t('正在把原题中的对象、条件和结论写成 Lean 陈述。');
  // An interrupted check has no compiler result and is not counted as a Lean rejection.
  const failures = checks.filter(check => check.state === 'failed' && (check.lean || check.text)).length;
  return { active, ready, revising, steps, description, checks: checks.length, failures };
}

export function FormalizationProgress({ item, process, wide, onCode }: {
  item: WebFormalization; process?: SolveProcess; wide?: boolean; onCode(): void;
}) {
  const progress = formalizationProgress(item, process);
  const current = !progress.ready && process?.current?.kind === 'statement' ? process.current : undefined;
  return <div class="formalization-progress" data-formalization-progress>
    <ol aria-label={t('形式化进度')}>
      {progress.steps.map(step => <li key={step.id} data-formalization-step={step.id} data-tone={step.tone}
        aria-current={step.tone === 'active' ? 'step' : undefined}>
        <ToneMark tone={step.tone} /><span>{step.label}</span>
      </li>)}
    </ol>
    {(progress.checks > 0 || current || item.report) && <div class="formalization-progress-meta">
      {progress.checks > 0 && <span>{t('Lean 检查 {0} 次', progress.checks)}
        {progress.failures > 0 && <>{' · '}{t('{0} 次未通过', progress.failures)}</>}</span>}
      {current && wide && <button type="button" class="text-button" data-formalization-code onClick={onCode}>
        <Icon name="file-code-2" />{t('查看当前代码')}</button>}
      {item.report && <button type="button" class="text-button" data-download-statement onClick={() => downloadLean(item.report!.statement)}>
        <Icon name="download" />{t('下载 Lean 陈述')}</button>}
    </div>}
    {current && !wide && <details class="formalization-current-code">
      <summary data-formalization-code>{t('查看当前代码')}</summary>
      <pre tabIndex={0} aria-label={t('Lean 源码')} translate={false}><code>{current.source}</code></pre>
      {current.clipped && <p>{t('内容较长，后面的部分没有显示。')}</p>}
    </details>}
  </div>;
}
