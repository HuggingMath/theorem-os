import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { locale, localeTag, localizeMessage } from '../i18n';
import type { WebSession } from '../shared';
import { paperDraftActive, type WebPaperOverview, type WebPaperDraftJob } from '../paperTypes';
import type { PaperDraft } from '../../../src/math/paperDraft';
import { Icon, Spinner } from './ui/Icon';
import { rememberedKey, ownedTabKeyStorage } from './keyMemory';

const tx = (zh: string, en: string) => locale === 'en' ? en : zh;
const params = new URLSearchParams(location.search);
const run = params.get('run');
const chat = params.get('chat');
const backQuery = new URLSearchParams(chat ? { chat } : run ? { run } : {});
if (params.has('lang')) backQuery.set('lang', locale);
const back = backQuery.size ? `./?${backQuery}` : './';
const base = `/api/runs/${encodeURIComponent(run ?? '')}/paper`;
const phaseText = {
  writing: tx('正在撰写正文', 'Writing the draft'),
  reviewing: tx('正在独立审阅', 'Reviewing the draft'),
  revising: tx('正在按意见修订', 'Revising the draft'),
};
const active = (job?: WebPaperDraftJob) => paperDraftActive(job?.status);
const readError = tx('无法读取论文初稿。', 'Could not load the paper draft.');

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000), ...init });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ? localizeMessage(body.error) : readError);
  }
  return response.json() as Promise<T>;
}

function errorMessage(error?: string) {
  switch (error) {
    case 'invalid_structure': return tx('修订后的 LaTeX 未通过结构检查。', 'The revised LaTeX did not pass the structure check.');
    case 'interrupted': return tx('生成已中断，可以重新生成。', 'Generation was interrupted. You can try again.');
    case 'generation_failed': return tx('模型未能生成或审阅完整的正文。', 'The model could not finish drafting or reviewing the paper.');
    default: return error ? localizeMessage(error) : '';
  }
}

function Source({ draft }: { draft: PaperDraft }) {
  const [file, setFile] = useState<'main.tex' | 'template.tex'>('main.tex');
  const [jump, setJump] = useState<{ line: number }>();
  const [message, setMessage] = useState('');
  const code = useRef<HTMLPreElement>(null);
  const content = file === 'main.tex' ? draft.main : draft.template;
  const pending = draft.review === 'pending';

  useEffect(() => {
    if (!jump) return;
    const row = code.current?.querySelector<HTMLElement>(`[data-line="${jump.line}"]`);
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [jump]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(content);
      setMessage(tx('已复制源码。', 'Source copied.'));
    } catch {
      setMessage(tx('无法复制源码，请下载源稿。', 'Could not copy the source. Download the files to keep a copy.'));
    }
  }

  return <div class="paper-grid">
    <section class="paper-sheet" aria-label={tx('LaTeX 源码', 'LaTeX source')}>
      <div class="paper-filebar">
        <div class="paper-files" role="group" aria-label={tx('选择源文件', 'Choose a source file')}>
          {(['main.tex', 'template.tex'] as const).map(name => <button key={name} type="button" aria-pressed={file === name}
            onClick={() => { setFile(name); setJump(undefined); setMessage(''); }}>
            <Icon name="file-code-2" />{name}
          </button>)}
        </div>
        <button class="paper-copy" type="button" onClick={() => void copy()}><Icon name="copy" />{tx('复制', 'Copy')}</button>
      </div>
      <span class="sr-only" role="status">{message}</span>
      <pre class="paper-code" aria-label={file} ref={code} lang={file === 'main.tex' ? 'en' : undefined}><code>
        {content.trimEnd().split('\n').map((line, index) => <span key={index} data-line={index + 1}
          class={`paper-code-line${file === 'main.tex' && jump?.line === index + 1 ? ' paper-marked' : ''}`} tabIndex={-1}>
          <span class="paper-line-number" aria-hidden="true">{index + 1}</span>
          <span class="paper-line-text">{line.startsWith('%') ? <span class="paper-comment">{line}</span>
            : line.split(/(\\(?:[a-zA-Z]+|\S)|\$)/u).map((part, offset) => part.startsWith('\\') || part === '$'
              ? <span class="paper-command" key={offset}>{part}</span> : part)}</span>{'\n'}
        </span>)}
      </code></pre>
    </section>
    <aside class="paper-panel" aria-labelledby="paper-review-title">
      <header class="paper-panel-head">
        <h2 id="paper-review-title">{tx('独立审阅', 'Independent review')}</h2>
        <span class={`paper-badge ${pending ? 'paper-pending' : 'paper-accepted'}`}>
          <Icon name={pending ? 'circle-alert' : 'check'} />{pending ? tx('待审', 'Review needed') : tx('模型审阅完成', 'Model review complete')}
        </span>
      </header>
      {draft.findings.map(({ message: finding, line }, index) => <div class="paper-finding" key={index}>
        <p>{finding}</p>
        {line && <button class="paper-inline" type="button" onClick={() => {
          setFile('main.tex'); setJump({ line }); setMessage('');
        }}><Icon name="locate-fixed" />{tx(`定位到第 ${line} 行`, `Jump to line ${line}`)}</button>}
      </div>)}
      {draft.findings.length === 0 && <p class="paper-no-findings">{pending
        ? tx('这份正文还在等待审阅结论。', 'This draft is awaiting a review decision.')
        : tx('没有待处理的审阅意见。', 'There are no outstanding review findings.')}</p>}
    </aside>
  </div>;
}

