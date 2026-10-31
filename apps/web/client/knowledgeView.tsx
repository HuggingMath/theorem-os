import { Fragment } from 'preact';
import { createElement, errorText, jsonText, observedTime, type WebApi } from './collaborationUi';
import { Code, renderSection } from './ui/Section';
import { t } from '../i18n';

type Packet = Record<string, unknown>;
const record = (value: unknown): Packet => value && typeof value === 'object' && !Array.isArray(value) ? value as Packet : {};
const records = (value: unknown): Packet[] => Array.isArray(value) ? value.map(record) : [];
const text = (value: unknown) => String(value ?? '');
export type KnowledgeCatalog = { digest: string; createdAt: string; entries: number; routeFindings: number };
/** A catalog named by when it was saved and what it holds; its digest stays the option's value and title. */
export const catalogLabel = (catalog: KnowledgeCatalog, findings = false) => findings
  ? t('{0} · {1} 定理 / {2} 发现', observedTime(catalog.createdAt), catalog.entries, catalog.routeFindings)
  : t('{0} · {1} 定理', observedTime(catalog.createdAt), catalog.entries);
export type KnowledgeResearchContext = {
  environmentDigest?: string;
  problemId?: string;
  task?: { id: string; version: string; goal: string };
};
type Results = { theorems: Packet[]; findings: Packet[] };
type Entry = { entry: Packet; query: string };
const sectionTitles = (): Record<string, string> => ({ metadata: t('类型、前提与来源'), source: t('证明源码'), dependencies: t('依赖'), consumers: t('使用记录'), finding: t('路线发现') });
const conclusions = (): Record<string, string> => ({ supporting: t('支持记录路线'), refuted: t('记录路线受阻'), inconclusive: t('记录尚无定论') });

