import type { ArchiveIndex } from '../../../docs/web/types';
import { webLimits } from '../shared';

export type ClassicOrigin = { id: string; title: string; sourceSha256: string };
export type ClassicPreparation = { origin: ClassicOrigin; source: string; task: string; summary: string };

export function readClassicId(parameters: URLSearchParams): string | undefined {
  const id = parameters.get('fromClassic');
  return id && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(id) ? id : undefined;
}

/** Only the bundled original challenge is copied; an accepted solution is never used as the new problem. */
export async function loadClassicPreparation(id: string, language: 'zh' | 'en', request: typeof fetch = fetch): Promise<ClassicPreparation> {
  const tx = (zh: string, en: string) => language === 'en' ? en : zh;
  if (readClassicId(new URLSearchParams({ fromClassic: id })) !== id) throw new Error(tx('来源题目无效。', 'Invalid source problem.'));
  const response = await request('classics/data/index.json');
  if (!response.ok) throw new Error(tx('暂时无法读取经典题库，请重试。', 'The classic library is unavailable. Try again.'));
  const index = await response.json() as ArchiveIndex;
  const record = index.records.find(item => item.id === id);
  const challenge = record?.sources.find(item => item.name === 'Challenge.lean');
  if (!record || !challenge) throw new Error(tx('未找到这道题的原始题目。可以返回来源查看。', 'The original problem was not found. You can return to the source.'));
  const original = await request(`classics/data/proofs/${encodeURIComponent(id)}/Challenge.lean`);
  if (!original.ok) throw new Error(tx('暂时无法读取原题，请重试。', 'The original problem is unavailable. Try again.'));
  const source = await original.text(), bytes = new TextEncoder().encode(source);
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('');
  if (hash !== challenge.sha256) throw new Error(tx('原题内容与题库记录不一致，请刷新后重试。', 'The original problem differs from the library record. Refresh and try again.'));
  if (!source.trim() || bytes.length > webLimits.maxSourceBytes) throw new Error(tx('原题超出当前编辑器的大小限制，请返回来源查看。', 'The original problem exceeds the editor size limit. Return to the source to read it.'));
  const summary = language === 'en' ? record.en?.summary ?? record.summary : record.summary;
  const task = `${record.title}\n\n${summary}\n\n${tx('证明原题中的目标声明，保留原有定义、假设和结论。', 'Prove the target declarations in the original problem, preserving its definitions, assumptions and conclusions.')}\n${record.campaign?.targets.join('\n') ?? record.declaration ?? ''}`;
  if (new TextEncoder().encode(task).length > 8000) throw new Error(tx('题目说明超出当前编辑器的大小限制。', 'The problem description exceeds the editor size limit.'));
  return { origin: { id, title: record.title, sourceSha256: hash }, source, task, summary };
}
