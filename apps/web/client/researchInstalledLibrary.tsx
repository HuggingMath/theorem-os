import { useEffect, useRef, useState } from 'preact/hooks';
import type { InstalledLibraryDeclarationContext, InstalledLibraryDefinition, InstalledLibraryDetail, InstalledLibraryDirectory as LibraryDirectory, InstalledLibraryEntry, InstalledLibraryInfo, InstalledLibrarySource } from '../installedLibraryTypes';
import { installedLibraryLabels } from '../installedLibraryLabels';
import { installedLibraryQuerySuggestions, matchesInstalledLibraryModuleAlias } from '../installedLibrarySearch';
import { installedLibraryMathematics } from '../installedLibraryMathematics';
import { matchesInstalledLibraryInterface } from '../installedLibraryInterfaceSearch';
import { libraryReferenceHref } from './installedLibraryReference';
import { LeanName, RichProse } from './richText';
import { base, enc, Empty, ErrorBox, Field, Panel, tx, useResource, type Item } from './researchShared';

const fieldNames: Record<string, string> = {
  Algebra: tx('代数', 'Algebra'), Analysis: tx('分析', 'Analysis'), BooleanCube: tx('布尔立方体', 'BooleanCube'), Combinatorics: tx('组合数学', 'Combinatorics'),
  Geometry: tx('几何', 'Geometry'), InformationTheory: tx('信息论', 'InformationTheory'), LinearAlgebra: tx('线性代数', 'LinearAlgebra'),
  NumberTheory: tx('数论', 'NumberTheory'), Probability: tx('概率', 'Probability'), RepresentationTheory: tx('表示论', 'RepresentationTheory'),
};
const fieldLabel = (area: string) => fieldNames[area] ? tx(`${fieldNames[area]} · ${area}`, area) : area;
const readableModuleName = (name: string) => (name.split('.').at(-1) ?? name)
  .replace(/([a-z\d])([A-Z])/gu, '$1 $2').replace(/([A-Z])([A-Z][a-z])/gu, '$1 $2');
function moduleTitle(name: string) {
  const labels = installedLibraryLabels(name);
  return labels ? tx(labels.zh.title, labels.en.title) : readableModuleName(name);
}
const directoryKeys = ['q', 'type', 'collection', 'area', 'author', 'environment', 'mine', 'offset', 'workbenchChat', 'workbenchRun', 'workbenchEdit'] as const;
function directoryParameters(filters: URLSearchParams) {
  const result = new URLSearchParams();
  for (const key of directoryKeys) {
    const value = filters.get(key);
    if (value) result.set(key, value);
  }
  result.set('type', 'mathematics');
  result.set('collection', 'lean');
  return result;
}
function moduleHref(file: string, digest: string, filters: URLSearchParams, name?: string, interfaces?: { query: string; kind: string }) {
  const parameters = directoryParameters(filters);
  parameters.set('source', 'installed'); parameters.set('module', file); parameters.set('catalogDigest', digest);
  if (interfaces?.query) parameters.set('interfaceQuery', interfaces.query);
  if (interfaces?.kind) parameters.set('interfaceKind', interfaces.kind);
  return `library.html?${parameters}${name ? `#declaration-${enc(name)}` : ''}`;
}
const moduleAnchor = (file: string) => `installed-module-${file}`;
const directoryHref = (filters: URLSearchParams, file: string) => `library.html?${directoryParameters(filters)}#${enc(moduleAnchor(file))}`;

