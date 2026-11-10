import { useEffect, useState } from 'preact/hooks';
import { render } from 'preact';
import type { ProductStatus } from '../productStatusTypes';
import { locale } from '../i18n';
import { environmentSummary, feedbackUrl } from './feedback';
import { tx } from './researchShared';

export function ProductStatusPanel() {
  const [status, setStatus] = useState<ProductStatus>(), [loaded] = useState(() => document.querySelector<HTMLMetaElement>('meta[name="theoremos-build"]')?.content), [error, setError] = useState(''),
    [checking, setChecking] = useState(false), [copied, setCopied] = useState(false);
  const refresh = async () => {
    setChecking(true); setError('');
    try {
      const response = await fetch('/api/product/status', { cache: 'no-store' });
      if (!response.ok) throw new Error(tx('暂时无法读取服务状态，请重试。', 'Service status is unavailable. Try again.'));
      setStatus(await response.json());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setChecking(false); }
  };
  useEffect(() => { void refresh(); }, []);
  const diagnostics = JSON.stringify({ product: 'TheoremOS', environment: environmentSummary(),
    page: location.pathname.split('/').pop() || 'index.html', language: locale,
    release: status?.release, service: status?.service, checkedAt: status?.checkedAt }, null, 2);
  const changed = loaded && status?.release.frontend && loaded !== status.release.frontend.digest;
  return <section class="product-status" data-product-status aria-labelledby="product-status-heading"><h2 id="product-status-heading">{tx('版本与服务状态', 'Version and service status')}</h2>
    <p>{tx('查看当前发布版本，或在反馈前复制诊断信息。', 'Check the release or copy diagnostics before sending feedback.')}</p>
    {error && <p role="alert">{error}</p>}{checking && <p role="status">{tx('正在读取…', 'Loading…')}</p>}
    {status && <><dl class="research-facts"><div><dt>{tx('发布版本', 'Release')}</dt><dd><code>{status.release.commit?.slice(0, 12) ?? status.release.frontend?.commit?.slice(0, 12) ?? tx('未标注', 'Not recorded')}</code>{status.release.frontend?.modified && ` · ${tx('本地修改构建', 'Build includes local changes')}`}</dd></div>
      <div><dt>{tx('前端构建', 'Frontend build')}</dt><dd><code>{status.release.frontend?.digest.slice(0, 12) ?? tx('未标注', 'Not recorded')}</code></dd></div>
      {status.release.frontend && <div><dt>{tx('构建时间', 'Built at')}</dt><dd>{new Date(status.release.frontend.builtAt).toLocaleString(locale === 'en' ? 'en' : 'zh-CN')}</dd></div>}
      <div><dt>{tx('服务状态', 'Service status')}</dt><dd>{status.service.maintenance ? tx('维护中', 'Under maintenance') : !status.service.writable ? tx('暂时只读', 'Temporarily read-only') : tx('正常', 'Available')}</dd></div>
      <div><dt>{tx('证明环境', 'Proof runtime')}</dt><dd>{status.service.runtimeReady ? tx('已就绪', 'Ready') : tx('暂未就绪', 'Not ready')}</dd></div></dl>
      {changed && <p role="status">{tx('服务已经更新。请先保存编辑内容，再刷新页面载入新版本。', 'The service was updated. Save your edits, then refresh to load the new version.')}</p>}</>}
    <div class="research-actions"><button class="button" type="button" onClick={() => void refresh()} disabled={checking}>{tx('刷新状态', 'Refresh status')}</button><a class="button" href="guide.html">{tx('使用指南', 'User guide')}</a></div>
    <details><summary>{tx('最近补充的功能', 'Recent additions')}</summary><ul><li>{tx('跨尝试路线、历史证据与节点协作', 'Research journeys, historical evidence and collaboration on steps')}</li><li>{tx('账号草稿、私人整理与整题预算', 'Account drafts, personal organization and problem budgets')}</li><li>{tx('研究接续、试用历史与成果交付', 'Research continuity, trial history and outcome delivery')}</li></ul></details>
    <details data-diagnostics-preview><summary>{tx('查看将要复制的诊断信息', 'Preview diagnostics to copy')}</summary><pre class="research-block-code">{diagnostics}</pre>
      <button class="button" type="button" onClick={async () => { try { await navigator.clipboard.writeText(diagnostics); setCopied(true); setError(''); } catch { setError(tx('复制失败，请从上方手动选择诊断文字。', 'Copy failed. Select the diagnostics above to copy them manually.')); } }}>{tx('复制诊断信息', 'Copy diagnostics')}</button>{copied && <span role="status">{tx('已复制', 'Copied')}</span>}</details>
    <a class="text-button" href={feedbackUrl()} target="_blank" rel="noopener noreferrer">{tx('反馈问题', 'Report a problem')} ↗</a>
  </section>;
}
export function mountProductStatus(host: HTMLElement) { render(<ProductStatusPanel />, host); }
