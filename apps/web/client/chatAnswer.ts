import type { WebExplanation, WebExplanationDocument, WebExplanationLanguage, WebExplanationOverview, WebExplanationSection, WebRun } from '../shared';
import { isAcceptedRun, isStatementReviewed } from '../presentation';
import { t } from '../i18n';

export type ChatAnswer = { runId: string; target: string; loading: boolean; overview?: WebExplanationOverview;
  explanation?: WebExplanation; document?: WebExplanationDocument; error?: string; targetTitles?: Record<string, string> };
type Entry = { proof: string; value: ChatAnswer; revision: number; documentVersion?: string };
type Request = <T>(url: string) => Promise<T>;

export function explanationStepQuestion(section: WebExplanationSection, index: number, source: string, language: WebExplanationLanguage): string {
  const step = section.steps[index];
  if (!step) return '';
  const tx = (zh: string, en: string) => language === 'zh' ? zh : en;
  return [tx('请解释以下证明步骤，并说明所用引理的适用条件。', 'Explain this proof step and the conditions required by its lemmas.'),
    `${section.title || section.name} · ${tx(`第 ${index + 1} 步`, `Step ${index + 1}`)}`,
    section.statement, step.text,
    ...(step.uses.length ? [`${tx('用到', 'Uses')}: ${step.uses.map(use => use.name).join(', ')}`] : []),
    `${tx('讲解来源', 'Explanation source')}: ${source}`].filter(Boolean).join('\n\n');
}

/** Reads existing verified explanations only. Generation stays an explicit action on the explanation page. */
export class ChatAnswers {
  private entries = new Map<string, Entry>();
  constructor(private readonly request: Request, private readonly language: WebExplanationLanguage, private readonly changed: () => void) {}
  clear() { this.entries.clear(); }
  generating(runId?: string): boolean {
    const status = runId ? this.entries.get(runId)?.value.explanation?.status : undefined;
    return status === 'queued' || status === 'running';
  }
  sync(run?: WebRun): ChatAnswer | undefined {
    if (!run || !isAcceptedRun(run) || !isStatementReviewed(run) || !run.result?.proof) return;
    let entry = this.entries.get(run.id);
    if (!entry || entry.proof !== run.result.proof) {
      const targetTitles = Object.fromEntries((run.observation?.inspection.tasks ?? [])
        .filter(task => task.theorem && task.informalStatement).map(task => [task.theorem!, task.informalStatement!]));
      entry = { proof: run.result.proof, value: { runId: run.id, target: '', loading: true, targetTitles }, revision: 0 };
      this.entries.set(run.id, entry);
      void this.load(entry, true);
    }
    return entry.value;
  }
  refresh(run?: WebRun) {
    const value = this.sync(run), entry = value && this.entries.get(value.runId);
    if (entry && !entry.value.loading) void this.load(entry, true);
  }
  select(runId: string, target: string) {
    const entry = this.entries.get(runId);
    if (!entry?.value.overview?.targets.some(item => item.name === target) || entry.value.target === target) return;
    entry.value.target = target; entry.value.explanation = undefined; entry.value.document = undefined; entry.documentVersion = undefined;
    void this.load(entry, false);
  }
  private async load(entry: Entry, readOverview: boolean) {
    const revision = ++entry.revision, state = entry.value, base = `/api/runs/${encodeURIComponent(state.runId)}/explanations`;
    const current = () => this.entries.get(state.runId) === entry && entry.revision === revision;
    const discard = () => { state.document = undefined; entry.documentVersion = undefined; };
    state.loading = true; state.error = undefined; this.changed();
    try {
      if (readOverview) {
        const overview = await this.request<WebExplanationOverview>(base);
        if (!current()) return;
        if (overview.run.id !== state.runId || overview.run.proof !== entry.proof) { discard(); throw new Error(t('讲解与当前验收证明不一致。')); }
        state.overview = overview;
        if (!overview.targets.some(item => item.name === state.target)) {
          discard(); state.target = overview.explanations
            .find(item => item.status === 'approved' && item.language === this.language && overview.targets.some(target => target.name === item.target))?.target
            ?? overview.targets[0]?.name ?? '';
        }
      }
      const item = state.overview?.explanations.find(item => item.target === state.target && item.language === this.language);
      state.explanation = item;
      if (item?.status !== 'approved') { state.document = undefined; entry.documentVersion = undefined; return; }
      const version = `${item.id}:${item.updatedAt}`;
      if (entry.documentVersion === version && state.document) return;
      const { explanation } = await this.request<{ explanation: WebExplanation }>(`${base}/item?${new URLSearchParams({ target: state.target, language: this.language })}`);
      if (!current()) return;
      if (explanation.runId !== state.runId || explanation.status !== 'approved' || explanation.id !== item.id
        || explanation.target !== state.target || explanation.language !== this.language
        || explanation.document?.target !== state.target || explanation.document.language !== this.language) {
        discard(); throw new Error(t('这份讲解尚不可用，请重新读取。'));
      }
      state.document = explanation.document; entry.documentVersion = version;
      for (const section of explanation.document.sections) if (section.target && section.title)
        (state.targetTitles ??= {})[section.name] = section.title;
    } catch (error) {
      if (current()) state.error = error instanceof Error ? error.message : String(error);
    } finally {
      if (current()) { state.loading = false; this.changed(); }
    }
  }
}
