import {
  createIcons, ArrowDownWideNarrow, ArrowUpRight, BadgeCheck,
  CalendarDays, Check, ChevronRight, CircleCheck, Clock, Code, Copy, Download, FileCheck2, FileClock, FileCode2,
  Files, FlaskConical, GitBranch, GitCommitHorizontal, GitFork, Hash, Info, Link2,
  ListStart, MessageCircle, Search, SearchX, ShieldCheck,
} from 'lucide';
import catalog from 'virtual:archive';
import type { ArchiveIndexRecord, ArchiveIndexSource, ArchiveProcess } from './types';
import { keepHashOnLanguageSwitch, localeOf, localizeRecord, rootOf } from './site';

const iconSet = {
  ArrowDownWideNarrow, ArrowUpRight, BadgeCheck, CalendarDays, Check,
  ChevronRight, CircleCheck, Clock, Code, Copy, Download, FileCheck2, FileClock, FileCode2, Files, FlaskConical,
  GitBranch, GitCommitHorizontal, GitFork, Hash, Info, Link2, ListStart, MessageCircle, Search,
  SearchX, ShieldCheck,
};
const locale = localeOf(document.documentElement.lang);
const strings = {
  zh: {
    accepted: '官方已验收', verified: '本地验收通过', nativeAt: '本地验收', snapshot: '研究快照', notAccepted: '尚未官方验收',
    process: '解题过程', processNote: '按时间查看研究尝试、引理任务和检查记录。',
    reuse: '资料与复用记录', sourceUses: '资料引用', lemmaRequests: '引理请求', knowledgeApplications: '知识库应用', libraryUsage: '模块引用阶段',
    reuseNote: '资料引用、引理请求和局部应用检查分别记录；整题结果以验收记录为准。',
    unknownEvidence: '未知：没有保存记录', noEntries: '无条目', consumer: '目标任务', assumptions: '假设', adaptation: '适配', remaining: '待完成',
    installedModules: '已安装', draftModules: '草稿引用（未验证）', canonicalModules: '集成提交引用', checkedModules: '通过检查的提交引用',
    lexicalMentions: '源码名称提及', moduleNote: '模块引用和名称提及仅反映保存的源码。',
    applicationChecks: { elaborated: '局部表达式检查通过', failed: '局部表达式检查失败', unavailable: '局部检查不可用' } as Record<string, string>,
    processCount: (runs: number, tasks: number) => `${runs} 次记录运行 · ${tasks} 项任务`,
    loadingProcess: '正在载入解题过程…', processUnavailable: '解题过程载入失败，请重新打开此视图重试。',
    objectives: '原题目标', attempts: '尝试次数', dependencies: '依赖任务', rawSource: '证明原文件',
    nativeEvidence: '本地独立验收', nativeScope: '原题通过 Lean 内核检查和原题 comparator 验收。',
    binding: { matches: '与归档文件的源码哈希一致', differs: '检查投影与归档文件的哈希不同', unrecorded: '未记录源码哈希绑定' },
    results: (count: number, query: string) => `${count} 条记录${query ? ` · “${query}”` : ''}`,
    tasks: { completed: '完成', integrated: '集成', pending: '待处理', blocked: '受阻', running: '进行中' } as Record<string, string>,
    taskTitle: '任务状态（快照）', taskNote: '非整题验收进度',
    draft: '尚未官方验收。快照可能包含 sorry、失败方案或未检查的修改。',
    attribution: '原始归属', officialAt: '官方验收', snapshotAt: '快照记录', revision: '题目版本', sourceCommit: '原始提交',
    phase: '快照阶段', research: '研究记录', turns: (turns: number, workers: number) => `${turns} 轮 · ${workers} 个 worker`,
    leanSource: 'Lean 源码', files: (files: number, lines: string) => `${files} 个文件 · ${lines} 行`, localRecord: '本地记录',
    excerptAccepted: '目标声明 / 证明节选', excerptSnapshot: '原题声明节选', officialResult: '官方验收', archive: '原始档案',
    leanFile: 'Lean 文件', jump: '定位目标声明', copySource: '复制 Lean 源码', downloadSource: '下载 Lean 文件',
    sourceLabel: (name: string) => `${name} 源码`, githubFile: 'GitHub 原文件', copyHash: '复制文件 SHA-256',
    noOfficial: '尚无官方验收通过记录。局部任务或引理检查不代表完整题目已解出。', snapshotFiles: '查看快照与 manifest',
    leanEval: 'Lean-Eval 官方验收', viewOfficial: '查看官方结果', localEvidence: '归档本地验证记录', unrecorded: '未记录',
    differs: '此记录的源码哈希与当前归档不同。官方验收以官方结果链接为准。',
    submission: '原始提交来源', submissionLink: '原始提交', discussion: '提交讨论', production: '来源与人工参与',
    resumed: '此结果包含已保存候选的恢复或续跑。', checksums: '归档文件校验', copyChecksum: (file: string) => `复制 ${file} 校验值`,
    empty: '没有可显示的记录', details: '档案详情', copyLink: '复制题目链接', downloadRecord: '下载此题档案 JSON',
    detailTabs: '档案详情视图', tabs: { overview: '概览', source: 'Lean 源码', evidence: '验证证据', process: '解题过程' },
    copied: '已复制', copyFailed: '复制失败，请检查浏览器剪贴板权限',
    loadingSource: '正在载入 Lean 源码…', sourceUnavailable: '源码载入失败。可以通过原文件链接查看。',
    row: (title: string, accepted: boolean) => `${title}，${accepted ? '官方已验收' : '尚未官方验收'}`,
  },
  en: {
    accepted: 'Officially accepted', verified: 'Locally verified', nativeAt: 'Local acceptance', snapshot: 'Research snapshot', notAccepted: 'Not yet officially accepted',
    process: 'Research process', processNote: 'Recorded attempts, lemma tasks and checks, in chronological order.',
    reuse: 'References and reuse', sourceUses: 'Source references', lemmaRequests: 'Lemma requests', knowledgeApplications: 'Knowledge applications', libraryUsage: 'Module usage stages',
    reuseNote: 'References, lemma requests and local application checks are recorded separately. Whole-problem results follow the acceptance records.',
    unknownEvidence: 'Unknown: no saved record', noEntries: 'No entries', consumer: 'Consumer task', assumptions: 'Assumptions', adaptation: 'Adaptation', remaining: 'Remaining',
    installedModules: 'Installed', draftModules: 'Draft imports (unchecked)', canonicalModules: 'Integrated commit imports', checkedModules: 'Checked commit imports',
    lexicalMentions: 'Names mentioned in source', moduleNote: 'Imports and name mentions describe the saved source.',
    applicationChecks: { elaborated: 'Local expression elaborated', failed: 'Local expression check failed', unavailable: 'Local check unavailable' } as Record<string, string>,
    processCount: (runs: number, tasks: number) => `${runs} recorded runs · ${tasks} tasks`,
    loadingProcess: 'Loading the research process…', processUnavailable: 'The research process could not be loaded. Reopen this view to retry.',
    objectives: 'Original targets', attempts: 'Attempts', dependencies: 'Dependencies', rawSource: 'Original proof file',
    nativeEvidence: 'Independent local acceptance', nativeScope: 'The original targets passed the Lean kernel checks and the original comparator.',
    binding: { matches: 'Source hashes match the archived files', differs: 'The checked projection differs from the archived files', unrecorded: 'No source hash binding recorded' },
    results: (count: number, query: string) => `${count} ${count === 1 ? 'record' : 'records'}${query ? ` · “${query}”` : ''}`,
    tasks: { completed: 'Completed', integrated: 'Integrated', pending: 'Pending', blocked: 'Blocked', running: 'Running' } as Record<string, string>,
    taskTitle: 'Task status (snapshot)', taskNote: 'Not whole-statement progress',
    draft: 'Not yet officially accepted. The snapshot may contain sorry, failed attempts or unchecked edits.',
    attribution: 'Attribution', officialAt: 'Accepted', snapshotAt: 'Snapshot', revision: 'Revision', sourceCommit: 'Original commit',
    phase: 'Snapshot phase', research: 'Research record', turns: (turns: number, workers: number) => `${turns} turns · ${workers} ${workers === 1 ? 'worker' : 'workers'}`,
    leanSource: 'Lean source', files: (files: number, lines: string) => `${files} ${files === 1 ? 'file' : 'files'} · ${lines} lines`, localRecord: 'Local record',
    excerptAccepted: 'Target statement / proof excerpt', excerptSnapshot: 'Statement excerpt', officialResult: 'Official result', archive: 'Archive files',
    leanFile: 'Lean file', jump: 'Jump to the target statement', copySource: 'Copy Lean source', downloadSource: 'Download Lean file',
    sourceLabel: (name: string) => `${name} source`, githubFile: 'File on GitHub', copyHash: 'Copy file SHA-256',
    noOfficial: 'No official pass yet. Checks of individual tasks or lemmas do not mean the full statement is solved.', snapshotFiles: 'Snapshot and manifest',
    leanEval: 'Lean-Eval official result', viewOfficial: 'View official result', localEvidence: 'Archived local verification', unrecorded: 'not recorded',
    differs: 'The source hashes of this record differ from the current archive. The official result link is authoritative.',
    submission: 'Original submission', submissionLink: 'Original commit', discussion: 'Submission discussion', production: 'Provenance and human involvement',
    resumed: 'This result includes resuming or continuing from saved candidates.', checksums: 'Archived file checksums', copyChecksum: (file: string) => `Copy the ${file} checksum`,
    empty: 'No records to show', details: 'Record details', copyLink: 'Copy link to this proof', downloadRecord: 'Download this record as JSON',
    detailTabs: 'Record detail views', tabs: { overview: 'Overview', source: 'Lean source', evidence: 'Evidence', process: 'Research process' },
    copied: 'Copied', copyFailed: 'Copy failed. Check the clipboard permission of your browser.',
    loadingSource: 'Loading the Lean source…', sourceUnavailable: 'The source could not be loaded. You can use the original file link.',
    row: (title: string, accepted: boolean) => `${title}, ${accepted ? 'officially accepted' : 'not yet officially accepted'}`,
  },
}[locale];
const records = catalog.records.map(record => localizeRecord(record, locale));
type ArchiveRecord = ArchiveIndexRecord;
type ArchiveSource = ArchiveIndexSource & { code: string };

