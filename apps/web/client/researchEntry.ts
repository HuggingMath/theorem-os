import type { WebTemplate } from '../shared';

export type ResearchEntry = {
  kind: 'statement' | 'lean';
  template: 'add-zero' | 'polynomial';
  environment: 'standard' | 'mathlib';
  language: 'zh' | 'en';
};
export type ResearchEntryDraft = ResearchEntry & { source: string; task: string; statement: string };

/** Public links name a bundled example; a URL never supplies private problem text or executable source. */
export function readResearchEntry(search: string | URLSearchParams): ResearchEntry | undefined {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const kind = params.get('entry'), language = params.get('lang') ?? 'zh';
  if ((kind !== 'statement' && kind !== 'lean') || (language !== 'zh' && language !== 'en')) return;
  const template = kind === 'statement' ? 'add-zero' : 'polynomial';
  const environment = kind === 'statement' ? 'standard' : 'mathlib';
  if (params.has('template') && params.get('template') !== template) return;
  if (params.has('environment') && params.get('environment') !== environment) return;
  return { kind, template, environment, language };
}

export function researchEntryQuery(entry: ResearchEntry): string {
  return `?${new URLSearchParams({ entry: entry.kind, template: entry.template, environment: entry.environment, lang: entry.language })}`;
}

/** Resolve against this deployment's templates. Preparing a draft neither submits it nor changes model settings. */
export function resolveResearchEntry(entry: ResearchEntry, templates: readonly WebTemplate[]): ResearchEntryDraft | undefined {
  const fixed = readResearchEntry(researchEntryQuery(entry));
  if (!fixed) return;
  const template = templates.find(item => item.id === fixed.template && item.environment === fixed.environment);
  if (!template) return;
  const tx = (zh: string, en: string) => fixed.language === 'en' ? en : zh;
  const statement = fixed.kind === 'statement'
    ? tx('对任意自然数 n，证明 n + 0 = n。', 'For every natural number n, prove that n + 0 = n.')
    : tx('对任意实数 x、y，证明 (x + y)^2 = x^2 + 2*x*y + y^2。', 'For real numbers x and y, prove (x + y)^2 = x^2 + 2*x*y + y^2.');
  return { ...fixed, source: template.source, task: template.task, statement };
}

export function consumeResearchEntry(search: string | URLSearchParams, templates: readonly WebTemplate[], handlers: {
  statement(draft: ResearchEntryDraft): void; lean(draft: ResearchEntryDraft): void;
}): boolean {
  const entry = readResearchEntry(search), draft = entry && resolveResearchEntry(entry, templates);
  if (!draft) return false;
  handlers[draft.kind](draft);
  return true;
}
