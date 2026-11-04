import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { canonicalMathJson, mathDigest, syncMathDirectory } from '../../src/math/mathRuntimeIo';
import { buildTheoremKnowledge, searchTheoremKnowledgeRequests, searchKnowledgeRouteFindings,
  getKnowledgeConsumers, getKnowledgeRouteFindingPage, theoremKnowledgeStats, validateTheoremKnowledge,
  type KnowledgeCandidate, type KnowledgeRouteFindingCandidate, type TheoremKnowledgeBase } from '../../src/solver/theoremKnowledge';
import { getKnowledgeMetadata, type KnowledgeMetadataField } from '../../src/solver/theoremKnowledgeMetadata';
import { getKnowledgeSource } from '../../src/solver/theoremKnowledgeSource';
import { getKnowledgeDependencies } from '../../src/solver/theoremKnowledgeDependencies';
import { readKnowledgeCatalog, writePackedKnowledge } from '../../src/solver/theoremKnowledgeStore';
import { WebStorage, WebStorageError } from './storage';

export type WebCatalogInfo = ReturnType<typeof theoremKnowledgeStats> & { digest: string; createdAt: string };
type StoredCatalogInfo = WebCatalogInfo & { manifestDigest?: string };
export type WebKnowledgeSearchOptions = {
  query: string; goal?: string; catalogDigest?: string; limit?: number;
  problemId?: string; environmentDigest?: string; problemReceiptDigest?: string;
};
export type WebKnowledgeDetailOptions = {
  catalogDigest?: string; view?: 'metadata' | 'source' | 'dependencies' | 'consumers' | 'finding';
  field?: KnowledgeMetadataField; file?: string; name?: string; startOffset?: number; startLine?: number;
  lines?: number; maxBytes?: number; offset?: number; limit?: number; depth?: number; maxNodes?: number; maxReferences?: number;
};
const hash = /^[a-f0-9]{64}$/u;
const ownerPath = (owner: string) => ['owners', mathDigest(owner)];
const catalogDigest = (base: TheoremKnowledgeBase) => mathDigest(canonicalMathJson(base) + '\n');

/** Published catalogs retain all exact contexts and provenance while new imports create another immutable identity. */
export class WebKnowledgeService {
  constructor(private readonly storage: WebStorage) {}

  listCatalogs(owner: string): WebCatalogInfo[] {
    return this.catalogRecords(owner).map(({ manifestDigest: _manifestDigest, ...info }) => info);
  }
  latestReusableCatalog(owner: string): WebCatalogInfo | undefined {
    return this.listCatalogs(owner).findLast(info => info.entries > 0 || info.routeFindings > 0);
  }
  private catalogRecords(owner: string): StoredCatalogInfo[] {
    return this.storage.getRecord<StoredCatalogInfo[]>([...ownerPath(owner), 'catalogs.json']) ?? [];
  }
  private read(owner: string, digest?: string) {
    const records = this.catalogRecords(owner);
    const info = digest === undefined ? records.at(-1) : hash.test(digest) ? records.find(item => item.digest === digest) : undefined;
    if (!info) return undefined;
    const directory = this.storage.ownerDirectory(owner);
    if (!directory) {
      const base = this.storage.getRecord<TheoremKnowledgeBase>([...ownerPath(owner), 'catalogs', info.digest, 'base.json']);
      if (!base) throw new Error('web_knowledge_catalog_missing');
      return { info, base: validateTheoremKnowledge(base) };
    }
    return { info, base: readKnowledgeCatalog(path.join(directory, 'catalogs', info.digest, 'catalog.json'), info.manifestDigest).base };
  }
  getCatalog(owner: string, digest?: string): TheoremKnowledgeBase | undefined {
    const catalog = this.read(owner, digest);
    if (!catalog) return undefined;
    // This v1 digest is reproducible by a worker receiving only the catalog JSON, independent of host paths.
    if (catalogDigest(catalog.base) !== catalog.info.digest) throw new Error('math_knowledge_identity_changed');
    return catalog.base;
  }