declare global { interface Window { theoremosSources?: Record<string, Record<string, string>>; theoremosProcesses?: Record<string, ArchiveProcess> } }
// Lean sources are most of the archive's weight, so each record's files load on first use.
const sourceRequests = new Map<string, Promise<Record<string, string>>>();
const loadedSources = (id: string) => window.theoremosSources?.[id];
function loadSources(id: string) {
  let request = sourceRequests.get(id);
  if (!request) sourceRequests.set(id, request = new Promise<Record<string, string>>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${rootOf(locale)}data/sources/${id}.js`;
    script.onload = () => { script.remove(); const files = loadedSources(id); if (files) resolve(files); else reject(new Error(`Missing sources: ${id}`)); };
    script.onerror = () => { script.remove(); sourceRequests.delete(id); reject(new Error(`Missing sources: ${id}`)); };
    document.head.append(script);
  }));
  return request;
}
const withCode = (record: ArchiveRecord, source: ArchiveIndexSource): ArchiveSource => ({ ...source, code: loadedSources(record.id)?.[source.name] ?? '' });
const processRequests = new Map<string, Promise<ArchiveProcess>>();
function loadProcess(record: ArchiveRecord): Promise<ArchiveProcess | undefined> {
  if (!record.processSummary) return Promise.resolve(undefined);
  let request = processRequests.get(record.id);
  if (!request) processRequests.set(record.id, request = new Promise<ArchiveProcess>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${rootOf(locale)}data/process/${record.id}.js`;
    script.onload = () => { script.remove(); const value = window.theoremosProcesses?.[record.id];
      if (value) resolve(value); else { processRequests.delete(record.id); reject(new Error('Missing process')); } };
    script.onerror = () => { script.remove(); processRequests.delete(record.id); reject(new Error('Missing process')); };
    document.head.append(script);
  }));
  return request;
}
const icons = () => createIcons({ icons: iconSet, attrs: { 'aria-hidden': 'true' } });
const icon = (name: string) => `<i data-lucide="${name}"></i>`;
const html = (value: string | number) => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]!));
const element = <T extends HTMLElement = HTMLElement>(selector: string) => {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error(`Missing page element: ${selector}`);
  return result;
};
const date = (value: string) => new Date(value).toISOString().slice(0, 10);
const timestamp = (value: string) => `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const external = (url: string, label: string, className = 'inline-link') =>
  `<a class="${className}" href="${html(url.startsWith('data/') ? rootOf(locale) + url : url)}" target="_blank" rel="noreferrer">${html(label)}${icon('arrow-up-right')}</a>`;
const accepted = (record: ArchiveRecord) => record.status === 'official_accepted';
const verified = (record: ArchiveRecord) => accepted(record) || record.status === 'locally_verified';
const statusLabel = (record: ArchiveRecord) => accepted(record) ? strings.accepted : verified(record) ? strings.verified : strings.snapshot;
const statusBadge = (record: ArchiveRecord) => `<span class="status-badge ${verified(record) ? 'accepted' : 'progress'}">${icon(verified(record) ? 'circle-check' : 'flask-conical')}${statusLabel(record)}</span>`;
const sourceBindingLabels = strings.binding;
const iconButton = (action: string, label: string, name: string, value?: string) =>
  `<button type="button" class="icon-button" data-action="${action}" ${value ? `data-value="${html(value)}"` : ''} aria-label="${label}" title="${label}">${icon(name)}</button>`;

type Filter = 'all' | 'accepted' | 'verified' | 'progress';
type Sort = 'verified' | 'recent' | 'title';
type Tab = 'overview' | 'source' | 'evidence' | 'process';
const state = {
  view: 'archive', filter: 'all' as Filter, query: '', sort: 'verified' as Sort,
  selected: records.find(accepted)?.id ?? records[0]?.id ?? '',
  tab: 'overview' as Tab, sourceName: '',
};
const selectedRecord = () => records.find(record => record.id === state.selected);

function readLocation() {
  const params = new URLSearchParams(location.hash.slice(1));
  state.view = params.get('view') === 'quickstart' ? 'quickstart' : 'archive';
  state.filter = ['accepted', 'verified', 'progress'].includes(params.get('status') ?? '') ? params.get('status') as Filter : 'all';
  state.query = params.get('q') ?? '';
  state.sort = ['title', 'recent'].includes(params.get('sort') ?? '') ? params.get('sort') as Sort : 'verified';
  state.tab = ['source', 'evidence', 'process'].includes(params.get('tab') ?? '') ? params.get('tab') as Tab : 'overview';
  const id = params.get('proof');
  state.selected = records.find(record => record.id === id)?.id ?? records.find(accepted)?.id ?? '';
  state.sourceName = '';
}

function writeLocation(push = false) {
  const params = new URLSearchParams();
  if (state.view === 'quickstart') params.set('view', 'quickstart');
  else {
    if (state.selected) params.set('proof', state.selected);
    if (state.tab !== 'overview') params.set('tab', state.tab);
    if (state.filter !== 'all') params.set('status', state.filter);
    if (state.query) params.set('q', state.query);
    if (state.sort !== 'verified') params.set('sort', state.sort);
  }
  const url = `#${params.toString() || 'view=archive'}`;
  if (push) history.pushState(null, '', url);
  else history.replaceState(null, '', url);
}

