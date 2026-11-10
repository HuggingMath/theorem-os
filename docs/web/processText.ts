import type { Locale } from './site';

/** Keep prose readable while leaving encoded candidates in the downloadable archive. */
export function readableProcessText(value: string, limit = 1000): string {
  const kept: string[] = [];
  for (const line of value.replace(/\r\n?/gu, '\n').split('\n')) {
    if (/^\s*(?:```|(?:\/usr\/bin\/)?python3?\b|from pathlib import|import (?:base64|Mathlib)|Reconstruct (?:from|with)|.*PAYLOAD_BEGIN|.*<<['"]?\w)/iu.test(line)
      || /\S{240}/u.test(line)) break;
    kept.push(line);
  }
  const text = kept.join('\n').trim();
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

export function processMessage(value: string, locale: Locale): string {
  const prose = readableProcessText(value, Number.MAX_SAFE_INTEGER);
  if (locale === 'en') return prose;
  const messages: Record<string, string> = {
    'Delivery belongs to a superseded assignment.': '这份交付对应的任务版本已被后续版本替代。',
    'Existing canonical helper checked against this exact task before starting a model.': '复用已有引理，并针对当前任务重新检查。',
    'Fixed declaration checked; unresolved lemma assumptions remain obligations.': '目标声明已通过检查，其中尚未解决的引理条件仍需完成。',
    'Supporting code saved at a context checkpoint. Inspect the retained commit and exact declarations before adopting typed work; the assigned proof remains unfinished.': '已保存辅助代码和当前进度，分配的证明任务尚未完成。',
  };
  if (messages[prose]) return messages[prose];
  if (prose.startsWith('math_research_checkpoint_unchanged:')) return '多次恢复后，保存的研究笔记、草稿和任务输入没有更新，本次尝试停止。';
  return prose;
}
