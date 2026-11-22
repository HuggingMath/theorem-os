import { describe, expect, it, vi } from 'vitest';
import { ChatAnswers, explanationStepQuestion } from '../apps/web/client/chatAnswer';
import type { WebExplanation, WebExplanationDocument, WebExplanationLanguage, WebExplanationOverview, WebRun } from '../apps/web/shared';

const at = '2026-11-10T07:00:00.000Z';
const run = (changes: Partial<WebRun> = {}): WebRun => ({ id: 'accepted-run', title: 'Recorded accepted proof',
  status: 'completed', phase: 'finished', createdAt: at, updatedAt: at, providerId: 'offline', model: 'fixture', effort: 'high',
  environment: 'standard', source: 'theorem first : True := by sorry', task: 'Read existing evidence only',
  maxTurns: 0, maxRunSeconds: 0, maxTotalTokens: 0, workers: 1, coordination: 'cooperative', events: [],
  result: { status: 'evaluated_passed', proof: 'theorem first : True := True.intro', report: {} }, ...changes });
function document(target: string, text = target): WebExplanationDocument {
  return { schema: 'theorem-os.web-explanation.v1', target, language: 'zh', toolchain: 'synthetic', mathlibRevision: null,
    overview: `Overview ${text}`, axioms: [], sections: [], model: 'fixture', effort: 'high', auditors: 2, rounds: 1, tokens: null,
    metrics: { declarations: 1, steps: 0, citations: 0, excerptCoverage: 1, proofLines: 1, explainedLines: 1, ambiguousExcerpts: 0 } };
}
function explanation(target: string, overrides: Partial<WebExplanation> = {}): WebExplanation {
  return { id: `explanation-${target}`, runId: 'accepted-run', target, language: 'zh', status: 'approved', createdAt: at, updatedAt: at,
    model: 'fixture', effort: 'high', maxRunSeconds: 0, maxTotalTokens: 0, document: document(target), ...overrides };
}
function overview(value = run(), entries = [explanation('first'), explanation('second')]): WebExplanationOverview {
  return { run: { id: value.id, title: value.title, environment: 'standard', providerId: value.providerId, model: value.model,
    effort: value.effort, proof: value.result!.proof }, targets: [{ name: 'first', declarations: 1 }, { name: 'second', declarations: 1 }],
    explanations: entries.map(({ document: _, ...entry }) => entry), generation: { available: false, reason: 'runtime' } };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));
function fixture(read: (url: string) => unknown | Promise<unknown>, language: WebExplanationLanguage = 'zh') {
  const request = vi.fn(async <T>(url: string): Promise<T> => await read(url) as T), changed = vi.fn();
  return { answers: new ChatAnswers(request, language, changed), request, changed };
}