export function InstalledLibraryDirectory({ query, area, environment, offset, onOffset, onArea, onReset, onQuery, filters }: {
  query: string; area: string; environment: string; offset: number;
  onOffset: (value: number) => void; onArea: (value: string) => void; onReset: () => void; onQuery: (value: string) => void; filters: URLSearchParams;
}) {
  const result = useResource<LibraryDirectory>(`${base}/library/installed?q=${enc(query)}&area=${enc(area)}&environment=${enc(environment)}&offset=${offset}&limit=24`);
  const directory = result.data;
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  useEffect(() => {
    if (directory && location.hash.startsWith('#installed-module-')) {
      const module = directory.items.find(item => `#${enc(moduleAnchor(item.file))}` === location.hash);
      if (module) document.getElementById(moduleAnchor(module.file))?.scrollIntoView({ block: 'center' });
    }
  }, [directory]);
  return <section class="research-installed-directory" data-installed-library-directory aria-labelledby="installed-library-heading">
    <div class="research-installed-summary"><div><h2 id="installed-library-heading">{tx('现有 Lean 库', 'Existing Lean library')}</h2>
      {directory && <p><strong>{directory.library.moduleCount}</strong> {tx('个模块', 'modules')} · <strong>{directory.library.declarationCount}</strong> {tx('个接口', 'interfaces')}</p>}</div>
      {directory && <span>{directory.library.environment} · {directory.library.toolchain}</span>}</div>
    <ErrorBox message={result.error} />{result.error && <button class="button" type="button" onClick={result.refresh}>{tx('重新读取 Lean 库', 'Reload Lean library')}</button>}
    {result.loading && <p class="research-status" role="status">{tx('正在读取 Lean 库…', 'Loading Lean library…')}</p>}
    {directory && <div class="research-installed-layout"><aside class="research-installed-fields">
      <span class="research-installed-fields-label">{tx('研究领域', 'Research fields')}</span>
      <label class="research-mobile-field-picker"><span>{tx('数学领域', 'Fields of mathematics')}</span>
        <select data-installed-field-select value={area} onChange={event => onArea(event.currentTarget.value)}>
          <option value="">{tx('全部领域', 'All fields')}</option>
          {area && !directory.areas.includes(area) && <option value={area}>{area}</option>}
          {directory.areas.map(value => <option key={value} value={value}>{fieldLabel(value)}</option>)}
        </select></label>
      <div class="research-installed-areas" role="group" aria-label={tx('Lean 库领域', 'Lean library fields')}>
        <button type="button" aria-pressed={!area} onClick={() => onArea('')}>{tx('全部领域', 'All fields')}</button>
        {directory.areas.map(value => <button key={value} type="button" aria-pressed={area === value} onClick={() => onArea(value)}>{fieldLabel(value)}</button>)}
      </div>
    </aside><div class="research-installed-results">
      <div class="research-installed-result-tools"><p class="research-installed-result-count" role="status">{directory.total ? <>{tx('匹配', 'Matched')} {directory.total} {tx('个模块，当前显示', 'modules; showing')} {directory.offset + 1}–{directory.offset + directory.items.length}</>
        : tx('当前筛选没有匹配模块。', 'No modules match these filters.')}</p>
        {Boolean(query || area || environment || offset) && <button class="text-button" type="button" data-installed-reset onClick={onReset}>{tx('清除筛选', 'Clear filters')}</button>}</div>
      <div class="research-installed-modules">{directory.items.map(module => {
        const labels = installedLibraryLabels(module.name), title = moduleTitle(module.name);
        const describesModule = matchesInstalledLibraryModuleAlias(module.name, query) || [module.name, module.file, labels?.zh.title, labels?.zh.description, labels?.en.title, labels?.en.description]
          .some(value => value && tokens.every(token => value.toLocaleLowerCase().includes(token)));
        const matched = tokens.length && !describesModule ? module.matchingInterfaces[0] : undefined;
        const href = moduleHref(module.file, directory.library.catalogDigest, filters, matched?.name);
        return <article key={module.file} class="research-installed-row" id={moduleAnchor(module.file)} data-installed-library-module={module.file}>
        <div class="research-installed-row-heading"><h3 class="research-installed-title"><a data-installed-library-open={module.name} href={href} aria-label={`${title} · ${module.name}`}>
          <span>{title}</span></a></h3>
          <div class="research-installed-row-meta"><span>{fieldLabel(module.area)}</span><a href={href}>{module.entryCount} {tx('个接口', 'interfaces')} →</a></div></div>
        {labels && <p class="research-installed-module-description">{tx(labels.zh.description, labels.en.description)}</p>}
        {matched && <div class="research-installed-preview" data-installed-library-matches>
          <span class="research-installed-preview-label">{tx('匹配的接口', 'Matching interfaces')} · {module.matchingInterfaceCount}</span>
          {module.matchingInterfaces.map(entry => <div key={entry.name}>
            <a data-installed-library-match={entry.name} href={moduleHref(module.file, directory.library.catalogDigest, filters, entry.name, { query, kind: '' })}><LeanName name={entry.name} /></a>
            <div class="research-installed-module-description"><RichProse text={tx(entry.summary.zh, entry.summary.en)} /></div>
          </div>)}</div>}
        <details class="research-installed-module-tools"><summary>{tx('导入与接口预览', 'Import and interfaces')}</summary>
        <code class="research-installed-module-name">{module.name}</code>
        <div class="research-installed-import-row"><code class="research-installed-import">{module.import}</code><CopyValue value={module.import} name={module.name} /></div>
        <div class="research-installed-preview">{module.preview.length > 0 && <span class="research-installed-preview-label">{matched ? tx('匹配的接口', 'Matching interfaces') : tx('接口预览', 'Interface preview')}</span>}{module.preview.slice(0, 2).map(entry => <div key={entry.name}>
          <a href={moduleHref(module.file, directory.library.catalogDigest, filters, entry.name)}><LeanName name={entry.name} /></a>
          <pre>{entry.type}</pre>
        </div>)}</div></details>
      </article>; })}</div>
      {!directory.items.length && <Empty>{tx('可调整关键词、领域或证明环境。', 'Try another keyword, field or proof environment.')}
        <p>{tx('试试相关数学主题：', 'Try a related mathematical topic:')}</p>
        <div class="research-installed-query-suggestions">{installedLibraryQuerySuggestions(query).map(suggestion => {
          const value = tx(suggestion.zh, suggestion.en);
          return <button key={suggestion.en} type="button" class="text-button" data-installed-library-query={value} onClick={() => onQuery(value)}>{value} →</button>;
        })}</div></Empty>}
      {directory.total > 0 && (directory.offset > 0 || directory.nextOffset !== undefined) && <nav class="research-installed-pagination" aria-label={tx('Lean 库分页', 'Lean library pages')}>
        <button class="button" type="button" disabled={result.loading || directory.offset === 0} onClick={() => onOffset(Math.max(0, directory.offset - directory.limit))}>{tx('上一页', 'Previous page')}</button>
        <span>{Math.floor(directory.offset / directory.limit) + 1} / {Math.max(1, Math.ceil(directory.total / directory.limit))}</span>
        <button class="button" type="button" disabled={result.loading || directory.nextOffset === undefined} onClick={() => { if (directory.nextOffset !== undefined) onOffset(directory.nextOffset); }}>{tx('下一页', 'Next page')}</button>
      </nav>}
      <p class="research-field-note">{tx('模块随证明环境提供。用于具体题目时，研究会检查适用性、依赖和证明。', 'Modules are supplied with the proof environment. Research checks their applicability, dependencies and proof for each problem.')}</p>
    </div></div>}
  </section>;
}

