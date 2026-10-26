import { createElement, errorText, escapeHtml as h, jsonText, codeBlock, patchSection, type WebApi } from './collaborationUi';

type Packet = Record<string, unknown>;
const record = (value: unknown): Packet => value && typeof value === 'object' && !Array.isArray(value) ? value as Packet : {};
const records = (value: unknown): Packet[] => Array.isArray(value) ? value.map(record) : [];
export type KnowledgeCatalog = { digest: string; createdAt: string; entries: number; routeFindings: number };
export type KnowledgeResearchContext = {
  environmentDigest?: string;
  problemId?: string;
  task?: { id: string; version: string; goal: string };
};

export class KnowledgeView {
  readonly element = createElement('section', 'collab-knowledge');
  private selectedDigest = '';
  private selectionInitialized = false;
  private digest = '';
  private selectedId = '';
  private query = '';
  private request = 0;
  private context: KnowledgeResearchContext = {};
  private contextKey = '';
  private catalogLoading?: Promise<void>;
  private loadedCatalogs?: Set<string>;
  private results = createElement('div', 'collab-knowledge-results');
  private detail = createElement('div', 'collab-knowledge-detail');
  private status = createElement('p', 'collab-help');
  private contextSummary = createElement('div', 'collab-help');
  private catalog: HTMLSelectElement;
  constructor(private api: WebApi, private reference: (text: string) => void) {
    this.element.innerHTML = `<div class="collab-section-heading"><h3>可复用知识</h3></div><p class="collab-help">历史证明、路线发现与来源一起保留；引用后仍需在当前题目和环境中检查。</p><form class="collab-knowledge-search"><label class="sr-only" for="knowledge-search">搜索知识</label><input id="knowledge-search" type="search" placeholder="定理、类型、路线发现" maxlength="2000"><label class="sr-only" for="knowledge-catalog-search">知识目录</label><select id="knowledge-catalog-search"><option value="">最新知识目录</option></select><button class="button" type="submit">搜索</button></form>`;
    this.catalog = this.element.querySelector('select')!;
    this.contextSummary.setAttribute('data-knowledge-context', '');
    this.element.append(this.contextSummary, this.status, this.results, this.detail);
    this.element.querySelector('form')!.addEventListener('submit', event => { event.preventDefault(); this.query = this.element.querySelector('input')!.value; void this.search(); });
    this.catalog.addEventListener('change', () => { this.selectedDigest = this.catalog.value; void this.search(); });
    this.results.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('[data-knowledge-id]');
      if (button) void this.read(button.dataset.knowledgeId!);
    });
    this.detail.addEventListener('click', event => {
      const button = (event.target as Element).closest<HTMLButtonElement>('button'); if (!button) return;
      if (button.hasAttribute('data-knowledge-reference') && this.selectedId && this.digest) this.reference([
        `参考历史知识 ${this.selectedId}`, `目录 ${this.digest}`,
        this.context.problemId && `当前问题 ${this.context.problemId}`,
        this.context.task && `关联任务 ${this.context.task.id} · 版本 ${this.context.task.version}`,
        this.context.environmentDigest ? `当前记录环境 ${this.context.environmentDigest}` : '当前环境尚未记录',
        '这是历史证据。请核对完整类型、前提、来源与环境，在关联任务的当前版本中重新检查；引用不代表当前证明或独立验收通过。',
      ].filter(Boolean).join('\n'));
      else if (button.dataset.knowledgePage) void this.read(this.selectedId, button.dataset.knowledgePage);
    });
  }
  update(preferredDigest?: string, exportedDigest?: string, context: KnowledgeResearchContext = {}) {
    if (!this.selectionInitialized) {
      this.selectionInitialized = true; this.selectedDigest = preferredDigest ?? '';
      if (this.selectedDigest) this.ensureOption(this.selectedDigest);
      this.catalog.value = this.selectedDigest;
    }
    const nextContext = { environmentDigest: context.environmentDigest, problemId: context.problemId, task: context.task && { ...context.task } };
    const contextKey = JSON.stringify(nextContext);
    if (contextKey !== this.contextKey) {
      this.context = nextContext; this.contextKey = contextKey;
      patchSection(this.contextSummary, `<p>${context.problemId ? `当前问题 <code>${h(context.problemId)}</code>` : '当前问题尚未记录'} · ${context.task ? `关联任务 <code>${h(context.task.id)}</code> · 版本 <code>${h(context.task.version)}</code>` : '尚未选择任务'}</p><p>${context.environmentDigest ? `记录环境 <code>${h(context.environmentDigest)}</code>` : '未提供当前环境，检索结果无法比较环境'}</p>${context.task ? `<details class="collab-detail"><summary>当前任务的类型或目标</summary>${codeBlock(context.task.goal)}</details>` : ''}`);
      void this.search();
    }
    if (!this.catalogLoading && (!this.loadedCatalogs || exportedDigest && !this.loadedCatalogs.has(exportedDigest))) void this.refreshCatalogs();
  }
  private environmentLabel(match: unknown) {
    if (!this.context.environmentDigest) return '未提供当前环境';
    return match === 'match' ? '记录环境一致' : match === 'different' ? '记录环境不同' : '历史环境未记录';
  }
  refreshCatalogs(): Promise<void> {
    if (this.catalogLoading) return this.catalogLoading.then(() => this.refreshCatalogs());
    this.catalogLoading = this.loadCatalogs().finally(() => { this.catalogLoading = undefined; });
    return this.catalogLoading;
  }
  private ensureOption(digest: string) { if (![...this.catalog.options].some(option => option.value === digest)) this.catalog.add(new Option(digest, digest)); }
  private async loadCatalogs() {
    try {
      const { catalogs, latestDigest } = await this.api<{ catalogs: KnowledgeCatalog[]; latestDigest: string | null }>('/api/knowledge/catalogs');
      this.loadedCatalogs = new Set(catalogs.map(catalog => catalog.digest));
      for (const catalog of catalogs) { this.ensureOption(catalog.digest); this.catalog.querySelector<HTMLOptionElement>(`option[value="${CSS.escape(catalog.digest)}"]`)!.textContent = `${catalog.digest.slice(0, 14)} · ${catalog.entries} 定理 / ${catalog.routeFindings} 发现`; }
      this.catalog.value = this.selectedDigest;
      if (!catalogs.length) this.status.textContent = '尚无已归档知识目录';
      else if (!this.selectedDigest && latestDigest !== this.digest && this.query.trim()) await this.search();
      else if (!this.digest) this.status.textContent = `已加载 ${catalogs.length} 个知识目录`;
    } catch (error) { this.status.textContent = errorText(error); }
  }
  private async search() {
    const request = ++this.request;
    this.selectedId = ''; this.digest = ''; patchSection(this.detail, ''); patchSection(this.results, '');
    if (!this.query.trim()) { this.status.textContent = '输入定理、类型或路线发现以搜索'; return; }
    this.status.textContent = '正在搜索';
    try {
      const query = new URLSearchParams({ q: this.query }); if (this.selectedDigest) query.set('catalogDigest', this.selectedDigest);
      if (this.context.task?.goal) query.set('goal', this.context.task.goal);
      if (this.context.environmentDigest) query.set('environmentDigest', this.context.environmentDigest);
      const payload = await this.api<{ catalogDigest: string | null; results: Packet; findings: Packet }>(`/api/knowledge/search?${query}`);
      if (request !== this.request) return;
      this.digest = payload.catalogDigest ?? '';
      if (this.digest) this.ensureOption(this.digest);
      const theorems = records(payload.results.hits), findings = records(payload.findings.hits);
      this.status.textContent = `${payload.results.total ?? 0} 个定理 · ${payload.findings.total ?? 0} 个路线发现`;
      patchSection(this.results, [...theorems.map(item => `<button type="button" class="collab-knowledge-hit" data-knowledge-id="${h(item.id)}"><span class="collab-eyebrow">定理 · ${h(item.kind === 'goal' ? '原始目标' : item.kind === 'lemma' ? '引理' : item.kind)}</span><strong>${h(item.name)}</strong><code>${h(item.typePreview)}</code><small>${h(this.environmentLabel(item.environmentMatch))} · 来源问题 ${h(item.problemIds && jsonText(item.problemIds))} · 需在当前任务中重新检查</small></button>`), ...findings.map(item => `<button type="button" class="collab-knowledge-hit" data-knowledge-id="${h(item.id)}"><span class="collab-eyebrow">路线发现 · 建议</span><strong>${h(({supporting:'支持记录路线',refuted:'记录路线受阻',inconclusive:'记录尚无定论'} as Record<string,string>)[String(item.conclusion)] ?? item.conclusion)}</strong><span>${h(item.summary)}</span><small>${h(this.environmentLabel(item.environmentMatch))} · ${item.statementMatch === 'exact-recorded-text' ? '目标与记录文本一致' : '仅关键词相关'} · ${item.scopeMatch === 'statement-and-recorded-environment' ? '记录范围一致，仍需复核' : '适用范围尚未确认'}</small></button>`)].join('') || '<p class="collab-help">未找到相关记录</p>');
    } catch (error) { if (request === this.request) this.status.textContent = errorText(error); }
  }
  private pageButton(label: string, query: URLSearchParams) { return `<button type="button" class="button" data-knowledge-page="${h(query.toString())}">${h(label)}</button>`; }
  private renderEntry(entry: Packet, query: string) {
    const metadata = record(entry.metadata), fields = record(metadata.fields);
    const title = record(fields.name).value ?? this.selectedId;
    let markup = `<div class="collab-section-heading"><h4>${h(title)}</h4><button type="button" class="button" data-knowledge-reference data-focus-key="knowledge-reference">引用到指导草稿</button></div><p class="collab-help mono">${h(this.selectedId)} · ${h(this.digest)}</p><p class="collab-help">历史证据${this.context.task ? ` · 关联任务 ${h(this.context.task.id)} · 版本 ${h(this.context.task.version)}` : ''}；需在当前任务中重新检查。</p>`;
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'kind') continue;
      const packet = record(value);
      markup += `<details class="collab-detail" open data-detail-key="knowledge-${h(key)}"><summary>${h(({metadata:'类型、前提与来源',source:'证明源码',dependencies:'依赖',consumers:'使用记录',finding:'路线发现'} as Record<string,string>)[key] ?? key)}</summary>`;
      if (key === 'metadata' && metadata.mode === 'summary') {
        markup += Object.entries(fields).map(([name, descriptor]) => {
          const field = record(descriptor);
          const query = new URLSearchParams({ view: 'metadata', field: name, startOffset: '0' });
          return `<div class="collab-knowledge-field"><h5>${h(name)}</h5>${field.complete ? codeBlock(field.value) : this.pageButton(`读取完整 ${name}`, query)}</div>`;
        }).join('');
        markup += codeBlock({ contextDigest: metadata.contextDigest, sourceSha256: metadata.sourceSha256, typeKind: metadata.typeKind });
        const files = record(fields.files).value;
        if (Array.isArray(files)) markup += files.map(file => { const path = record(file).file; return typeof path === 'string' ? this.pageButton(`读取 ${path}`, new URLSearchParams({view:'source',file:path,startOffset:'0'})) : ''; }).join('');
      } else markup += codeBlock(typeof packet.text === 'string' ? packet.text : value);
      const next = new URLSearchParams(query); next.set('view', key);
      if (typeof packet.nextOffset === 'number') { next.set(key === 'consumers' ? 'offset' : 'startOffset', String(packet.nextOffset)); markup += this.pageButton('继续读取', next); }
      else if (key === 'source' && packet.truncated) markup += '<p class="collab-help">本页是源码片段</p>';
      if (key === 'dependencies' && record(packet.truncated).depth && Number(next.get('depth') ?? 2) < 8) { next.set('depth', String(Number(next.get('depth') ?? 2) + 1)); markup += this.pageButton('展开下一层依赖', next); }
      markup += '</details>';
    }
    return markup;
  }
  private async read(id: string, query = '') {
    const request = ++this.request; this.selectedId = ''; patchSection(this.detail, ''); this.status.textContent = '正在读取知识记录';
    try {
      const parameters = new URLSearchParams(query); if (this.digest || this.selectedDigest) parameters.set('catalogDigest', this.digest || this.selectedDigest);
      const payload = await this.api<{ catalogDigest: string; entry: Packet }>(`/api/knowledge/${encodeURIComponent(id)}?${parameters}`);
      if (request !== this.request) return;
      this.digest = payload.catalogDigest; this.selectedId = id;
      patchSection(this.detail, this.renderEntry(payload.entry, query)); this.status.textContent = '正在查看归档证据';
    } catch (error) { if (request === this.request) this.status.textContent = errorText(error); }
  }
}
