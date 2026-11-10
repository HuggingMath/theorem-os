import { z } from 'zod';
import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { WebStorage, WebStorageError } from './storage';
import { webShareToken } from './shareTypes';
import type { SharedProofPreparation, SharedProofReading } from './sharedProofTypes';

const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u), hash = z.string().regex(/^[a-f0-9]{64}$/u);
const fail = (status: number, text: string): never => { throw new WebStorageError(status, text); };
const parse = <T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> => {
  const result = schema.safeParse(value); return result.success ? result.data : fail(400, '分享接续请求格式无效。');
};
type Reference = { id: string; token: string; digest: string };
type Preparation = { requestDigest: string; item: SharedProofPreparation };

/** A bookmark rechecks the revocable share. An explicitly prepared original problem is the recipient's own copy. */
export class WebSharedProofs {
  constructor(private readonly storage: WebStorage) {}
  private root(viewer: string) {
    if (!viewer || viewer === 'public') fail(401, '请先登录。');
    return ['owners', mathDigest(viewer), 'shared-proofs'];
  }
  registered(viewer: string, tokenDigest: string): Pick<SharedProofReading, 'id' | 'digest'> | undefined {
    parse(hash, tokenDigest);
    const root = this.root(viewer);
    for (const file of this.storage.listRecords([...root, 'references'])) {
      const reference = this.storage.getRecord<Reference>([...root, 'references', file]);
      if (reference && mathDigest(reference.token) === tokenDigest) {
        const reading = this.read(viewer, reference.id);
        return { id: reading.id, digest: reading.digest };
      }
    }
  }
  register(viewer: string, raw: unknown): SharedProofReading {
    const root = this.root(viewer), input = parse(z.object({ requestId: key, token: z.string().regex(webShareToken) }).strict(), raw);
    const saved = this.storage.getShare(input.token) ?? fail(404, '分享链接不存在或已停止分享。');
    const id = `shared_${mathDigest(`${viewer}\0${input.token}`).slice(0, 32)}`, digest = mathDigest(canonicalMathJson(saved.snapshot));
    const operationPath = [...root, 'requests', `${input.requestId}.json`], operation = this.storage.getRecord<{ digest: string; id: string }>(operationPath);
    const requestDigest = mathDigest(canonicalMathJson(input));
    if (operation && operation.digest !== requestDigest) fail(409, '请求 ID 已用于另一项分享接续操作。');
    this.storage.saveRecord([...root, 'references', `${id}.json`], { id, token: input.token, digest } satisfies Reference);
    if (!operation) this.storage.saveRecord(operationPath, { digest: requestDigest, id });
    return this.read(viewer, id);
  }
  read(viewer: string, id: string): SharedProofReading {
    parse(key, id);
    const reference = this.storage.getRecord<Reference>([...this.root(viewer), 'references', `${id}.json`]) ?? fail(404, '收藏的分享不可访问。');
    const current = this.storage.getShare(reference.token) ?? fail(404, '分享链接不存在或已停止分享。');
    if (mathDigest(canonicalMathJson(current.snapshot)) !== reference.digest) fail(409, '分享内容已变化，请重新打开分享后再操作。');
    return { id, digest: reference.digest, share: structuredClone(current.snapshot) };
  }
  prepare(viewer: string, id: string, raw: unknown): SharedProofPreparation {
    parse(key, id);
    const input = parse(z.object({ requestId: key, expectedDigest: hash, confirmed: z.literal(true) }).strict(), raw);
    const draftId = `shared_draft_${mathDigest(`${viewer}\0${input.requestId}`).slice(0, 32)}`;
    const requestDigest = mathDigest(canonicalMathJson({ id, input })), file = [...this.root(viewer), 'preparations', `${draftId}.json`];
    const existing = this.storage.getRecord<Preparation>(file);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail(409, '请求 ID 已用于另一项分享接续操作。');
      return structuredClone(existing.item);
    }
    const reading = this.read(viewer, id);
    if (reading.digest !== input.expectedDigest) fail(409, '分享内容已变化，请重新打开分享后再操作。');
    const share = reading.share;
    const item: SharedProofPreparation = { id: draftId, title: share.title, source: share.source, task: share.task,
      environment: share.environment, preparedAt: new Date().toISOString(), origin: { kind: 'shared-proof', readingId: id,
        title: share.title, sharedAt: share.sharedAt, digest: reading.digest, sourceDigest: mathDigest(share.source),
        proofDigest: mathDigest(share.proof), href: `share.html?${new URLSearchParams({ reading: id })}` } };
    this.storage.saveRecord(file, { requestDigest, item } satisfies Preparation);
    return structuredClone(item);
  }
  prepared(viewer: string, id: string): SharedProofPreparation {
    parse(key, id);
    const saved = this.storage.getRecord<Preparation>([...this.root(viewer), 'preparations', `${id}.json`]) ?? fail(404, '分享研究草稿不存在或不属于你。');
    return structuredClone(saved.item);
  }
}