function filteredRecords() {
  const query = state.query.trim().toLocaleLowerCase().replaceAll('_', ' ');
  return records.filter(record => {
    const matchesStatus = state.filter === 'all' || (state.filter === 'accepted' ? accepted(record) : state.filter === 'verified' ? record.status === 'locally_verified' : !verified(record));
    const text = `${record.title} ${record.subtitle} ${record.area} ${record.id} ${record.model}`.toLocaleLowerCase().replaceAll('_', ' ');
    return matchesStatus && (!query || text.includes(query));
  }).sort((a, b) => {
    if (state.sort === 'title') return a.title.localeCompare(b.title, 'en');
    if (state.sort === 'verified' && verified(a) !== verified(b)) return verified(a) ? -1 : 1;
    if (state.sort === 'verified' && accepted(a) !== accepted(b)) return accepted(a) ? -1 : 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}

function renderList(shown: ArchiveRecord[]) {
  element('#proof-list').innerHTML = shown.map(record => `
    <li><button type="button" class="proof-row ${state.selected === record.id ? 'is-selected' : ''}"
      data-proof-id="${record.id}" aria-pressed="${state.selected === record.id}"
      aria-label="${html(record.title + (locale === 'en' ? ', ' : '，') + statusLabel(record))}">
      <span class="row-symbol ${verified(record) ? '' : 'progress'}">${icon(verified(record) ? 'file-check-2' : 'file-clock')}</span>
      <span><span class="row-title">${html(record.title)}</span><span class="row-subtitle">${html(record.subtitle)}<span class="area-label">${html(record.area)}</span></span></span>
      <span class="row-end">${statusBadge(record)}<span class="row-date">${date(record.updatedAt)}</span></span>
    </button></li>`).join('');
  element('#empty-state').hidden = shown.length > 0;
  element('#result-count').textContent = strings.results(shown.length, state.query);
}

const taskColors: Record<string, { label: string; color: string }> = {
  completed: { label: strings.tasks.completed, color: '#72a38d' }, integrated: { label: strings.tasks.integrated, color: '#438564' },
  pending: { label: strings.tasks.pending, color: '#d6dfda' }, blocked: { label: strings.tasks.blocked, color: '#c6a36a' },
  running: { label: strings.tasks.running, color: '#8898bd' },
};
function taskChart(record: ArchiveRecord) {
  if (!record.snapshot) return '';
  const tasks = Object.entries(record.snapshot.taskStatuses).filter(([, count]) => count > 0);
  return `<div class="detail-section"><div class="section-title"><h3>${strings.taskTitle}</h3><span>${strings.taskNote}</span></div>
    <div class="task-chart" role="img" aria-label="${html(tasks.map(([key, count]) => `${taskColors[key]?.label ?? key} ${count}`).join(locale === 'en' ? ', ' : '，'))}">
      ${tasks.map(([key, count]) => `<span style="flex:${count};background:${taskColors[key]?.color ?? '#d6dfda'}"></span>`).join('')}
    </div><div class="task-legend">${tasks.map(([key, count]) => `<span><i style="background:${taskColors[key]?.color ?? '#d6dfda'}"></i>${html(taskColors[key]?.label ?? key)} ${count}</span>`).join('')}</div></div>`;
}

function overview(record: ArchiveRecord) {
  const local = record.local;
  return `<p class="detail-summary">${html(record.summary)}</p>
    ${!verified(record) ? `<div class="draft-note">${icon('info')}<span>${strings.draft}</span></div>` : ''}
    <dl class="record-facts">
      <div><dt>${strings.attribution}</dt><dd>${html(record.model)}</dd></div>
      <div><dt>${accepted(record) ? strings.officialAt : record.campaign ? strings.nativeAt : strings.snapshotAt}</dt><dd class="mono">${timestamp(record.updatedAt)}</dd></div>
      ${record.campaign ? `<div><dt>${strings.objectives}</dt><dd class="mono">${record.campaign.targets.map(html).join('<br>')}</dd></div>` : ''}
      ${record.processSummary ? `<div><dt>${strings.process}</dt><dd><button class="process-open" data-tab="process">${strings.processCount(record.processSummary.runs, record.processSummary.tasks)}</button></dd></div>` : ''}
      ${record.official ? `<div><dt>${strings.revision}</dt><dd>Statement revision ${record.official.statementRevision}</dd></div>
        <div><dt>${strings.sourceCommit}</dt><dd>${external(record.official.sourceUrl, record.official.sourceCommit.slice(0, 12), 'inline-link mono')}</dd></div>` : ''}
      ${record.snapshot ? `<div><dt>${strings.phase}</dt><dd class="mono">${html(record.snapshot.phase)}</dd></div>
        <div><dt>${strings.research}</dt><dd>${strings.turns(record.snapshot.turns, record.snapshot.workers)}</dd></div>` : ''}
      <div><dt>${strings.leanSource}</dt><dd>${strings.files(record.sources.length, record.sources.reduce((sum, source) => sum + source.lines, 0).toLocaleString('en'))}</dd></div>
      ${local ? `<div><dt>${strings.localRecord}</dt><dd>${html(local.status)}<span class="subfact">${sourceBindingLabels[local.sourceBinding]}</span></dd></div>` : ''}
    </dl>
    ${taskChart(record)}
    <div class="detail-section"><div class="section-title"><h3>${verified(record) ? strings.excerptAccepted : strings.excerptSnapshot}</h3><span>Lean</span></div><pre class="declaration-preview">${html(record.excerpt)}</pre></div>
    <div class="detail-links">${record.official ? external(record.official.resultUrl, strings.officialResult, 'button') : ''}${external(record.archiveUrl, strings.archive, 'button')}</div>`;
}

function currentSource(record: ArchiveRecord): ArchiveSource {
  return withCode(record, record.sources.find(source => source.name === state.sourceName) ??
    record.sources.find(source => source.name === (verified(record) ? 'Submission.lean' : 'Challenge.lean')) ?? record.sources[0]);
}

function sourceView(record: ArchiveRecord) {
  const source = currentSource(record);
  state.sourceName = source.name;
  if (!loadedSources(record.id)) {
    loadSources(record.id).then(() => showLoadedSource(record), () => showLoadedSource(record, true));
    return `<p class="source-loading" role="status">${strings.loadingSource}</p>`;
  }
  const lines = source.code.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return `<div class="source-toolbar"><label class="sr-only" for="source-file">${strings.leanFile}</label>
      <select id="source-file">${record.sources.map(file => `<option value="${html(file.name)}" ${file.name === source.name ? 'selected' : ''}>${html(file.name)}</option>`).join('')}</select>
      ${iconButton('jump-declaration', strings.jump, 'list-start')}${iconButton('copy-source', strings.copySource, 'copy')}${iconButton('download-source', strings.downloadSource, 'download')}
    </div>
    <pre class="source-code" tabindex="0" aria-label="${html(strings.sourceLabel(source.name))}"><code>${lines.map((line, index) => `<span class="code-line ${record.declaration && line.startsWith(record.declaration) ? 'is-declaration' : ''}"><span class="line-number" aria-hidden="true">${index + 1}</span><span>${html(line) || ' '}</span></span>`).join('')}</code></pre>
    <p class="source-facts"><strong>${source.lines.toLocaleString('en')} lines · SHA-256</strong><br>${source.sha256}</p>
    <div class="detail-links">${external(source.url, record.campaign ? strings.rawSource : strings.githubFile, 'button')}${iconButton('copy-hash', strings.copyHash, 'hash', source.sha256)}</div>`;
}

function evidence(record: ArchiveRecord) {
  if (record.campaign) {
    const entry = record.campaign;
    return `<div class="evidence-entry campaign-evidence"><h3>${strings.nativeEvidence}</h3><p>${strings.nativeScope}</p>
      <dl class="record-facts"><div><dt>Run ID</dt><dd class="mono">${html(entry.runId)}</dd></div>
      <div><dt>Lean</dt><dd class="mono">kernel_verified</dd></div>
      <div><dt>Comparator</dt><dd class="mono">exit ${entry.comparatorExitCode} · evaluated_passed</dd></div>
      <div><dt>Review</dt><dd class="mono">${html(entry.reviewStatus ?? strings.unrecorded)}</dd></div>
      <div><dt>Proof commit</dt><dd class="mono">${html(entry.proofCommit)}</dd></div>
      <div><dt>SHA-256</dt><dd class="mono">${entry.proofSha256}</dd></div>
      <div><dt>Lean receipts</dt><dd class="mono">${entry.kernelReceiptIds.map(html).join('<br>')}</dd></div></dl>
      ${external(entry.evidenceUrl, 'verification.json', 'button')}</div>
      <div class="evidence-entry"><h3>${strings.production}</h3><p>${html(locale === 'en' ? entry.attributionEn ?? entry.attribution : entry.attribution)}</p></div>`;
  }
  if (!record.official) {
    return `<div class="evidence-entry"><h3>${strings.snapshot}</h3><p>${timestamp(record.updatedAt)}</p><p>${strings.noOfficial}</p>${external(record.archiveUrl, strings.snapshotFiles)}</div>
      <dl class="record-facts"><div><dt>Run ID</dt><dd class="mono">${html(record.snapshot?.runId ?? '')}</dd></div></dl>${taskChart(record)}`;
  }
  const official = record.official;
  const local = record.local;
  return `<div class="evidence-entry"><h3>${strings.leanEval}</h3><p>${timestamp(record.updatedAt)}</p>${external(official.resultUrl, strings.viewOfficial, 'inline-link official-result-link')}
    <pre class="evidence-body">${html(official.resultBody)}</pre></div>
    ${local ? `<div class="evidence-entry"><h3>${strings.localEvidence}</h3><p class="mono">${html(local.status)}<br>kernel_verified: ${local.kernelVerified}<br>comparator: ${html(local.comparator ?? strings.unrecorded)}</p>
      ${local.receipt ? `<p class="mono">receipt: ${html(local.receipt)}</p>` : ''}<p>Axioms: ${html(local.axioms.join(', ') || strings.unrecorded)}</p>
      ${local.sourceProofCommit ? `<p class="mono">proof commit: ${html(local.sourceProofCommit)}</p>` : ''}
      ${local.sourceBinding === 'differs' ? `<p class="binding-note">${strings.differs}</p>` : `<p>${sourceBindingLabels[local.sourceBinding]}</p>`}
      ${external(local.url, 'verification.json')}</div>` : ''}
    <div class="evidence-entry"><h3>${strings.submission}</h3><p class="mono">${html(official.sourceCommit)}</p>${external(official.sourceUrl, strings.submissionLink)}${external(official.submissionUrl, strings.discussion)}</div>
    ${local?.production ? `<details class="production-note"><summary>${strings.production}</summary><p><span class="note-label">Production</span>${html(local.production.mode)}</p>
      ${local.production.freshFromZero === false ? `<p>${strings.resumed}</p>` : ''}
      ${local.production.humanDirection ? `<p><span class="note-label">Human direction</span>${html(local.production.humanDirection)}</p>` : ''}</details>` : ''}
    <div class="detail-section"><div class="section-title"><h3>${strings.checksums}</h3><span>SHA-256</span></div><dl class="checksum-list">${Object.entries(official.checksums).map(([file, digest]) => `<dt>${html(file)}${iconButton('copy-hash', strings.copyChecksum(file), 'copy', digest)}</dt><dd>${digest}</dd>`).join('')}</dl></div>`;
}

function processEvidenceView(run: ArchiveProcess['runs'][number]): string {
  const list = <T>(values: T[] | undefined, render: (value: T) => string) => values === undefined
    ? `<p>${strings.unknownEvidence}</p>` : values.length ? `<ul>${values.map(value => `<li>${render(value)}</li>`).join('')}</ul>`
      : `<p>${strings.noEntries}</p>`;
  const textList = (values: string[]) => values.length ? values.map(html).join('; ') : strings.noEntries;
  const modules = (values: NonNullable<NonNullable<typeof run.libraryUsage>['canonical']>['modules']) =>
    values.length ? values.map(module => `${html(module.name)}${module.mentioned.length
      ? ` (${strings.lexicalMentions}: ${textList(module.mentioned)})` : ''}`).join('; ') : strings.noEntries;
  const usage = run.libraryUsage;
  return `<details class="process-research-evidence"><summary>${strings.reuse}</summary><p>${strings.reuseNote}</p>
    <h4>${strings.sourceUses}</h4>${list(run.sourceUses, use => `<p><strong>${html(use.kind)}</strong> · ${html(use.reference)} · ${html(use.locator)}</p>
      <p>${strings.consumer}: ${html(use.consumer.taskId)}</p><p>${strings.assumptions}: ${textList(use.assumptions)}</p>
      <p>${strings.adaptation}: ${html(use.adaptation)}</p><p>${strings.remaining}: ${textList(use.remaining)}</p>`)}
    <h4>${strings.lemmaRequests}</h4>${list(run.lemmaRequests, task => `<p><strong>${html(task.theorem ?? task.id)}</strong> · ${html(task.deliveryStatus)}</p>
      <p>${html(task.objective)}</p>${task.type ? `<p class="mono">${html(task.type)}</p>` : ''}
      <p>${strings.dependencies}: ${textList(task.dependencies)}</p>`)}
    <h4>${strings.knowledgeApplications}</h4>${list(run.knowledgeApplications, use => `<p><strong>${html(use.declaration.name)}</strong> · ${html(use.declaration.file)}</p>
      <p>${strings.consumer}: ${html(use.consumer.taskId)}</p><p>${use.check
        ? html(strings.applicationChecks[use.check.status] ?? use.check.status) : strings.unknownEvidence}</p>
      ${use.check?.reason ? `<p>${html(use.check.reason)}</p>` : ''}`)}
    <h4>${strings.libraryUsage}</h4>${usage ? `<p>${strings.moduleNote}</p><ul>
      <li>${strings.installedModules}: ${usage.installed ? textList(usage.installed.map(module => module.name)) : strings.unknownEvidence}</li>
      <li>${strings.draftModules}: ${usage.drafts ? usage.drafts.length ? usage.drafts.map(draft =>
        `${html(draft.workerId)} · ${html(draft.sourceDigest.slice(0, 12))}: ${modules(draft.modules)}`).join('; ') : strings.noEntries : strings.unknownEvidence}</li>
      <li>${strings.canonicalModules}: ${usage.canonical ? `${html(usage.canonical.commit.slice(0, 12))} · ${modules(usage.canonical.modules)}` : strings.unknownEvidence}</li>
      <li>${strings.checkedModules}: ${usage.checked ? `${html(usage.checked.commit.slice(0, 12))} · ${modules(usage.checked.modules)}` : strings.unknownEvidence}</li>
    </ul>` : `<p>${strings.unknownEvidence}</p>`}</details>`;
}

function processView(record: ArchiveRecord): string {
  const process = window.theoremosProcesses?.[record.id];
  if (!process) {
    const refresh = (failed: boolean) => {
      if (state.tab !== 'process' || selectedRecord() !== record) return;
      element('#detail-panel').innerHTML = failed ? `<p role="status">${strings.processUnavailable}</p>` : processView(record);
      icons();
    };
    void loadProcess(record).then(() => refresh(false), () => refresh(true));
    return `<p class="source-loading" role="status">${strings.loadingProcess}</p>`;
  }
  return `<p class="process-intro">${strings.processNote}</p><ol class="process-runs">${process.runs.map((run, index) => `
    <li><details class="process-run" ${run.runId === record.campaign?.runId ? 'open' : ''}><summary><strong>${index + 1} · ${html(run.resultStatus ?? run.phase)}</strong>
      <span>${run.startedAt ? timestamp(run.startedAt) : ''}</span></summary>
      <p class="process-run-id mono">${html(run.runId)}</p><p>${strings.turns(run.turns, run.workers)}</p>
      ${run.reason ? `<p>${html(run.reason)}</p>` : ''}
      <ol class="process-tasks">${run.tasks.map(task => `<li><h3>${html(task.theorem ?? task.id)}</h3><p>${html(task.objective)}</p>
        <p class="process-task-meta">${html(strings.tasks[task.status] ?? task.status)} · ${strings.attempts}: ${task.attempts}${task.checkStatus ? ` · Lean: ${html(task.checkStatus)}` : ''}</p>
        ${task.dependencies.length ? `<p>${strings.dependencies}: ${task.dependencies.map(html).join(', ')}</p>` : ''}</li>`).join('')}</ol>
      ${run.review ? `<details class="process-review"><summary>Review · ${html(run.review.status)}</summary><p>${html(run.review.summary ?? '')}</p></details>` : ''}
      ${processEvidenceView(run)}
      <ol class="process-events">${run.events.map(event => `<li><time>${timestamp(event.at)}</time><span>${html(event.kind)}${event.taskId ? ` · ${html(event.taskId)}` : ''}${event.status ? ` · ${html(event.status)}` : ''}</span>${event.message ? `<p>${html(event.message)}</p>` : ''}</li>`).join('')}</ol>
      ${run.finishedAt ? `<p class="process-run-end">${timestamp(run.finishedAt)}</p>` : ''}</details></li>`).join('')}</ol>
      <div class="detail-links">${external(record.archiveUrl, 'process.json', 'button')}</div>`;
}

function renderInspector(record?: ArchiveRecord) {
  if (!record) {
    element('#inspector').innerHTML = `<div class="inspector-empty">${icon('files')}<span>${strings.empty}</span></div>`;
    return;
  }
  if (state.tab === 'process' && !record.processSummary) state.tab = 'overview';
  element('#inspector').innerHTML = `<div class="detail-topline"><span class="detail-topline-label">${icon('files')}${strings.details}</span><div class="detail-actions">${iconButton('copy-link', strings.copyLink, 'link-2')}${iconButton('download-record', strings.downloadRecord, 'download')}</div></div>
    <h2 class="detail-title">${html(record.title)}</h2><p class="detail-subtitle">${html(record.subtitle)}</p><p class="detail-id">${record.id}</p>
    <div class="detail-statusline">${statusBadge(record)}<span>${record.campaign ? 'OpenAI Math' : 'Lean-Eval'} · ${html(record.area)}</span></div>
    <div class="detail-tabs" role="tablist" aria-label="${strings.detailTabs}">${([
      ['overview', strings.tabs.overview], ['source', strings.tabs.source], ['evidence', strings.tabs.evidence],
      ...(record.processSummary ? [['process', strings.tabs.process] as const] : []),
    ] as const).map(([tab, label]) => `<button type="button" role="tab" id="tab-${tab}" aria-controls="detail-panel" aria-selected="${state.tab === tab}" tabindex="${state.tab === tab ? 0 : -1}" data-tab="${tab}">${label}</button>`).join('')}</div>
    <div class="detail-panel" id="detail-panel" role="tabpanel" tabindex="0" aria-labelledby="tab-${state.tab}">${state.tab === 'overview' ? overview(record) : state.tab === 'source' ? sourceView(record) : state.tab === 'process' ? processView(record) : evidence(record)}</div>`;
  if (state.tab === 'source' && loadedSources(record.id)) requestAnimationFrame(() => jumpToDeclaration(record));
}

function showLoadedSource(record: ArchiveRecord, failed = false) {
  const panel = document.querySelector<HTMLElement>('#detail-panel');
  if (!panel || state.tab !== 'source' || selectedRecord() !== record) return;
  panel.innerHTML = failed ? `<p class="source-loading" role="status">${strings.sourceUnavailable}</p><div class="detail-links">${external(currentSource(record).url, record.campaign ? strings.rawSource : strings.githubFile, 'button')}</div>` : sourceView(record);
  icons();
  if (!failed) jumpToDeclaration(record);
}

function jumpToDeclaration(record: ArchiveRecord) {
  const source = currentSource(record);
  const start = source.code.split('\n').findIndex(line => record.declaration && line.startsWith(record.declaration));
  const panel = document.querySelector<HTMLElement>('.source-code');
  if (panel) panel.scrollTop = Math.max(0, start - 3) * 20;
}

function render() {
  const shown = filteredRecords();
  if (!shown.some(record => record.id === state.selected)) {
    state.selected = shown[0]?.id ?? '';
    state.sourceName = '';
  }
  element('#archive-view').hidden = state.view !== 'archive';
  element('#quickstart-view').hidden = state.view !== 'quickstart';
  document.querySelectorAll<HTMLAnchorElement>('[data-view-link]').forEach(link => {
    const active = link.dataset.viewLink === state.view;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  element<HTMLInputElement>('#search').value = state.query;
  element<HTMLSelectElement>('#sort').value = state.sort;
  document.querySelectorAll<HTMLInputElement>('input[name="status"]').forEach(input => input.checked = input.value === state.filter);
  renderList(shown);
  renderInspector(selectedRecord());
  icons();
  writeLocation();
}

let toastTimeout: ReturnType<typeof setTimeout>;
function toast(message: string) {
  const notification = element('#toast');
  notification.textContent = message;
  notification.hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => notification.hidden = true, 2400);
}

async function copy(value: string) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else {
      const field = document.createElement('textarea');
      field.value = value;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      if (!copied) throw new Error('Clipboard unavailable');
    }
    toast(strings.copied);
  } catch {
    toast(strings.copyFailed);
  }
}

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.addEventListener('click', event => {
  const target = (event.target as Element).closest<HTMLElement>('[data-proof-id], [data-tab], [data-action], [data-view-link]');
  if (!target) return;
  if (target.dataset.viewLink) {
    event.preventDefault();
    state.view = target.dataset.viewLink;
    writeLocation(true);
    render();
    return;
  }
  if (target.dataset.proofId) {
    state.selected = target.dataset.proofId;
    state.sourceName = '';
    render();
    element(`[data-proof-id="${state.selected}"]`).focus({ preventScroll: true });
    if (matchMedia('(max-width: 700px)').matches) element('#inspector').scrollIntoView({ block: 'start' });
    return;
  }
  if (target.dataset.tab) {
    state.tab = target.dataset.tab as Tab;
    renderInspector(selectedRecord());
    icons();
    writeLocation();
    element(`#tab-${state.tab}`).focus({ preventScroll: true });
    return;
  }
  const record = selectedRecord();
  switch (target.dataset.action) {
    case 'quickstart': state.view = 'quickstart'; writeLocation(true); render(); break;
    case 'reset': state.query = ''; state.filter = 'all'; render(); element('#search').focus(); break;
    case 'copy-link': void copy(location.href); break;
    case 'copy-hash': void copy(target.dataset.value ?? ''); break;
    case 'jump-declaration': if (record) jumpToDeclaration(record); break;
    case 'copy-source': if (record) void copy(currentSource(record).code); break;
    case 'download-source': if (record) download(`${record.id}-${currentSource(record).name.replaceAll('/', '-')}`, currentSource(record).code, 'text/plain;charset=utf-8'); break;
    case 'download-record': if (record) void Promise.all([loadSources(record.id), loadProcess(record)]).then(([, process]) => {
      const { excerpt: _excerpt, ...full } = record;
      download(`${record.id}.json`, JSON.stringify({ ...full, ...(process ? { process } : {}), sources: record.sources.map(source => withCode(record, source)) }, null, 2), 'application/json');
    }, () => toast(strings.sourceUnavailable)); break;
  }
});

element<HTMLInputElement>('#search').addEventListener('input', event => {
  state.query = (event.target as HTMLInputElement).value;
  render();
});
element<HTMLSelectElement>('#sort').addEventListener('change', event => {
  state.sort = (event.target as HTMLSelectElement).value as Sort;
  render();
});
document.querySelectorAll<HTMLInputElement>('input[name="status"]').forEach(input => input.addEventListener('change', () => {
  state.filter = input.value as Filter;
  render();
}));
element('#inspector').addEventListener('change', event => {
  if ((event.target as HTMLElement).id !== 'source-file') return;
  state.sourceName = (event.target as HTMLSelectElement).value;
  renderInspector(selectedRecord());
  icons();
  element('#source-file').focus({ preventScroll: true });
});
document.addEventListener('keydown', event => {
  const target = event.target as HTMLElement;
  if (target.matches('[data-tab]') && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const tabs = [...document.querySelectorAll<HTMLElement>('.detail-tabs [data-tab]')].map(tab => tab.dataset.tab as Tab);
    const index = tabs.indexOf(state.tab);
    state.tab = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1)! : tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    renderInspector(selectedRecord());
    icons();
    writeLocation();
    element(`#tab-${state.tab}`).focus({ preventScroll: true });
  }
  if (target.matches('[data-proof-id]') && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const shown = filteredRecords();
    const current = shown.findIndex(record => record.id === state.selected);
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? shown.length - 1 :
      (current + (event.key === 'ArrowDown' ? 1 : shown.length - 1)) % shown.length;
    state.selected = shown[index].id;
    state.sourceName = '';
    render();
    element(`[data-proof-id="${state.selected}"]`).focus();
  }
});
window.addEventListener('hashchange', () => {
  if (!location.hash.includes('=')) return;
  readLocation();
  render();
});
window.addEventListener('popstate', () => { readLocation(); render(); });

const acceptedCount = catalog.records.filter(accepted).length;
const localCount = catalog.records.filter(record => record.status === 'locally_verified').length;
const counts: Record<string, string> = {
  '#nav-count': String(catalog.records.length), '#all-filter-count': String(catalog.records.length),
  '#accepted-count': String(acceptedCount), '#accepted-filter-count': String(acceptedCount),
  '#verified-count': String(localCount), '#verified-filter-count': String(localCount),
  '#progress-count': String(catalog.records.length - acceptedCount - localCount), '#progress-filter-count': String(catalog.records.length - acceptedCount - localCount),
  '#line-count': catalog.records.reduce((sum, record) => sum + record.sources.reduce((count, source) => count + source.lines, 0), 0).toLocaleString('en'),
  '#snapshot-date': date(catalog.snapshotAt),
};
for (const [selector, value] of Object.entries(counts)) element(selector).textContent = value;
readLocation();
render();
keepHashOnLanguageSwitch();