  importCatalog(owner: string, value: unknown): WebCatalogInfo {
    const incoming = validateTheoremKnowledge(value), previous = this.read(owner)?.base;
    const candidates: KnowledgeCandidate[] = incoming.entries.flatMap(entry => {
      const { id: _id, contextDigest, environmentDigest: _environmentDigest, declaration: _declaration, provenance, ...theorem } = entry;
      const files = Object.fromEntries(Object.entries(incoming.contexts[contextDigest]!)
        .map(([file, digest]) => [file, incoming.sources[digest]!]));
      return provenance.map(origin => ({ ...theorem, files, provenance: origin }));
    });
    const findings: KnowledgeRouteFindingCandidate[] = (incoming.routeFindings ?? []).flatMap(entry => {
      const { id: _id, scopeDigest: _scopeDigest, provenance, ...finding } = entry;
      return provenance.map(origin => ({ ...finding, provenance: origin }));
    });
    const base = buildTheoremKnowledge(candidates, previous, findings), digest = catalogDigest(base);
    const records = this.catalogRecords(owner), existing = records.find(item => item.digest === digest);
    if (existing) { const { manifestDigest: _manifestDigest, ...info } = existing; return info; }
    const info: StoredCatalogInfo = { digest, createdAt: new Date().toISOString(), ...theoremKnowledgeStats(base) };
    const directory = this.storage.ownerDirectory(owner);
    if (directory) {
      const parent = path.join(directory, 'catalogs'), destination = path.join(parent, digest);
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (!fs.existsSync(destination)) {
        const temporary = path.join(parent, `publish-${crypto.randomUUID()}`);
        fs.mkdirSync(temporary, { mode: 0o700 });
        try {
          writePackedKnowledge(path.join(temporary, 'catalog.json'), base, digest);
          fs.renameSync(temporary, destination); syncMathDirectory(parent);
        } catch (error) { fs.rmSync(temporary, { recursive: true, force: true }); throw error; }
      }
      info.manifestDigest = readKnowledgeCatalog(path.join(destination, 'catalog.json')).digest;
      if (catalogDigest(readKnowledgeCatalog(path.join(destination, 'catalog.json'), info.manifestDigest).base) !== digest)
        throw new Error('math_knowledge_identity_changed');
    } else this.storage.saveRecord([...ownerPath(owner), 'catalogs', digest, 'base.json'], base, true);
    this.storage.saveRecord([...ownerPath(owner), 'catalogs.json'], [...records, info]);
    const { manifestDigest: _manifestDigest, ...publicInfo } = info;
    return publicInfo;
  }

  search(owner: string, options: WebKnowledgeSearchOptions) {
    const catalog = this.read(owner, options.catalogDigest);
    if (!catalog && options.catalogDigest) throw new WebStorageError(404, '知识版本不存在或不属于当前会话。');
    const base = catalog?.base ?? buildTheoremKnowledge([]);
    const { query, goal, limit, problemId, environmentDigest, problemReceiptDigest } = options;
    return { catalogDigest: catalog?.info.digest ?? null,
      results: searchTheoremKnowledgeRequests(base, [{ query, ...(goal ? { goal } : {}) }],
        { limit, problemId, environmentDigest, problemReceiptDigest })[0]!,
      findings: searchKnowledgeRouteFindings(base, query, { goal, limit, problemId, environmentDigest, problemReceiptDigest }) };
  }

  detail(owner: string, id: string, options: WebKnowledgeDetailOptions = {}) {
    const catalog = this.read(owner, options.catalogDigest);
    if (!catalog) throw new WebStorageError(404, '知识版本不存在或不属于当前会话。');
    const { base, info } = catalog, { view, maxBytes, startOffset } = options;
    if (base.routeFindings?.some(item => item.id === id)) {
      if (view && view !== 'finding') throw new WebStorageError(400, '研究记录仅支持 finding 分页。');
      return { catalogDigest: info.digest, entry: { kind: 'finding' as const,
        finding: getKnowledgeRouteFindingPage(base, id, { maxBytes, startOffset }) } };
    }
    if (!base.entries.some(item => item.id === id)) throw new WebStorageError(404, '知识条目不存在。');
    const metadata = () => getKnowledgeMetadata(base, id, { field: options.field, maxBytes, startOffset });
    const source = () => getKnowledgeSource(base, id, { file: options.file, name: options.name,
      startOffset, startLine: options.startLine, lines: options.lines, maxBytes });
    const dependencies = () => getKnowledgeDependencies(base, id,
      { depth: options.depth, maxNodes: options.maxNodes, maxReferences: options.maxReferences });
    const consumers = () => getKnowledgeConsumers(base, id, { offset: options.offset, limit: options.limit, maxBytes });
    const identity = { kind: 'theorem' as const };
    const entry = view === 'metadata' ? { ...identity, metadata: metadata() } :
      view === 'source' ? { ...identity, source: source() } :
      view === 'dependencies' ? { ...identity, dependencies: dependencies() } :
      view === 'consumers' ? { ...identity, consumers: consumers() } :
      view === undefined ? { ...identity, metadata: metadata(), source: source(), dependencies: dependencies(), consumers: consumers() } :
      undefined;
    if (!entry) throw new WebStorageError(400, '知识读取方式无效。');
    return { catalogDigest: info.digest, entry };
  }
}