export class KnowledgeView {
  readonly element = createElement('section', 'collab-knowledge');
  private selectedDigest = '';
  private selectionInitialized = false;
  private digest = '';
  private selectedId = '';
  private query = '';
  private draft = '';
  private request = 0;
  private context: KnowledgeResearchContext = {};
  private contextKey = '';
  private catalogLoading?: Promise<void>;
  private loadedCatalogs?: Set<string>;
  /** Catalog options in arrival order; digests seen only in a run or search keep the digest as label. */
  private catalogs = new Map<string, string>();
  private status = '';
  private results?: Results;
  private entry?: Entry;
  constructor(private api: WebApi, private reference: (text: string) => void) {
    this.render();
  }
  update(preferredDigest?: string, exportedDigest?: string, context: KnowledgeResearchContext = {}) {
    if (!this.selectionInitialized) {
      this.selectionInitialized = true; this.selectedDigest = preferredDigest ?? '';
      if (this.selectedDigest) this.ensureOption(this.selectedDigest);
      this.render();
    }
    const nextContext = { environmentDigest: context.environmentDigest, problemId: context.problemId, task: context.task && { ...context.task } };
    const contextKey = JSON.stringify(nextContext);
    if (contextKey !== this.contextKey) {
      this.context = nextContext; this.contextKey = contextKey;
      void this.search();
    }
    if (!this.catalogLoading && (!this.loadedCatalogs || exportedDigest && !this.loadedCatalogs.has(exportedDigest))) void this.refreshCatalogs();
  }
  private environmentLabel(match: unknown) {
    if (!this.context.environmentDigest) return t('未提供当前环境');
    return match === 'match' ? t('记录环境一致') : match === 'different' ? t('记录环境不同') : t('历史环境未记录');
  }
  refreshCatalogs(): Promise<void> {
    if (this.catalogLoading) return this.catalogLoading.then(() => this.refreshCatalogs());
    this.catalogLoading = this.loadCatalogs().finally(() => { this.catalogLoading = undefined; });
    return this.catalogLoading;
  }
  private ensureOption(digest: string) { if (!this.catalogs.has(digest)) this.catalogs.set(digest, digest); }
  private async loadCatalogs() {
    try {
      const { catalogs, latestDigest } = await this.api<{ catalogs: KnowledgeCatalog[]; latestDigest: string | null }>('/api/knowledge/catalogs');
      this.loadedCatalogs = new Set(catalogs.map(catalog => catalog.digest));
      for (const catalog of catalogs) this.catalogs.set(catalog.digest, catalogLabel(catalog, true));
      if (!catalogs.length) this.status = t('尚无已归档知识目录');
      else if (!this.selectedDigest && latestDigest !== this.digest && this.query.trim()) { this.render(); await this.search(); }
      else if (!this.digest) this.status = t('已加载 {0} 个知识目录', catalogs.length);
    } catch (error) { this.status = errorText(error); }
    this.render();
  }
  private async search() {
    const request = ++this.request;
    this.selectedId = ''; this.digest = ''; this.entry = undefined; this.results = undefined;
    if (!this.query.trim()) { this.status = t('输入定理、类型或路线发现以搜索'); this.render(); return; }
    this.status = t('正在搜索'); this.render();
    try {
      const query = new URLSearchParams({ q: this.query }); if (this.selectedDigest) query.set('catalogDigest', this.selectedDigest);
      if (this.context.task?.goal) query.set('goal', this.context.task.goal);
      if (this.context.environmentDigest) query.set('environmentDigest', this.context.environmentDigest);
      const payload = await this.api<{ catalogDigest: string | null; results: Packet; findings: Packet }>(`/api/knowledge/search?${query}`);
      if (request !== this.request) return;
      this.digest = payload.catalogDigest ?? '';
      if (this.digest) this.ensureOption(this.digest);
      this.results = { theorems: records(payload.results.hits), findings: records(payload.findings.hits) };
      this.status = t('{0} 个定理 · {1} 个路线发现', payload.results.total ?? 0, payload.findings.total ?? 0);
    } catch (error) { if (request === this.request) this.status = errorText(error); }
    if (request === this.request) this.render();
  }
  private async read(id: string, query = '') {
    const request = ++this.request; this.selectedId = ''; this.entry = undefined; this.status = t('正在读取知识记录'); this.render();
    try {
      const parameters = new URLSearchParams(query); if (this.digest || this.selectedDigest) parameters.set('catalogDigest', this.digest || this.selectedDigest);
      const payload = await this.api<{ catalogDigest: string; entry: Packet }>(`/api/knowledge/${encodeURIComponent(id)}?${parameters}`);
      if (request !== this.request) return;
      this.digest = payload.catalogDigest; this.selectedId = id;
      this.entry = { entry: payload.entry, query }; this.status = t('正在查看归档证据');
    } catch (error) { if (request === this.request) this.status = errorText(error); }
    if (request === this.request) this.render();
  }
  private readonly cite = () => {
    if (!this.selectedId || !this.digest) return;
    this.reference([
      t('参考历史知识 {0}', this.selectedId), t('目录 {0}', this.digest),
      this.context.problemId && t('当前问题 {0}', this.context.problemId),
      this.context.task && t('关联任务 {0} · 版本 {1}', this.context.task.id, this.context.task.version),
      this.context.environmentDigest ? t('当前记录环境 {0}', this.context.environmentDigest) : t('当前环境尚未记录'),
      t('这是历史证据。请核对完整类型、前提、来源与环境，在关联任务的当前版本中重新检查；引用不代表当前证明或独立验收通过。'),
    ].filter(Boolean).join('\n'));
  };
  private contextSummary() {
    const { problemId, task, environmentDigest } = this.context;
    return <div class="collab-help" data-knowledge-context>
      <p>{problemId ? <>{t('当前问题')} <code>{problemId}</code></> : t('当前问题尚未记录')} · {task ? <>{t('关联任务')} <code>{task.id}</code> {t('· 版本')} <code>{task.version}</code></> : t('尚未选择任务')}</p>
      <p>{environmentDigest ? <>{t('记录环境')} <code>{environmentDigest}</code></> : t('未提供当前环境，检索结果无法比较环境')}</p>
      {task && <details key={`${task.id}:${task.version}`} class="collab-detail"><summary>{t('当前任务的类型或目标')}</summary><Code value={task.goal} /></details>}
    </div>;
  }
  private hits(results: Results) {
    const theorem = (item: Packet) => <button key={`theorem-${text(item.id)}`} type="button" class="collab-knowledge-hit" data-knowledge-id={text(item.id)} onClick={() => void this.read(text(item.id))}>
      <span class="collab-eyebrow">{t('定理 · {0}', item.kind === 'goal' ? t('原始目标') : item.kind === 'lemma' ? t('引理') : text(item.kind))}</span><strong>{text(item.name)}</strong><code>{text(item.typePreview)}</code>
      <small>{t('{0} · 来源问题 {1} · 需在当前任务中重新检查', this.environmentLabel(item.environmentMatch), item.problemIds ? jsonText(item.problemIds) : '')}</small></button>;
    const finding = (item: Packet) => <button key={`finding-${text(item.id)}`} type="button" class="collab-knowledge-hit" data-knowledge-id={text(item.id)} onClick={() => void this.read(text(item.id))}>
      <span class="collab-eyebrow">{t('路线发现 · 建议')}</span><strong>{conclusions()[String(item.conclusion)] ?? text(item.conclusion)}</strong><span>{text(item.summary)}</span>
      <small>{this.environmentLabel(item.environmentMatch)} · {item.statementMatch === 'exact-recorded-text' ? t('目标与记录文本一致') : t('仅关键词相关')} · {item.scopeMatch === 'statement-and-recorded-environment' ? t('记录范围一致，仍需复核') : t('适用范围尚未确认')}</small></button>;
    if (!results.theorems.length && !results.findings.length) return <p class="collab-help">{t('未找到相关记录')}</p>;
    return <>{results.theorems.map(theorem)}{results.findings.map(finding)}</>;
  }
  private pageButton(label: string, query: URLSearchParams) {
    const page = query.toString();
    return <button type="button" class="button" data-knowledge-page={page} onClick={() => void this.read(this.selectedId, page)}>{label}</button>;
  }
  private entrySection(key: string, value: unknown, metadata: Packet, fields: Packet, query: string) {
    const packet = record(value);
    const next = new URLSearchParams(query); next.set('view', key);
    const more = typeof packet.nextOffset === 'number';
    if (more) next.set(key === 'consumers' ? 'offset' : 'startOffset', String(packet.nextOffset));
    const continued = more && this.pageButton(t('继续读取'), new URLSearchParams(next));
    const depth = Number(next.get('depth') ?? 2);
    const deeper = key === 'dependencies' && record(packet.truncated).depth && depth < 8;
    if (deeper) next.set('depth', String(depth + 1));
    const files = record(fields.files).value;
    return <details key={key} class="collab-detail" open data-detail-key={`knowledge-${key}`}><summary>{sectionTitles()[key] ?? key}</summary>
      {key === 'metadata' && metadata.mode === 'summary' ? <>
        {Object.entries(fields).map(([name, descriptor]) => {
          const field = record(descriptor);
          return <div key={name} class="collab-knowledge-field"><h5>{name}</h5>{field.complete ? <Code value={field.value} /> : this.pageButton(t('读取完整 {0}', name), new URLSearchParams({ view: 'metadata', field: name, startOffset: '0' }))}</div>;
        })}
        <Code value={{ contextDigest: metadata.contextDigest, sourceSha256: metadata.sourceSha256, typeKind: metadata.typeKind }} />
        {Array.isArray(files) && files.map(file => { const path = record(file).file; return typeof path === 'string' ? this.pageButton(t('读取 {0}', path), new URLSearchParams({ view: 'source', file: path, startOffset: '0' })) : null; })}
      </> : <Code value={typeof packet.text === 'string' ? packet.text : value} />}
      {continued || (key === 'source' && packet.truncated ? <p class="collab-help">{t('本页是源码片段')}</p> : null)}
      {deeper && this.pageButton(t('展开下一层依赖'), next)}
    </details>;
  }
  private renderEntry({ entry, query }: Entry) {
    const metadata = record(entry.metadata), fields = record(metadata.fields);
    const title = record(fields.name).value ?? this.selectedId;
    const task = this.context.task;
    // Keyed by record and page: another reading remounts, so every section opens again.
    return <Fragment key={JSON.stringify([this.selectedId, this.digest, query])}>
      <div class="collab-section-heading"><h4>{text(title)}</h4><button type="button" class="button" data-knowledge-reference data-focus-key="knowledge-reference" onClick={this.cite}>{t('引用到指导草稿')}</button></div>
      <p class="collab-help mono">{this.selectedId} · {this.digest}</p>
      <p class="collab-help">{t('历史证据{0}；需在当前任务中重新检查。', task ? t(' · 关联任务 {0} · 版本 {1}', task.id, task.version) : '')}</p>
      {Object.entries(entry).filter(([key]) => key !== 'kind').map(([key, value]) => this.entrySection(key, value, metadata, fields, query))}
    </Fragment>;
  }
  private render() {
    renderSection(this.element, <>
      <div class="collab-section-heading"><h3>{t('可复用知识')}</h3></div>
      <p class="collab-help">{t('历史证明、路线发现与来源一起保留；引用后仍需在当前题目和环境中检查。')}</p>
      <form class="collab-knowledge-search" onSubmit={event => { event.preventDefault(); this.query = this.draft; void this.search(); }}>
        <label class="sr-only" htmlFor="knowledge-search">{t('搜索知识')}</label>
        <input id="knowledge-search" type="search" placeholder={t('定理、类型、路线发现')} maxLength={2000} value={this.draft} onInput={event => { this.draft = event.currentTarget.value; }} />
        <label class="sr-only" htmlFor="knowledge-catalog-search">{t('知识目录')}</label>
        <select id="knowledge-catalog-search" value={this.selectedDigest} onChange={event => { this.selectedDigest = event.currentTarget.value; void this.search(); }}>
          <option value="">{t('最新知识目录')}</option>{[...this.catalogs].map(([digest, label]) => <option key={digest} value={digest} title={digest}>{label}</option>)}
        </select>
        <button class="button" type="submit">{t('搜索')}</button>
      </form>
      {this.contextSummary()}
      <p class="collab-help">{this.status}</p>
      <div class="collab-knowledge-results">{this.results && this.hits(this.results)}</div>
      <div class="collab-knowledge-detail">{this.entry && this.renderEntry(this.entry)}</div>
    </>);
  }
}