describe('chat reads existing approved explanations without model or generation requests', () => {
  it('only reads when the whole run is accepted and has its accepted proof', () => {
    const { answers, request } = fixture(() => { throw new Error('No request is allowed'); });
    for (const value of [undefined, run({ status: 'running' }), run({ status: 'cancelled' }), run({ status: 'error' }),
      run({ result: { status: 'incomplete', proof: 'an unchecked candidate', report: {} } }),
      run({ result: { status: 'evaluated_failed', proof: 'rejected proof', report: {} } }),
      run({ result: { status: 'evaluated_passed', proof: '', report: {} } })]) {
      expect(answers.sync(value)).toBeUndefined(); answers.refresh(value);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'interrupted', 'superseded'] as const)('keeps %s candidates usable as Lean proofs without reading an original-problem explanation', async confirmation => {
    const { answers, request } = fixture(() => { throw new Error('No original-problem explanation request is allowed'); });
    const candidate = run({ formalization: { id: 'formalization', original: 'Original problem', candidateDigest: 'a'.repeat(64), confirmation } });
    expect(answers.sync(candidate)).toBeUndefined(); answers.refresh(candidate); await settle();
    expect(request).not.toHaveBeenCalled();
  });

  it('shows waiting-review progress without reading a document before the original problem is reviewed', async () => {
    const saved = explanation('first', { status: 'queued', progress: { phase: 'waiting_review', updatedAt: at } });
    const { answers, request } = fixture(() => overview(run(), [saved]));
    const candidate = run({ formalization: { id: 'formalization', original: 'Original problem', candidateDigest: 'a'.repeat(64), confirmation: 'pending' } });
    const answer = answers.sync(candidate)!; await settle();
    expect(answer.explanation?.progress?.phase).toBe('waiting_review');
    expect(answer.document).toBeUndefined(); expect(answers.generating(candidate.id)).toBe(true);
    expect(request.mock.calls).toEqual([['/api/runs/accepted-run/explanations']]);
  });

  it('does not read an approved document until background review binds its approval to the same accepted proof', async () => {
    const { answers, request } = fixture(url => url.endsWith('/explanations') ? overview() : { explanation: explanation('first') });
    const candidate = run({ formalization: { id: 'formalization', original: 'Original problem', candidateDigest: 'a'.repeat(64), confirmation: 'pending' } });
    const pending = answers.sync(candidate)!; await settle(); expect(pending.document).toBeUndefined();
    expect(request.mock.calls).toEqual([['/api/runs/accepted-run/explanations']]);
    const reviewed = run({ formalization: { ...candidate.formalization!, confirmation: 'automatic', evidenceSha256: 'b'.repeat(64), confirmedAt: at } });
    const answer = answers.sync(reviewed)!; await settle();
    expect(answer.document).toEqual(document('first'));
    expect(request.mock.calls).toEqual([['/api/runs/accepted-run/explanations'], ['/api/runs/accepted-run/explanations'],
      ['/api/runs/accepted-run/explanations/item?target=first&language=zh']]);
  });

  it('prefers an approved target in the current language and only reads its saved document', async () => {
    const entries = [explanation('first', { language: 'en' }), explanation('second')];
    const { answers, request } = fixture(url => url.endsWith('/explanations') ? overview(run(), entries) : { explanation: explanation('second') });
    const value = answers.sync(run())!; expect(value.loading).toBe(true); await settle();
    expect(value).toMatchObject({ target: 'second', loading: false, document: document('second') });
    expect(request.mock.calls).toEqual([['/api/runs/accepted-run/explanations'],
      ['/api/runs/accepted-run/explanations/item?target=second&language=zh']]);
    answers.sync(run()); answers.select('accepted-run', 'missing'); answers.select('accepted-run', 'second');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reads an existing automatic explanation in another language and switches to the interface language when available', async () => {
    const english = explanation('first', { id: 'english', language: 'en', document: { ...document('first'), language: 'en' } });
    let entries = [explanation('first')];
    const { answers, request } = fixture(url => url.endsWith('/explanations') ? overview(run(), entries)
      : { explanation: url.endsWith('language=en') ? english : entries[0] }, 'en');
    const value = answers.sync(run())!; await settle();
    expect(value.document?.language).toBe('zh'); expect(request.mock.calls.at(-1)?.[0]).toContain('language=zh');
    entries = [...entries, english]; answers.refresh(run()); await settle();
    expect(value.document?.language).toBe('en'); expect(request.mock.calls.at(-1)?.[0]).toContain('language=en');
  });

  it('drops a fallback-language document when reading the newly selected language fails', async () => {
    let englishAvailable = false;
    const { answers } = fixture(url => {
      if (url.endsWith('/explanations')) return overview(run(), [explanation('first'), ...(englishAvailable
        ? [explanation('first', { id: 'english', language: 'en' })] : [])]);
      if (url.endsWith('language=en')) throw new Error('English document is temporarily unavailable');
      return { explanation: explanation('first') };
    }, 'en');
    const value = answers.sync(run())!; await settle(); expect(value.document?.language).toBe('zh');
    englishAvailable = true; answers.refresh(run()); await settle();
    expect(value.document).toBeUndefined(); expect(value.explanation?.language).toBe('en'); expect(value.error).toBeTruthy();
  });

  it('validates the language of a fallback document against its saved record', async () => {
    const { answers } = fixture(url => url.endsWith('/explanations') ? overview(run(), [explanation('first')])
      : { explanation: explanation('first', { document: { ...document('first'), language: 'en' } }) }, 'en');
    const value = answers.sync(run())!; await settle(); expect(value.document).toBeUndefined(); expect(value.error).toBeTruthy();
  });

  it.each(['queued', 'running', 'exhausted', 'cancelled', 'error'] as const)('shows no document and never starts generation for an existing %s explanation', async status => {
    const { answers, request } = fixture(() => overview(run(), [explanation('first', { status })]));
    const value = answers.sync(run())!; await settle();
    expect(value).toMatchObject({ target: 'first', loading: false }); expect(value.document).toBeUndefined();
    expect(value.explanation?.status).toBe(status);
    expect(answers.generating(value.runId)).toBe(['queued', 'running'].includes(status));
    expect(request.mock.calls).toEqual([['/api/runs/accepted-run/explanations']]);
  });

  it('preserves queued progress and updates to the approved document without starting generation', async () => {
    let saved = explanation('first', { status: 'queued', queue: { position: 3, ahead: 2 }, progress: { phase: 'queued', updatedAt: at } });
    const { answers, request } = fixture(url => url.endsWith('/explanations') ? overview(run(), [saved]) : { explanation: saved });
    const value = answers.sync(run())!; await settle();
    expect(answers.generating(value.runId)).toBe(true);
    expect(value.explanation?.queue?.ahead).toBe(2);
    saved = explanation('first', { status: 'running', progress: { phase: 'auditing', batches: 3, approvedBatches: 1, updatedAt: at } });
    answers.refresh(run()); await settle();
    expect(value.explanation?.progress).toMatchObject({ phase: 'auditing', batches: 3, approvedBatches: 1 });
    saved = explanation('first'); answers.refresh(run()); await settle();
    expect(answers.generating(value.runId)).toBe(false); expect(value.document).toEqual(document('first'));
    expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
    answers.clear(); expect(answers.generating(value.runId)).toBe(false);
  });

  it('keeps missing explanations empty and reuses an unchanged approved document on refresh', async () => {
    let available = false;
    const { answers, request } = fixture(url => url.endsWith('/explanations') ? overview(run(), available ? [explanation('first')] : [])
      : { explanation: explanation('first') });
    const value = answers.sync(run())!; await settle(); expect(value.document).toBeUndefined();
    available = true; answers.refresh(run()); await settle(); expect(value.document).toEqual(document('first'));
    answers.refresh(run()); await settle();
    expect(request.mock.calls.filter(([url]) => url.includes('/item?'))).toHaveLength(1);
    expect(request.mock.calls.every(call => call.length === 1)).toBe(true);
  });

  it('switches targets and drops a previous target response that arrives after the selected target', async () => {
    const old = deferred<{ explanation: WebExplanation }>();
    const { answers, request, changed } = fixture(url => url.endsWith('/explanations') ? overview()
      : url.includes('target=first') ? old.promise : { explanation: explanation('second') });
    const value = answers.sync(run())!; await settle();
    answers.select(value.runId, 'second'); await settle(); expect(value.document).toEqual(document('second'));
    const updates = changed.mock.calls.length;
    old.resolve({ explanation: explanation('first') }); await settle();
    expect(value).toMatchObject({ target: 'second', document: document('second'), loading: false });
    expect(changed).toHaveBeenCalledTimes(updates);
    expect(request.mock.calls.filter(([url]) => url.includes('/item?'))).toHaveLength(2);
  });

  it('drops an overview or document belonging to the old proof after the accepted proof changes', async () => {
    const old = deferred<WebExplanationOverview>(), updated = run({ result: { status: 'evaluated_passed', proof: 'a newly accepted proof', report: {} } });
    let reads = 0;
    const { answers } = fixture(url => url.endsWith('/explanations') ? ++reads === 1 ? old.promise : overview(updated)
      : { explanation: explanation('first', { document: document('first', 'new proof') }) });
    const previous = answers.sync(run())!, current = answers.sync(updated)!; await settle();
    expect(current.document?.overview).toBe('Overview new proof'); expect(current).not.toBe(previous);
    old.resolve(overview()); await settle();
    expect(answers.sync(updated)).toBe(current); expect(current.document?.overview).toBe('Overview new proof');
    expect(previous.document).toBeUndefined();
  });

  it('drops an old owner response after clearing and reopening the same run', async () => {
    const old = deferred<{ explanation: WebExplanation }>(); let itemReads = 0;
    const { answers, changed } = fixture(url => url.endsWith('/explanations') ? overview()
      : ++itemReads === 1 ? old.promise : { explanation: explanation('first', { document: document('first', 'current owner') }) });
    answers.sync(run()); await settle(); answers.clear();
    const current = answers.sync(run())!; await settle(); const updates = changed.mock.calls.length;
    old.resolve({ explanation: explanation('first', { document: document('first', 'former owner') }) }); await settle();
    expect(current.document?.overview).toBe('Overview current owner'); expect(changed).toHaveBeenCalledTimes(updates);
  });

  it('makes a failed read retryable and does not duplicate a refresh already in flight', async () => {
    let overviewReads = 0;
    const pending = deferred<WebExplanationOverview>();
    const { answers, request } = fixture(url => {
      if (!url.endsWith('/explanations')) return { explanation: explanation('first') };
      if (++overviewReads === 1) throw new Error('Saved explanation could not be read');
      return pending.promise;
    });
    const value = answers.sync(run())!; await settle();
    expect(value).toMatchObject({ loading: false, error: 'Saved explanation could not be read' });
    answers.refresh(run()); answers.refresh(run()); expect(request).toHaveBeenCalledTimes(2);
    pending.resolve(overview()); await settle();
    expect(value).toMatchObject({ loading: false, document: document('first') }); expect(value.error).toBeUndefined();
  });

  it('retains an already loaded solution across a transient overview or document read failure', async () => {
    let failOverview = false, failDocument = false, newer = false;
    const saved = () => explanation('first', newer ? { updatedAt: '2026-11-10T08:00:00.000Z' } : {});
    const { answers } = fixture(url => {
      if (url.endsWith('/explanations')) {
        if (failOverview) throw new Error('Temporary overview failure');
        return overview(run(), [saved()]);
      }
      if (failDocument) throw new Error('Temporary document failure');
      return { explanation: saved() };
    });
    const value = answers.sync(run())!; await settle(); const readable = value.document;
    failOverview = true; answers.refresh(run()); await settle();
    expect(value.document).toBe(readable); expect(value.error).toBe('Temporary overview failure');
    failOverview = false; newer = true; failDocument = true; answers.refresh(run()); await settle();
    expect(value.document).toBe(readable); expect(value.error).toBe('Temporary document failure');
    failDocument = false; answers.refresh(run()); await settle();
    expect(value.document).toEqual(document('first')); expect(value.error).toBeUndefined();
  });

  it('discards a previously readable solution when a response identifies a different proof', async () => {
    let mismatch = false;
    const { answers } = fixture(url => {
      if (url.endsWith('/explanations')) {
        const result = overview(); if (mismatch) result.run.proof = 'a different proof'; return result;
      }
      return { explanation: explanation('first') };
    });
    const value = answers.sync(run())!; await settle(); expect(value.document).toBeDefined();
    mismatch = true; answers.refresh(run()); await settle();
    expect(value.document).toBeUndefined(); expect(value.error).toBeTruthy();
    expect(value.explanation).toBeUndefined(); expect(value.overview).toBeUndefined();
  });

  it('discards the previous target and rejected item rather than retaining their mathematics', async () => {
    let badItem = false;
    const { answers } = fixture(url => url.endsWith('/explanations') ? overview() : {
      explanation: badItem ? explanation('first', { document: document('another') }) : explanation('first'),
    });
    const value = answers.sync(run())!; await settle(); expect(value.document).toBeDefined();
    badItem = true; answers.select(value.runId, 'second'); await settle();
    expect(value.document).toBeUndefined(); expect(value.error).toBeTruthy();
  });

  it('uses verified section titles and quotes the selected step, its statement, citations and source in a follow-up', async () => {
    const saved = explanation('first');
    const section = { name: 'first', kind: 'theorem' as const, target: true, title: '加法交换律', statement: 'a + b = b + a',
      lines: { start: 1, end: 2 }, signature: { start: 1, end: 1 }, unexplained: [], statementReviews: [],
      steps: [{ text: '代入自然数 a 和 b。', uses: [{ name: 'Nat.add_comm', place: 'step' as const, spans: [] }], lines: [], reviews: [] }] };
    saved.document!.sections = [section];
    const { answers } = fixture(url => url.endsWith('/explanations') ? overview() : { explanation: saved });
    const value = answers.sync(run())!; await settle(); expect(value.targetTitles?.first).toBe('加法交换律');
    const text = explanationStepQuestion(section, 0, 'https://example.invalid/explain.html?run=accepted-run&target=first', 'zh');
    for (const expected of [section.title, section.statement, section.steps[0].text, 'Nat.add_comm', 'run=accepted-run', '第 1 步']) expect(text).toContain(expected);
    expect(explanationStepQuestion(section, 8, 'ignored', 'zh')).toBe('');
  });

  it.each(['id', 'proof'] as const)('rejects an overview bound to the wrong %s', async field => {
    const result = overview(); result.run[field] = 'another';
    const { answers, request } = fixture(() => result), value = answers.sync(run())!; await settle();
    expect(value.error).toBeTruthy(); expect(value.document).toBeUndefined(); expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['runId', 'id', 'status', 'target', 'language', 'document'] as const)('rejects an item whose %s does not match its approved target', async field => {
    const item = explanation('first');
    const invalid = { ...item, [field]: field === 'document' ? document('second') : field === 'status' ? 'running' : 'another' };
    const { answers } = fixture(url => url.endsWith('/explanations') ? overview() : { explanation: invalid });
    const value = answers.sync(run())!; await settle(); expect(value.error).toBeTruthy(); expect(value.document).toBeUndefined();
  });
});