function Paper({ session }: { session: WebSession }) {
  const [selection, setSelection] = useState({ target: params.get('target') ?? '' });
  const [overview, setOverview] = useState<WebPaperOverview>();
  const [reading, setReading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [modelProviderId, setModelProviderId] = useState('');
  const [model, setModel] = useState('');
  const [failure, setFailure] = useState('');
  const [pdfExporting, setPdfExporting] = useState(false);
  const [reload, setReload] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const modelSettings = useRef<HTMLDetailsElement>(null);
  const modelProvider = overview?.providers.find(provider => provider.id === modelProviderId);
  const modelUrl = session.providers.find(provider => provider.id === modelProviderId)?.baseUrl;
  const tabKey = modelProvider?.key === 'required' && modelUrl ? rememberedKey(ownedTabKeyStorage(session), modelProvider.id, modelUrl) : undefined;
  const target = selection.target || overview?.target || '';
  const query = new URLSearchParams({ ...(selection.target ? { target: selection.target } : {}), language: 'en' });
  const job = !reading && overview?.language === 'en' && overview.target === target ? overview.job : undefined;
  const busy = active(job);
  const draft = job?.draft;
  const downloadable = Boolean(draft && !busy);

  useEffect(() => {
    let stopped = false;
    let polling = false;
    let timer: number;
    const refresh = async () => {
      try {
        const result = await request<WebPaperOverview>(`${base}?${query}`);
        if (stopped) return;
        setOverview(result); setFailure(''); setReading(false);
        polling = active(result.job);
        if (polling) timer = window.setTimeout(() => void refresh(), 2000);
      } catch (error) {
        if (stopped) return;
        setFailure(error instanceof Error ? error.message : readError); setReading(false);
        if (polling) timer = window.setTimeout(() => void refresh(), 3000);
      }
    };
    if (run) void refresh();
    return () => { stopped = true; window.clearTimeout(timer); };
  // Start a new polling loop only when the selected draft changes or after a submission.
  }, [selection, reload]);

  function select(next: typeof selection) {
    const url = new URL(location.href);
    if (next.target) url.searchParams.set('target', next.target);
    history.replaceState(history.state, '', url);
    setReading(true); setFailure(''); setSelection(next);
  }

  function openSettings() {
    const provider = overview?.providers.find(item => item.id === overview.defaultProviderId);
    if (!provider) return;
    dialog.current?.querySelector('form')?.reset();
    if (modelSettings.current) modelSettings.current.open = !provider.defaultModel;
    setModelProviderId(provider.id); setModel(provider.defaultModel); setFailure('');
    dialog.current?.showModal();
  }

  async function generate(apiKey: string) {
    if (submitting || !overview || !target || !modelProvider || !model.trim()) return;
    setFailure(''); setSubmitting(true);
    try {
      const started = await request<{ job: WebPaperDraftJob }>(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ target, language: 'en', providerId: modelProvider.id, model: model.trim(), apiKey: apiKey || tabKey || '' }),
      });
      setOverview({ ...overview, job: started.job });
      dialog.current?.close();
      setReload(value => value + 1);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : readError);
    } finally { setSubmitting(false); }
  }

  async function exportPdf() {
    if (pdfExporting || !downloadable) return;
    setFailure(''); setPdfExporting(true);
    try {
      const response = await fetch(`${base}/pdf?${query}`, { cache: 'no-store', signal: AbortSignal.timeout(135_000) });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ? localizeMessage(body.error) : tx('PDF 导出失败，请稍后重试。', 'PDF export failed. Try again shortly.'));
      }
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = `paper-${run?.slice(0, 8) ?? 'draft'}-en.pdf`;
      document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : tx('PDF 导出失败，请稍后重试。', 'PDF export failed. Try again shortly.'));
    } finally { setPdfExporting(false); }
  }

  return <>
    {overview && <div class="paper-heading">
      <div><h1>{overview.title}</h1><p class="paper-statement paper-target-name"><code>{target}</code></p></div>
      <div class="paper-actions">
        {downloadable && <button class="paper-button paper-primary" type="button" disabled={pdfExporting} onClick={() => void exportPdf()}>
          <Icon name="download" />{pdfExporting ? tx('正在导出 PDF…', 'Exporting PDF…') : tx('导出 PDF', 'Export PDF')}
        </button>}
        {downloadable && <a class="paper-button paper-primary" href={`${base}/download?${query}`} download>
          <Icon name="download" />{draft?.review === 'pending' ? tx('下载待审源稿', 'Download draft for review') : tx('下载 LaTeX 源稿', 'Download LaTeX source')}
        </a>}
      </div>
    </div>}
    {overview && <div class="paper-controls">
      {overview.targets.length > 1 && <label>{tx('目标定理', 'Target theorem')}
        <select value={target} disabled={submitting} onChange={event => select({ ...selection, target: event.currentTarget.value })}>
          {overview.targets.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>}
      <button class="paper-button" type="button" disabled={reading || busy || !overview.providers.length} onClick={openSettings}>
        <Icon name={draft ? 'rotate-ccw' : 'file-pen'} />{draft ? tx('重新生成', 'Regenerate') : tx('生成初稿', 'Generate draft')}
      </button>
    </div>}
    {failure && !dialog.current?.open && <p class="paper-error" role="alert">{failure} <button class="paper-inline" type="button" onClick={() => setReload(value => value + 1)}>{tx('重新读取', 'Reload')}</button></p>}
    {job?.error && <p class="paper-error" role="alert">{errorMessage(job.error)}</p>}
    {busy && job && <p class="paper-progress" role="status"><Spinner />{phaseText[job.status as keyof typeof phaseText]}
      <span>{tx('可以离开页面，稍后回来查看。', 'You can leave this page and return later.')}</span></p>}
    {draft ? <Source key={job.id} draft={draft} /> : !busy && !failure && <section class="paper-panel paper-empty">
      <div class="paper-empty-icon"><Icon name="file-pen" /></div>
      <div><h2>{reading ? tx('正在读取验收证明…', 'Loading the accepted proof…') : tx('尚无论文初稿', 'No paper draft yet')}</h2>
        {!reading && <p>{!overview?.providers.length ? tx('请先为工作台配置支持 Responses API 的模型服务商。', 'Configure a Responses API provider for the workbench to generate a draft.')
          : tx('点击「生成初稿」，模型会根据已验收的 Lean 证明撰写英文正文。', 'Select Generate draft to write the English paper from the accepted Lean proof.')}</p>}
      </div>
    </section>}
    <dialog class="paper-dialog" ref={dialog} aria-labelledby="paper-settings-title" onClose={() => setFailure('')}>
      <form onSubmit={event => {
        event.preventDefault();
        void generate(String(new FormData(event.currentTarget).get('apiKey') ?? ''));
      }}>
        <header><h2 id="paper-settings-title">{tx('开始生成初稿', 'Start generating the draft')}</h2></header>
        <dl><dt>{tx('目标定理', 'Target theorem')}</dt><dd class="paper-target-name"><code>{target}</code></dd>
          <dt>{tx('模型', 'Model')}</dt><dd class="paper-target-name">{modelProvider?.name}{model && <> · <code>{model}</code></>}</dd>
        </dl>
        <details class="paper-model-settings" ref={modelSettings}>
          <summary>{tx('更改模型', 'Change model')}</summary>
        <label><span id="paper-model-provider-label">{tx('模型服务商', 'Model provider')}</span>
          <select aria-labelledby="paper-model-provider-label" value={modelProviderId} disabled={submitting} onChange={event => {
            const provider = overview?.providers.find(item => item.id === event.currentTarget.value);
            if (provider) { setModelProviderId(provider.id); setModel(provider.defaultModel); setFailure(''); }
          }}>
            {overview?.providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
          </select>
        </label>
        <label>{tx('模型', 'Model')}
          <input value={model} disabled={submitting} maxLength={128} required onInput={event => setModel(event.currentTarget.value)} />
        </label>
        </details>
        {modelProvider?.key === 'required' && !tabKey && <label key={modelProvider.id}>API Key<input name="apiKey" type="password" autoComplete="off" minLength={8} maxLength={4096} required /></label>}
        {tabKey && <p>{tx('将使用此标签页已记住的 API Key。', 'Uses the API key remembered in this tab.')}</p>}
        {modelProvider?.key === 'saved' && <p>{tx('将使用已保存的 API Key。', 'Uses the saved API key.')}</p>}
        {modelProvider?.key === 'server' && <p>{tx('将使用工作台配置的 API Key。', 'Uses the API key configured for the workbench.')}</p>}
        {failure && <p class="paper-error" role="alert">{failure}</p>}
        <footer><button type="button" class="paper-button" disabled={submitting} onClick={() => dialog.current?.close()}>{tx('取消', 'Cancel')}</button>
          <button type="submit" class="paper-button paper-primary" disabled={submitting || !modelProvider || !model.trim()}>{tx('开始生成', 'Start generation')}</button></footer>
      </form>
    </dialog>
  </>;
}

function App() {
  const [session, setSession] = useState<WebSession>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (run) void request<WebSession>('/api/session').then(setSession, () => setFailed(true));
  }, []);
  return <>
    <header class="paper-topbar"><div class="paper-wrap paper-topbar-inner">
      <a class="brand" href="./"><img src="assets/mark.svg" alt="" width="26" height="26" /><span>Theorem<span class="brand-os">OS</span></span></a>
      <span class="paper-topbar-title">{tx('论文初稿', 'Paper draft')}</span>
    </div></header>
    <main class="paper-wrap paper-main" id="paper-main" tabIndex={-1}>
      <a class="paper-back paper-inline" href={back}><Icon name="arrow-left" />{chat ? tx('返回对话', 'Back to conversation') : tx('返回工作台', 'Back to workbench')}</a>
      {!run || failed ? <p role="alert">{!run ? tx('请从已验收的证明打开论文初稿。', 'Open a paper draft from an accepted proof.') : readError}</p>
        : session ? <Paper session={session} /> : <p role="status">{tx('正在读取验收证明…', 'Loading the accepted proof…')}</p>}
    </main>
  </>;
}

document.documentElement.lang = localeTag;
document.title = tx('论文初稿 · TheoremOS', 'Paper draft · TheoremOS');
document.querySelector('.skip-link')!.textContent = tx('跳到主要内容', 'Skip to main content');
render(<App />, document.getElementById('paper')!);
