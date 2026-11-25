import crypto from 'node:crypto';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { paperTemplate, type PaperLanguage } from '../../src/math/paperDraft';
import { generatePaperDraft, type PaperSource } from '../../src/solver/paperDraft';
import { askProvider, WebExplainError, type WebExplainCall } from './explain';
import { paperDraftActive, type WebPaperDraftJob } from './paperTypes';
import type { WebRun } from './shared';
import { WebStorage, WebStorageError } from './storage';

export class WebPaperDrafts {
  private readonly active = new Map<string, { id: string; runId: string; controller: AbortController; done: Promise<void> }>();

  constructor(private readonly storage: WebStorage) {
    this.storage.interruptPaperDrafts();
  }

  counts() { return { running: this.active.size, queued: 0 }; }

  isGenerating(owner: string, runId: string) { return this.active.get(owner)?.runId === runId; }

  private key(target: string, language: PaperLanguage) { return mathDigest(JSON.stringify([target, language])); }

  get(owner: string, run: WebRun, target: string, language: PaperLanguage): WebPaperDraftJob | undefined {
    const job = this.storage.getPaperDraft(owner, run.id, this.key(target, language));
    if (!job || !run.result?.proof || job.leanSha256 !== mathDigest(run.result.proof)) return;
    if (!paperDraftActive(job.status) || this.active.get(owner)?.id === job.id) return job;
    return { ...job, status: 'error', error: 'interrupted' };
  }

  start(owner: string, run: WebRun, source: PaperSource,
    { providerId, baseUrl, apiKey, model, effort }: { providerId: string } & Pick<WebExplainCall, 'baseUrl' | 'apiKey' | 'model' | 'effort'>) {
    const running = this.active.get(owner);
    if (running) {
      const previous = this.get(owner, run, source.target, source.language);
      if (previous?.id === running.id) return previous;
      throw new WebStorageError(429, '已有论文初稿正在生成。');
    }
    const { target, language, proof } = source, key = this.key(target, language);
    const previous = this.get(owner, run, target, language);
    const job: WebPaperDraftJob = { id: crypto.randomUUID(), runId: run.id, target, language, leanSha256: mathDigest(proof),
      templateVersion: paperTemplate.version, createdAt: new Date().toISOString(), status: 'writing', providerId, model,
      ...(previous?.draft ? { draft: previous.draft } : {}) };
    const controller = new AbortController();
    this.storage.savePaperDraft(owner, run.id, key, job);
    const save = (state: Partial<WebPaperDraftJob>) => {
      const current = this.storage.getRun(owner, run.id);
      if (!current?.result?.proof || mathDigest(current.result.proof) !== job.leanSha256) {
        controller.abort();
        return;
      }
      Object.assign(job, state);
      this.storage.savePaperDraft(owner, run.id, key, job);
    };
    const done = generatePaperDraft(source, async (instructions, material) => {
      controller.signal.throwIfAborted();
      const answer = await askProvider({ baseUrl, apiKey, model, instructions, effort, timeoutMs: 300_000, maxAnswer: 64_000,
        input: [{ role: 'user', content: JSON.stringify(material) }] }, controller.signal);
      if (answer.truncated) throw new Error('paper_draft_incomplete_response');
      return answer.answer;
    }, (status, draft) => save({ status, ...(draft ? { draft } : {}) }))
      .then(draft => save({ status: 'done', draft }), error => save({ status: 'error', error: controller.signal.aborted ? 'interrupted'
        : error instanceof WebExplainError ? error.message : error instanceof Error && error.message === 'paper_draft_invalid_structure' ? 'invalid_structure' : 'generation_failed' }))
      .catch(() => { /* A storage outage leaves the last durable checkpoint available for a retry. */ })
      .finally(() => this.active.delete(owner));
    this.active.set(owner, { id: job.id, runId: run.id, done, controller });
    return job;
  }

  async close() {
    const pending = [...this.active.values()];
    for (const work of pending) work.controller.abort();
    await Promise.all(pending.map(work => work.done));
  }
}
