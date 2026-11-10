import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { WebTaskSource } from '../collaboration';
import type { WebApi } from './collaborationUi';
import { locale } from '../i18n';

type Target = { taskId: string; version: string; commit: string };
const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
function FrozenTask({ request, runId, target, close }: { request: WebApi; runId: string; target: Target; close(): void }) {
  const [source, setSource] = useState<WebTaskSource>(), [error, setError] = useState(''), [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setError('');
    void request<{ source: WebTaskSource }>(`/api/runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(target.taskId)}/source?${new URLSearchParams({ version: target.version, commit: target.commit })}`,
      { signal: controller.signal }).then(value => {
      if (!controller.signal.aborted) {
        if (value.source.taskVersion !== target.version || value.source.commit !== target.commit) throw new Error(tx('保存的源码身份与链接不一致。', 'The source identity does not match this link.'));
        setSource(value.source);
      }
    }).catch(cause => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => controller.abort();
  }, [runId, target.taskId, target.version, target.commit, revision]);
  return <div class="frozen-task-view" data-frozen-task><header><div><p>{tx('保存的任务版本', 'Saved task version')}</p><h2>{target.taskId}</h2></div>
    <button type="button" class="button" onClick={close}>{tx('关闭', 'Close')}</button></header>
    <dl><dt>{tx('任务版本', 'Task version')}</dt><dd><code>{target.version}</code></dd><dt>Commit</dt><dd><code>{target.commit}</code></dd>
      {source && <><dt>{tx('源码摘要', 'Source digest')}</dt><dd><code>{source.sourceDigest}</code></dd><dt>{tx('环境摘要', 'Environment digest')}</dt><dd><code>{source.environmentDigest}</code></dd></>}</dl>
    {error ? <><p class="chat-error" role="alert">{error}</p><button class="button" type="button" onClick={() => setRevision(value => value + 1)}>{tx('重新读取', 'Try again')}</button></>
      : source ? <><p>{source.file}</p><pre tabIndex={0} aria-label={tx('保存的 Lean 源码', 'Saved Lean source')}><code>{source.source}</code></pre>
        <a class="button" href={`workspace.html?${new URLSearchParams({ tab: 'collections', saveRun: runId, task: source.taskId, taskVersion: source.taskVersion, commit: source.commit })}`}>{tx('收藏这个版本', 'Save this version')}</a></>
        : <p role="status">{tx('正在读取保存的源码…', 'Loading the saved source…')}</p>}
  </div>;
}
export function openFrozenTask(request: WebApi, runId: string, target: Target) {
  const dialog = document.createElement('dialog'); dialog.className = 'frozen-task-dialog'; dialog.setAttribute('aria-label', tx('保存的任务版本', 'Saved task version'));
  const close = () => { dialog.close(); };
  dialog.addEventListener('close', () => { render(null, dialog); dialog.remove(); }, { once: true });
  document.body.append(dialog); render(<FrozenTask request={request} runId={runId} target={target} close={close} />, dialog); dialog.showModal();
}
