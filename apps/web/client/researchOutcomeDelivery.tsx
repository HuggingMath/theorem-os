import { useState } from 'preact/hooks';
import type { ResearchProblem } from '../researchProblemTypes';
import type { WebShareLink } from '../shareTypes';
import { enc, ErrorBox, MutationState, Panel, tx, useMutation, useResource, type ResearchContext } from './researchShared';

export function ResearchOutcomeDelivery({ problem, onBrief }: { problem: ResearchProblem; context: ResearchContext; onBrief(): void }) {
  const run = problem.brief.selectedRunId, own = !problem.project || Boolean(problem.project.runs.find(binding => binding.runId === run)?.permissions.manage);
  const [sharing, setSharing] = useState(false), [reviewed, setReviewed] = useState(false), [copied, setCopied] = useState(false), [copyError, setCopyError] = useState('');
  const endpoint = `/api/runs/${enc(run)}/share`, data = useResource<{ share: WebShareLink | null }>(own && sharing ? endpoint : undefined), action = useMutation();
  if (!problem.brief.accepted) return null;
  return <Panel title={tx('证明已通过，整理这次成果', 'The proof passed. Prepare your results')}>
    <div data-outcome-delivery><p>{tx('将已保存的证明整理成讲解、分享快照或可复用成果。', 'Turn the saved proof into an explanation, a shared snapshot or a reusable result.')}</p>
      <div class="research-actions"><button class="button" type="button" onClick={onBrief}>{tx('预览与导出研究简报', 'Preview and export the research brief')}</button>
        {own && <><a class="button" href={`explain.html?run=${enc(run)}`}>{tx('阅读或生成证明讲解', 'Read or create a proof explanation')}</a>
          <button class="button" type="button" aria-expanded={sharing} onClick={() => setSharing(value => !value)}>{tx('创建只读分享', 'Create a read-only share')}</button>
          <a class="button" href={`/api/runs/${enc(run)}/download`}>{tx('下载完整研究档案', 'Download the complete research archive')}</a>
          <a class="button" href={`library.html?fromRun=${enc(run)}&scope=original-proof`}>{tx('整理为 Library 成果', 'Prepare a Library result')}</a></>}
      </div>
      {!own && <p>{tx('分享链接、完整档案和原题成果由运行所有者创建。你可以导出有权查看的研究简报。', 'The run owner creates share links, full archives and original-proof assets. You can export the research brief you are allowed to read.')}</p>}
      {own && sharing && <section class="problem-share-controls" data-outcome-share><h3>{tx('公开只读快照', 'Public read-only snapshot')}</h3>
        <p>{tx('拿到链接的人无需登录，即可查看原题、证明、验收证据及已保存的推导与审核讲解。', 'Anyone with the link can read the problem, proof, acceptance evidence, recorded reasoning and approved explanations without signing in.')}</p>
        <p>{tx('快照不包含 API Key、邮箱、服务地址、原始日志、Agent 对话或私人协作讨论。', 'The snapshot excludes API keys, emails, provider addresses, raw logs, agent conversations and private discussions.')}</p>
        <ErrorBox message={data.error || copyError} />{data.error && <button class="button" type="button" onClick={data.refresh}>{tx('重新读取', 'Try again')}</button>}
        {data.loading && <p role="status">{tx('正在读取分享状态…', 'Loading share status…')}</p>}
        {data.data?.share ? <><label>{tx('分享链接', 'Share link')}<input readOnly value={data.data.share.url} onFocus={event => event.currentTarget.select()} /></label>
          <div class="research-actions"><a class="button" href={data.data.share.url} target="_blank" rel="noopener noreferrer">{tx('打开分享页', 'Open share page')}</a>
            <button class="button" type="button" onClick={async () => { try { await navigator.clipboard.writeText(data.data!.share!.url); setCopied(true); setCopyError(''); } catch { setCopyError(tx('请选中链接后手动复制。', 'Select the link and copy it manually.')); } }}>{tx('复制链接', 'Copy link')}</button>
            <button class="button" type="button" disabled={action.busy} onClick={() => void action.run('DELETE', endpoint, {}, () => { data.refresh(); setReviewed(false); setCopied(false); })}>{tx('停止分享', 'Stop sharing')}</button></div>{copied && <p role="status">{tx('已复制', 'Copied')}</p>}
          <p>{tx('分享内容固定在创建时；停止分享后原链接立即失效。', 'Shared content is frozen when the link is created. Stopping sharing immediately invalidates the link.')}</p></>
          : data.data && <><label class="research-check"><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.currentTarget.checked)} />{tx('我已核对公开内容', 'I reviewed the public content')}</label>
            <button class="button" type="button" data-create-outcome-share disabled={!reviewed || action.busy} onClick={() => void action.run('POST', endpoint, {}, data.refresh)}>{tx('创建分享链接', 'Create share link')}</button></>}
        <MutationState action={action} />
      </section>}
    </div>
  </Panel>;
}