export function InstalledLibraryModule({ file, catalogDigest, filters }: { file: string; catalogDigest: string; filters: URLSearchParams }) {
  const detailUrl = file && catalogDigest ? `${base}/library/installed/module?file=${enc(file)}&catalogDigest=${enc(catalogDigest)}` : undefined;
  const result = useResource<Item<InstalledLibraryDetail>>(detailUrl), detail = result.data?.item;
  const labels = detail && installedLibraryLabels(detail.module.name);
  const parameters = new URLSearchParams(location.search);
  const [sourceOpen, setSourceOpen] = useState(false), [query, setQuery] = useState(parameters.get('interfaceQuery') ?? ''),
    [kind, setKind] = useState<'' | InstalledLibraryEntry['kind']>(() => {
      const value = parameters.get('interfaceKind'); return value === 'lemma' || value === 'definition' ? value : '';
    });
  const interfaceToolbar = useRef<HTMLDivElement>(null), moduleSection = useRef<HTMLElement>(null);
  const source = useResource<Item<InstalledLibrarySource>>(sourceOpen && detail && detailUrl ? `${detailUrl}&view=source` : undefined);
  const entries = detail?.module.entries.filter(entry => (!kind || entry.kind === kind)
    && matchesInstalledLibraryInterface(entry, detail.module.import, query, detail.definitions[entry.name], detail.contexts?.[entry.name])) ?? [];
  useEffect(() => {
    if (!detail) return;
    const next = new URL(location.href);
    query ? next.searchParams.set('interfaceQuery', query) : next.searchParams.delete('interfaceQuery');
    kind ? next.searchParams.set('interfaceKind', kind) : next.searchParams.delete('interfaceKind');
    if (next.hash.startsWith('#declaration-') && !entries.some(entry => `#declaration-${enc(entry.name)}` === next.hash)) next.hash = '';
    history.replaceState(null, '', next);
  }, [query, kind, detail?.module.file]);
  useEffect(() => {
    const toolbar = interfaceToolbar.current, section = moduleSection.current, topbar = document.querySelector('.research-page .topbar');
    if (!toolbar || !section || !topbar) return;
    const measure = () => {
      const offset = Math.ceil(topbar.getBoundingClientRect().height) + 8;
      section.style.setProperty('--installed-interface-offset', `${offset}px`);
      section.style.setProperty('--installed-interface-scroll-margin', `${offset + Math.ceil(toolbar.getBoundingClientRect().height) + 12}px`);
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(topbar); observer.observe(toolbar);
    return () => observer.disconnect();
  }, [detail?.module.file]);
  useEffect(() => {
    if (detail && location.hash.startsWith('#declaration-')) {
      const name = location.hash.slice('#declaration-'.length), entry = detail.module.entries.find(item => enc(item.name) === name);
      if (entry) document.getElementById(`declaration-${entry.name}`)?.scrollIntoView();
    }
  }, [detail?.module.file]);
  return <section class="research-installed-detail" data-installed-library-detail={file} ref={moduleSection}>
    <nav class="research-breadcrumb" aria-label={tx('返回目录', 'Back to directory')}><a href={directoryHref(filters, file)}>← {tx('返回目录', 'Back to directory')}</a><span> · {tx('现有 Lean 库', 'Existing Lean library')}</span></nav>
    {!detailUrl && <ErrorBox message={tx('模块版本信息不完整，请返回目录重新选择。', 'The module version is missing. Return to the directory and select the module again.')} />}
    <ErrorBox message={result.error} />{result.error && <button class="button" type="button" onClick={result.refresh}>{tx('重新读取模块', 'Reload module')}</button>}
    {result.loading && <p class="research-status" role="status">{tx('正在读取模块接口…', 'Loading module interfaces…')}</p>}
    {detail && <><header class="research-installed-detail-heading"><div><h2>{moduleTitle(detail.module.name)}</h2><code>{detail.module.name}</code></div>
      {labels && <p class="research-installed-module-description">{tx(labels.zh.description, labels.en.description)}</p>}
      <p>{fieldLabel(detail.module.area)} · {detail.library.environment} · {detail.module.entries.length} {tx('个接口', 'interfaces')}</p>
      <details class="research-installed-module-import"><summary>{tx('导入模块', 'Import module')}</summary><div class="research-installed-detail-import"><pre class="research-block-code">{detail.module.import}</pre><CopyValue value={detail.module.import} name={detail.module.name} /></div></details>
    </header>
      <section class="research-installed-interfaces" aria-labelledby="installed-interface-heading"><div class="research-installed-interface-heading"><h2 id="installed-interface-heading">{tx('模块接口', 'Module interfaces')}</h2>
        <span role="status">{entries.length} / {detail.module.entries.length}</span></div>
        <div class="research-installed-interface-toolbar" ref={interfaceToolbar} data-installed-interface-toolbar><Field label={tx('搜索模块接口', 'Search module interfaces')} type="search" value={query} onInput={setQuery} placeholder={tx('数学含义、条件或 Lean 名称', 'Meaning, conditions or Lean name')} />
          <label>{tx('接口类型', 'Interface type')}<select value={kind} onChange={event => setKind(event.currentTarget.value as typeof kind)}>
            <option value="">{tx('全部接口', 'All')}</option><option value="lemma">{tx('引理', 'Lemma')}</option><option value="definition">{tx('定义', 'Definition')}</option></select></label>
          {Boolean(query || kind) && <button type="button" class="text-button research-installed-clear" onClick={() => {
            setQuery(''); setKind(''); interfaceToolbar.current?.querySelector('input')?.focus();
          }}>{tx('清除筛选', 'Clear filters')}</button>}</div>
        <div class="research-installed-declarations">{entries.map(entry => <Declaration key={entry.name} entry={entry} moduleImport={detail.module.import}
          definition={detail.definitions[entry.name]}
          sourceContext={detail.contexts?.[entry.name]}
          href={moduleHref(detail.module.file, detail.library.catalogDigest, filters, entry.name, { query, kind })}
          referenceHref={libraryReferenceHref(detail.module.file, detail.library.catalogDigest, entry.name, filters.get('workbenchChat'), filters.get('workbenchEdit'))} />)}</div>
        {!entries.length && <Empty>{detail.module.entries.length ? tx('没有匹配的接口，请调整名称或类型筛选。', 'No matching interfaces. Change the name or type filter.') : tx('此模块未列出可检索接口，可查看完整源码。', 'This module lists no searchable interfaces. View its full source below.')}</Empty>}
      </section>
      <Panel title={tx('源码与来源', 'Source and provenance')}>
        <details onToggle={event => setSourceOpen(event.currentTarget.open)}><summary>{tx('查看完整源码', 'View full source')}</summary>
          <div data-installed-library-source><ErrorBox message={source.error} />{source.error && <button class="button" type="button" onClick={source.refresh}>{tx('重新读取源码', 'Reload source')}</button>}
            {source.loading && <p class="research-status" role="status">{tx('正在读取源码…', 'Loading source…')}</p>}
            {source.data && <pre class="research-block-code">{source.data.item.source}</pre>}
          </div></details>
        {detail.module.imports.length > 0 && <details><summary>{tx('模块依赖', 'Module dependencies')} ({detail.module.imports.length})</summary><ul class="research-list">{detail.module.imports.map(dependency => <li key={dependency}>
          <a class="research-list-item" href={moduleHref(dependency, detail.library.catalogDigest, filters)}>{dependency}</a></li>)}</ul></details>}
        <details><summary>{tx('来源与固定版本', 'Source and pinned version')}</summary><LibraryIdentity library={detail.library} />
          <dl class="research-facts"><div><dt>{tx('模块文件', 'Module file')}</dt><dd>{detail.module.file}</dd></div><div><dt>{tx('源码摘要', 'Source digest')}</dt><dd>{detail.module.sha256}</dd></div>
            <div><dt>{tx('源码来源', 'Source origin')}</dt><dd>{detail.module.origin.kind === 'upstream' ? detail.module.origin.repository : `${tx('研究运行', 'Research run')} ${detail.module.origin.runId}`}</dd></div>
            <div><dt>{tx('来源提交', 'Source commit')}</dt><dd>{detail.module.origin.commit}</dd></div></dl>
        </details>
        <p class="research-field-note">{tx('模块已随当前环境提供，无需重新发布；具体题目的证明状态以独立验收结果为准。', 'This module is included in the current environment and needs no new publication. Each problem’s proof status comes from independent acceptance.')}</p>
      </Panel>
      <nav class="research-installed-detail-footer" aria-label={tx('模块浏览', 'Module navigation')}>
        <a href={directoryHref(filters, file)}>← {tx('返回库目录', 'Back to library')}</a>
        <button type="button" class="text-button" onClick={() => interfaceToolbar.current?.querySelector('input')?.focus()}>{tx('返回接口搜索', 'Back to interface search')} <span aria-hidden="true">↑</span></button>
      </nav>
    </>}
  </section>;
}

function CopyValue({ value, name, kind = 'import' }: { value: string; name: string; kind?: 'import' | 'name' | 'link' }) {
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [failed, setFailed] = useState(false);
  const labels = kind === 'import' ? {
    button: tx('复制 import', 'Copy import'), name: tx('复制导入语句：', 'Copy import: '),
    success: tx('导入语句已复制。', 'Import copied.'),
    failure: tx('复制失败，请选中导入语句手动复制。', 'Copy failed. Select the import statement and copy it manually.'),
  } : kind === 'name' ? {
    button: tx('复制 Lean 名称', 'Copy Lean name'), name: tx('复制 Lean 名称：', 'Copy Lean name: '),
    success: tx('Lean 名称已复制。', 'Lean name copied.'),
    failure: tx('复制失败，请选中完整 Lean 名称手动复制。', 'Copy failed. Select the full Lean name and copy it manually.'),
  } : {
    button: tx('复制固定链接', 'Copy permalink'), name: tx('复制接口固定链接：', 'Copy declaration permalink: '),
    success: tx('接口固定链接已复制。', 'Declaration permalink copied.'),
    failure: tx('复制失败，请从接口标题手动复制链接地址。', 'Copy failed. Copy the declaration title’s link address manually.'),
  };
  const copy = async () => {
    setBusy(true); setMessage('');
    try {
      await navigator.clipboard.writeText(value);
      setFailed(false); setMessage(labels.success);
    } catch {
      setFailed(true); setMessage(labels.failure);
    } finally { setBusy(false); }
  };
  return <div class="research-installed-copy"><button type="button" class="text-button" data-installed-library-copy={kind} aria-label={`${labels.name}${name}`} disabled={busy} onClick={() => void copy()}>{labels.button}</button>
    {message && <span role="status" data-copy-state={failed ? 'failed' : 'copied'}>{message}</span>}</div>;
}
function Declaration({ entry, moduleImport, href, referenceHref, definition, sourceContext }: { entry: InstalledLibraryEntry; moduleImport: string; href: string; referenceHref: string; definition?: InstalledLibraryDefinition; sourceContext?: InstalledLibraryDeclarationContext }) {
  const mathematics = installedLibraryMathematics(entry, moduleImport, definition, sourceContext), summary = tx(mathematics.summary.zh, mathematics.summary.en);
  const documentation = definition?.documentation || sourceContext?.documentation;
  const conditions = (items: typeof mathematics.conditions) => <ul class="research-installed-math-conditions">{items.map((condition, index) => <li key={index}>
    <span class="research-installed-math-condition-description">{tx(condition.label.zh, condition.label.en)} · {tx(condition.meaning.zh, condition.meaning.en)}</span>
    <span class="research-installed-math-expression">{condition.expression}</span></li>)}</ul>;
  return <article class="research-installed-declaration" id={`declaration-${entry.name}`} data-installed-library-declaration={entry.name} data-declaration-kind={entry.kind}>
    <div><h3><a href={href}><LeanName name={entry.name} /></a></h3><span>{entry.kind === 'lemma' ? tx('引理', 'Lemma') : tx('定义', 'Definition')}</span></div>
    <div class="research-installed-math" data-installed-library-mathematics>
      <div class="research-installed-math-summary"><RichProse text={summary} /></div>
      <dl class="research-installed-math-facts"><div><dt>{entry.kind === 'lemma' ? tx('数学结论', 'Conclusion') : tx('定义正文', 'Definition')}</dt><dd>
        <span class="research-installed-math-expression" data-installed-library-conclusion>{mathematics.expression}</span>
      </dd></div><div><dt>{tx('条件与参数', 'Conditions and inputs')}</dt><dd>
        {mathematics.conditions.length > 0 && conditions(mathematics.conditions)}
        <p class="research-field-note">{tx(mathematics.context.zh, mathematics.context.en)}</p>
      </dd></div>{mathematics.scopeConditions.length > 0 && <div><dt>{tx('模块作用域中的参数', 'Parameters in the module scope')}</dt><dd data-installed-library-scope>{conditions(mathematics.scopeConditions)}</dd></div>}</dl>
      {documentation && documentation !== summary && <div class="research-installed-definition-documentation" data-installed-library-author-documentation>
        <p class="research-field-note">{tx('作者说明', 'Author notes')}</p><RichProse text={documentation} /></div>}
    </div>
    <details class="research-installed-usage"><summary>{tx('最小 Lean 用法', 'Minimal Lean usage')}</summary><pre class="research-block-code" data-installed-library-usage>{mathematics.usage}</pre></details>
    {definition ? <details class="research-installed-signature research-installed-definition-source"><summary>{tx('原始定义与模块上下文', 'Original definition and module context')} · {tx(`第 ${definition.line} 行`, `Line ${definition.line}`)}</summary>
      <pre class="research-block-code" data-installed-definition-source>{[...definition.context, definition.source].join('\n\n')}</pre></details>
      : <details class="research-installed-signature"><summary>{tx('原始 Lean 类型与模块上下文', 'Original Lean type and module context')}</summary><pre class="research-block-code" data-installed-library-signature>{[...(sourceContext?.context ?? []), entry.type].join('\n\n')}</pre></details>}
    <div class="research-installed-declaration-actions"><a class="text-button" data-installed-library-reference={entry.name} href={referenceHref}
      aria-label={`${tx('在工作台引用：', 'Reference in workbench: ')}${entry.name}`}>{tx('在工作台引用', 'Reference in workbench')} →</a><CopyValue kind="name" value={entry.name} name={entry.name} />
      <CopyValue kind="link" value={new URL(href, location.href).href} name={entry.name} /></div>
  </article>;
}
function LibraryIdentity({ library }: { library: InstalledLibraryInfo }) {
  return <dl class="research-facts"><div><dt>{tx('库', 'Library')}</dt><dd>{library.id}</dd></div><div><dt>{tx('版本', 'Revision')}</dt><dd>{library.revision}</dd></div>
    <div><dt>{tx('目录摘要', 'Catalog digest')}</dt><dd>{library.catalogDigest}</dd></div><div><dt>{tx('证明环境', 'Proof environment')}</dt><dd>{library.environment} · {library.toolchain}</dd></div>
    <div><dt>{tx('环境摘要', 'Environment digest')}</dt><dd>{library.environmentDigest}</dd></div></dl>;
}
