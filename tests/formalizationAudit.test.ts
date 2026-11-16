import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formalizationDigest, formalizationInputDigest, prepareFormalization, type DirectFormalizationEvidence } from '../src/math/formalization';
import { assertFormalizationAuditResult, assertFormalizationAuditReview, formalizationAuditInput,
  formalizationAuditOutputSchema, formalizationAuditResultSchema, type FormalizationAuditResult, type FormalizationAuditReview } from '../src/math/formalizationAudit';
import { getLeanTaskEnvironment } from '../src/math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest, readMathText } from '../src/math/mathRuntimeIo';
import type { MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { FORMALIZATION_AUDIT_READING_PROTOCOL, formalizationAuditReadingView, runFormalizationAudit } from '../src/solver/formalizationAudit';
import { buildFixture, candidateFixture, fixtureStatement, syntheticElaboration } from './helpers/formalizationFixture';
import { bindResearchHarness } from '../src/runtime/researchHarness';
import * as workflowSession from '../src/solver/workflowSession';

// Compiler evidence is synthetic. Native fixtures below use only fixed local provider
// replies; they establish transport/lifecycle contracts, never mathematical accuracy.
const temporary: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); })));
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function fixture(padding = 0) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'formalization-audit-'))); temporary.push(parent);
  const { root, manifest } = buildFixture(parent);
  const configuration = { profile: '/synthetic-auditor', executable: '/no-model', model: 'test-reviewer', effort: 'none', buildManifestRef: manifest };
  const request = prepareFormalization(path.join(parent, 'generation'), { problemId: 'synthetic_audit', statement: fixtureStatement,
    environment: 'standard', execution: 'replay', model: 'test-author', effort: 'none', profile: '/synthetic-author', executable: '/no-model',
    buildManifestRef: manifest, reviewMode: 'direct', maxRounds: 0, maxRunSeconds: 0, maxTurnSeconds: 0, maxCompileSeconds: 0, maxTotalTokens: 0 });
  const candidate = candidateFixture(); candidate.source = candidate.source.replace('theorem ', 'theorem ' + ' '.repeat(padding));
  const compiled = syntheticElaboration(candidate.source, request.environment,
    { detailedContext: true, semanticContext: true, structureContext: true, boundedLibraryContext: true });
  const generation = { input: { problemId: request.problemId, statement: request.statement, environment: request.environment,
    toolchain: getLeanTaskEnvironment(request.environment).toolchain, round: 1 }, output: candidate };
  const evidence: DirectFormalizationEvidence = { schema: 'theorem-os.formalization-evidence.v4', status: 'approved', authority: 'compiler',
    method: 'generation-and-compilation', semanticReview: 'not-performed', execution: 'replay', modelInvoked: false, proofVerified: false,
    request, requestDigest: formalizationDigest(request), candidate, inputDigest: formalizationInputDigest(request, candidate),
    generation, sourceSha256: compiled.sourceSha256, targets: compiled.targets, snapshot: compiled.snapshot,
    snapshotDigest: compiled.snapshotDigest, compilation: compiled.compilation, approvedAt: '2026-11-09T00:00:00Z', round: 1,
    sessions: [{ role: 'generate', threadId: 'author-thread', turnId: 'author-turn', status: 'completed',
      model: request.model, effort: request.effort, usage: { totalTokens: 0 },
      inputDigest: formalizationDigest(generation.input), outputDigest: formalizationDigest(candidate) }] };
  return { parent, root, directory: path.join(parent, 'audit'), configuration, evidence };
}
function approved(): FormalizationAuditReview {
  return { verdict: 'approved', summary: 'The statement faithfully represents the natural-number identity.',
    checks: { domains: true, assumptions: true, conclusions: true, definitions: true, quantifierScope: true, instanceCoherence: true }, issues: [] };
}
function objection(): FormalizationAuditReview {
  return { ...approved(), verdict: 'changes_requested', checks: { ...approved().checks, conclusions: false },
    issues: [{ aspect: 'conclusions', originalFragment: 'prove n + 0 = n', leanFragment: 'forall (n : Nat)',
      explanation: 'Synthetic objection locates a target-type quotation to exercise the host contract.' }] };
}
function reviewer(behavior: { output?: FormalizationAuditReview; threadId?: string; status?: string;
  finalText?: string; noFinal?: boolean;
  isolated?: boolean;
  upstream?: boolean; missingUsage?: boolean; onRun?: (options: MathAgentOptions) => void;
  onClose?: (options: MathAgentOptions) => void } = {}) {
  const seen: { options: MathAgentOptions; input: ReturnType<typeof formalizationAuditInput>; message: string }[] = [];
  const close = vi.fn(async () => { if (current) behavior.onClose?.(current); });
  let current: MathAgentOptions | undefined;
  const run = vi.fn(async (message: string, _id: string, workspace: string, started: (turnId: string) => void) => {
    const options = current!;
    const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json')));
    seen.push({ options, input, message }); started('audit-turn');
    if (behavior.upstream) {
      const admission = options.requestGate!({ requestId: 'audit-request', source: 'responses-relay' });
      expect(admission.allowed).toBe(true);
      if (admission.allowed) admission.settle({ complete: !behavior.missingUsage, outcome: 'completed',
        ...(behavior.missingUsage ? { missingReason: 'provider-usage-missing' as const }
          : { usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } }) });
      options.onUsage({ totalTokens: 999 }); // Native totals must not duplicate settled upstream usage.
    } else if (!behavior.missingUsage) options.onUsage({ totalTokens: 7 });
    behavior.onRun?.(options);
    const output = behavior.output ?? approved();
    if (!behavior.noFinal) options.onItem!('completed', { type: 'agentMessage', phase: 'final_answer',
      text: behavior.finalText ?? JSON.stringify(output) }, { turnId: 'audit-turn' });
    return behavior.status ?? 'completed';
  });
  const interrupt = vi.fn(async () => {});
  const open = vi.fn(async (options: MathAgentOptions): Promise<MathAgentSession> => {
    current = options;
    return { threadId: behavior.threadId ?? 'independent-audit-thread', run, close, interrupt,
      ...(behavior.isolated ? { isolationReceipt: { schema: 'theorem-os.formalization-sandbox.v2', backend: 'bwrap',
        workspace: '/workspace', profile: '/profile', providerId: 'web_provider',
        namespaces: ['user', 'mount', 'pid', 'ipc', 'uts', 'net'], network: 'role-model-relay-only', credentials: 'host-only',
        input: 'read-only', canary: 'passed', toolchain: getLeanTaskEnvironment('standard').toolchain,
        environmentDigest: getLeanTaskEnvironment('standard').dependencyDigest, executableSha256: 'a'.repeat(64), profileDigest: 'b'.repeat(64),
        inputSha256: mathDigest(readMathText(path.join(options.workspace, 'INPUT.json'))),
        roleInstructionsSha256: mathDigest(readMathText(path.join(options.workspace, 'ROLE.md'))),
        outputSchemaSha256: mathDigest(readMathText(path.join(options.workspace, 'OUTPUT.schema.json'))), packages: { kind: 'none' } } } : {}),
      ...(behavior.upstream ? { usageSource: 'upstream-requests' as const } : {}) };
  });
  return { open, run, close, interrupt, seen };
}
const readState = (directory: string) => JSON.parse(readMathText(path.join(directory, 'state.json')));

function portableAuditor(f: ReturnType<typeof fixture>, id: 'codex' | 'claude-code' | 'opencode' | 'cli', baseUrl = 'https://example.test/v1') {
  const profile = path.join(f.parent, 'auditor-profile'); fs.mkdirSync(profile);
  let executable = '/usr/bin/python3';
  if (id === 'cli') {
    executable = path.join(f.parent, 'auditor-cli.py');
    fs.copyFileSync(path.resolve('tests/fixtures/sealedCliPeer.py'), executable); fs.chmodSync(executable, 0o700);
    fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify({ schema: 'theorem-os.cli-harness.v1', executable,
      args: ['--model', '{model}', '--effort', '{effort}'], efforts: ['high'],
      output: { format: 'json', text: { field: '/text' } },
      sealedRole: { provider: { wireApi: 'chat-completions', baseUrl, apiKeyEnvironment: 'AUDIT_CLI_FIXTURE_API_KEY' },
        client: { baseUrlEnvironment: 'FIXTURE_MODEL_URL', apiKeyEnvironment: 'FIXTURE_MODEL_KEY' }, runtime: { interpreter: '/usr/bin/python3' } } }));
  } else fs.writeFileSync(path.join(profile, id === 'codex' ? 'config.toml' : id === 'claude-code' ? 'settings.json' : 'opencode.json'),
    id === 'codex' ? 'model="audit-model"\n' : id === 'opencode' ? '{"provider":{"audit-model":{}}}' : '{}');
  const agentHarness = bindResearchHarness(id, executable, profile, process.env, 'audit-model');
  return { ...f.configuration, profile, executable: agentHarness.executable, model: 'audit-model', effort: 'high', agentHarness };
}

describe('portable independent audit delivery', () => {
  it.each(['codex', 'claude-code', 'opencode'] as const)('keeps %s on the native final-response contract without a completed-output file', async id => {
    const f = fixture(), configuration = portableAuditor(f, id), model = reviewer({ upstream: true, isolated: true });
    vi.spyOn(workflowSession, 'openWorkflowSession').mockImplementation(async (_configuration, options) => model.open(options));
    const result = await runFormalizationAudit(f.directory, f.root, f.evidence, configuration);
    expect(result.review).toEqual(approved());
    const { options, message } = model.seen[0];
    expect(options.outputSchema).toEqual(formalizationAuditOutputSchema); expect(options.completedOutput).toBeUndefined();
    expect(options.instructions).toContain('no shell call or output file is needed');
    expect(message).toContain('Return only the final review JSON matching the native output schema');
    expect(fs.existsSync(path.join(options.workspace, 'AUDIT-REVIEW.json'))).toBe(false);
  });

  it('rereads and validates a CLI handoff after closing the writer, before the host writes OUTPUT.json', async () => {
    const f = fixture(), configuration = portableAuditor(f, 'cli');
    const model = reviewer({ upstream: true, isolated: true, status: 'submitted', onRun: options => {
      expect(options.completedOutput!.file).toBe(path.join(options.workspace, 'AUDIT-REVIEW.json'));
      options.completedOutput!.validate(approved());
      fs.writeFileSync(options.completedOutput!.file, JSON.stringify(approved()));
    }, onClose: options => {
      expect(fs.existsSync(path.join(options.workspace, 'OUTPUT.json'))).toBe(false);
      fs.writeFileSync(options.completedOutput!.file, JSON.stringify({ ...approved(), checks: { ...approved().checks, domains: false } }));
    } });
    vi.spyOn(workflowSession, 'openWorkflowSession').mockImplementation(async (_configuration, options) => model.open(options));
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, configuration)).rejects.toThrow('formalization_audit_approval_invalid');
    expect(model.close).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(f.directory, 'session/OUTPUT.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
  });

  it.each(['valid', 'invalid-review', 'invalid-json'] as const)('runs a real generic CLI audit with %s handoff through a fixed local relay', async mode => {
    const f = fixture(), hostKey = 'audit-local-fixture-host-key'; let requests = 0;
    const reviewText = mode === 'invalid-json' ? '{"verdict":' : JSON.stringify(mode === 'invalid-review'
      ? { ...approved(), checks: { ...approved().checks, domains: false } } : approved());
    const python = "from pathlib import Path; Path('/workspace/AUDIT-REVIEW.json').write_text(" + JSON.stringify(reviewText) + ')';
    const command = '/usr/bin/python3 -c ' + "'" + python.replaceAll("'", "'\\''") + "'" + (mode === 'valid' ? '; sleep 30' : '');
    const server = createServer((request, response) => {
      let text = ''; request.on('data', chunk => text += chunk); request.on('end', () => {
        requests++;
        expect(request.url).toBe('/v1/chat/completions'); expect(request.headers.authorization).toBe('Bearer ' + hostKey);
        const body = JSON.parse(text);
        if (requests === 1) {
          const prompt = body.messages[0].content;
          expect(prompt).toContain('/workspace/AUDIT-REVIEW.json');
          expect(prompt).toContain('Do not write OUTPUT.json');
          expect(prompt).not.toContain('no shell call or output file is needed');
          expect(prompt).not.toContain('Return only the review JSON in your final response matching the native output schema');
        }
        const call = requests === 1;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ id: 'audit-local-' + requests, model: body.model,
          choices: [{ index: 0, finish_reason: call ? 'tool_calls' : 'stop', message: { role: 'assistant', content: call ? null : JSON.stringify(approved()),
            ...(call ? { tool_calls: [{ id: 'audit-write', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command }) } }] } : {}) } }],
          usage: { prompt_tokens: 17, completion_tokens: 4, total_tokens: 21 } }));
      });
    });
    servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const baseUrl = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    vi.stubEnv('AUDIT_CLI_FIXTURE_API_KEY', hostKey);
    const configuration = portableAuditor(f, 'cli', baseUrl), before = structuredClone(f.evidence);
    const run = runFormalizationAudit(f.directory, f.root, f.evidence, configuration, { maxRunSeconds: 15, maxTotalTokens: 1000 });
    if (mode === 'valid') {
      const result = await run;
      expect(result.review).toEqual(approved()); expect(result.session.status).toBe('submitted');
      expect(result.session.completionReason).toBe('validated-output'); expect(requests).toBe(1);
      expect(JSON.parse(readMathText(path.join(f.directory, 'session/OUTPUT.json')))).toEqual(approved());
      expect(fs.statSync(path.join(f.directory, 'session/OUTPUT.json')).mode & 0o222).toBe(0);
      expect(await runFormalizationAudit(f.directory, f.root, f.evidence, configuration, { maxTotalTokens: 1000 })).toEqual(result);
      expect(requests).toBe(1);
    } else {
      if (mode === 'invalid-review') await expect(run).rejects.toThrow('formalization_audit_approval_invalid');
      else await expect(run).rejects.toThrow();
      expect(requests).toBe(2);
      expect(fs.existsSync(path.join(f.directory, 'session/OUTPUT.json'))).toBe(false);
      expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
    }
    const state = readState(f.directory);
    expect(state.status).toBe(mode === 'valid' ? 'completed' : 'error');
    expect(state.isolationReceipt).toMatchObject({ harness: 'cli', input: 'read-only', credentials: 'host-only', canary: 'passed' });
    expect(state.session.requestUsageAccounting.pendingRequests).toBe(0);
    expect(state.session.requestUsageAccounting.receipts.every((entry: { source: string; status: string }) => entry.source === 'native-model-relay')).toBe(true);
    expect(state.tokenBudget).toMatchObject({ usageComplete: true, reportedTotalTokens: 21 * requests });
    expect(readMathText(path.join(f.directory, 'session/ROLE.md'))).not.toContain('no shell call or output file is needed');
    expect(f.evidence).toEqual(before);
  }, 30_000);
});

describe('background formalization audit', () => {
  it('audits only the original and frozen compiled statement in one isolated unlimited session and reuses its completed result', async () => {
    const f = fixture(), model = reviewer({ upstream: true }), usage: number[] = [];
    const before = structuredClone(f.evidence);
    const result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, {
      openSession: model.open, onUsage: tokens => usage.push(tokens), maxRunSeconds: 0, maxTotalTokens: 0 });
    expect(() => assertFormalizationAuditResult(f.evidence, result)).not.toThrow();
    expect(formalizationAuditResultSchema.parse(JSON.parse(readMathText(path.join(f.directory, 'result.json'))))).toEqual(result);
    expect(result).toMatchObject({ schema: 'theorem-os.formalization-audit.v1', model: 'test-reviewer', review: approved(),
      session: { threadId: 'independent-audit-thread', turnId: 'audit-turn', status: 'completed',
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 } } });
    expect(model.open).toHaveBeenCalledOnce(); expect(model.run).toHaveBeenCalledOnce(); expect(model.close).toHaveBeenCalledOnce();
    const { input, options, message } = model.seen[0];
    expect(input).toEqual(formalizationAuditInput(f.evidence, f.configuration));
    expect(Object.keys(input).sort()).toEqual(['schema', 'model', 'effort', 'original', 'source', 'snapshot'].sort());
    for (const note of [f.evidence.candidate.assumptionsExplanation, f.evidence.candidate.definitionsExplanation,
      f.evidence.candidate.coverage[0].explanation, 'author-thread']) expect(JSON.stringify(input)).not.toContain(note);
    expect(options.readIsolation).toEqual({ environment: 'standard', packages: 'sources' }); expect(options.turnTimeoutMs).toBeUndefined();
    expect(options.outputSchema).toEqual(formalizationAuditOutputSchema); expect(options.completedOutput).toBeUndefined();
    expect(JSON.parse(readMathText(path.join(options.workspace, 'OUTPUT.json')))).toEqual(approved());
    expect(message).toContain('BEGIN INPUT.json'); expect(options.instructions).toContain('Do not plan, backtranslate, prove the theorem');
    for (const file of ['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json'])
      expect(fs.statSync(path.join(options.workspace, file)).mode & 0o222).toBe(0);
    expect(readState(f.directory)).toMatchObject({ status: 'completed', tokenBudget: { status: 'unlimited', maxTotalTokens: 0, reportedTotalTokens: 7 } });
    expect(usage).toEqual([7]); expect(f.evidence).toEqual(before);
    expect(await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open })).toEqual(result);
    expect(model.open).toHaveBeenCalledOnce();
  });

  it.each(['unknown', 'changes_requested'] as const)('preserves a %s opinion without regenerating or approving the candidate', async verdict => {
    const f = fixture(), output = verdict === 'unknown' ? { ...approved(), verdict, checks: { ...approved().checks, definitions: false } } : objection();
    const model = reviewer({ output });
    const result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open });
    expect(result.review).toEqual(output); expect(model.run).toHaveBeenCalledOnce(); expect(model.close).toHaveBeenCalledOnce();
  });

  it('keeps unlimited execution available when provider usage is missing and records the accounting gap', async () => {
    const f = fixture(), model = reviewer({ upstream: true, missingUsage: true });
    const result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open });
    expect(result.session.usage).toEqual({});
    expect(readState(f.directory).tokenBudget).toMatchObject({ status: 'unlimited', usageComplete: false, reportedTotalTokens: null });
  });

  it.each(['evidenceSha256', 'sourceSha256', 'snapshotDigest', 'originalSha256', 'environmentDigest'] as const)(
    'rejects a forged %s binding', async field => {
      const f = fixture(), model = reviewer();
      const result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open });
      result[field] = '0'.repeat(64);
      expect(() => assertFormalizationAuditResult(f.evidence, result)).toThrow('formalization_audit_evidence_mismatch');
    });

  it.each(['model', 'effort', 'inputDigest', 'outputDigest'] as const)('rejects a forged %s session identity', async field => {
    const f = fixture(), model = reviewer();
    const result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open });
    if (field === 'model' || field === 'effort') result[field] = 'different'; else result.session[field] = '0'.repeat(64);
    expect(() => assertFormalizationAuditResult(f.evidence, result)).toThrow('formalization_audit_session_mismatch');
  });

  it('rejects generation thread reuse before starting an audit turn and in a forged saved result', async () => {
    const f = fixture(), reused = reviewer({ threadId: 'author-thread' });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: reused.open }))
      .rejects.toThrow('formalization_audit_generation_thread_reused');
    expect(reused.run).not.toHaveBeenCalled(); expect(reused.close).toHaveBeenCalledOnce();
    const result = await runFormalizationAudit(path.join(f.parent, 'other-audit'), f.root, f.evidence, f.configuration, { openSession: reviewer().open });
    result.session.threadId = 'author-thread';
    expect(() => assertFormalizationAuditResult(f.evidence, result)).toThrow('formalization_audit_generation_thread_reused');
  });

  it('requires the real model isolation receipt before starting a review of model evidence', async () => {
    const f = fixture(), model = reviewer();
    f.evidence.execution = f.evidence.request.execution = 'model'; f.evidence.modelInvoked = true;
    f.evidence.requestDigest = formalizationDigest(f.evidence.request);
    f.evidence.inputDigest = formalizationInputDigest(f.evidence.request, f.evidence.candidate);
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open }))
      .rejects.toThrow('formalization_review_isolation_invalid');
    expect(model.run).not.toHaveBeenCalled(); expect(model.close).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
  });

  it.each([
    ['originalFragment', 'Invented original quotation', 'formalization_audit_original_fragment_not_found'],
    ['leanFragment', 'Invented Lean quotation', 'formalization_audit_lean_fragment_not_found'],
  ] as const)('rejects an invented %s even after the output digest is rebound', async (field, quote, error) => {
    const f = fixture(), result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: reviewer({ output: objection() }).open });
    result.review.issues[0][field] = quote; result.session.outputDigest = formalizationDigest(result.review);
    expect(() => assertFormalizationAuditResult(f.evidence, result)).toThrow(error);
  });

  it('rejects unsupported approvals and change requests without concrete issues', () => {
    const { evidence } = fixture();
    for (const aspect of ['domains', 'assumptions', 'conclusions', 'definitions', 'quantifierScope', 'instanceCoherence'])
      expect(() => assertFormalizationAuditReview(evidence, { ...approved(), checks: { ...approved().checks, [aspect]: false } }))
        .toThrow('formalization_audit_approval_invalid');
    expect(() => assertFormalizationAuditReview(evidence, { ...objection(), verdict: 'approved' })).toThrow('formalization_audit_approval_invalid');
    expect(() => assertFormalizationAuditReview(evidence, { ...approved(), verdict: 'changes_requested' })).toThrow('formalization_audit_changes_without_issue');
    expect(() => assertFormalizationAuditReview(evidence, { ...approved(), statement: 'replacement Lean' })).toThrow('formalization_audit_review_invalid');
  });

  it('validates the final output after closing its writer', async () => {
    const f = fixture(), model = reviewer({ onClose: options => {
      expect(fs.existsSync(path.join(options.workspace, 'OUTPUT.json'))).toBe(false);
      options.onItem!('completed', { type: 'agentMessage', phase: 'final_answer',
        text: JSON.stringify({ ...approved(), checks: { ...approved().checks, domains: false } }) }, { turnId: 'audit-turn' });
    } });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open }))
      .rejects.toThrow('formalization_audit_approval_invalid');
    expect(model.close).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
    expect(readState(f.directory)).toMatchObject({ status: 'error', error: 'formalization_audit_approval_invalid' });
  });

  it.each(['commentary', 'partial_answer'])('rejects a %s message without a completed final JSON response', async phase => {
    const f = fixture(), model = reviewer({ noFinal: true, onRun: options => {
      options.onItem!('started', { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(approved()) }, { turnId: 'audit-turn' });
      options.onItem!('completed', { type: 'agentMessage', phase, text: JSON.stringify(approved()) }, { turnId: 'audit-turn' });
      options.onItem!('completed', { type: 'agentMessage', phase: 'final_answer', text: JSON.stringify(approved()) }, { turnId: 'unrelated-turn' });
      fs.writeFileSync(path.join(options.workspace, 'OUTPUT.json'), JSON.stringify(approved()));
    } });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open }))
      .rejects.toThrow('formalization_audit_final_response_missing');
    expect(model.close).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
  });

  it('rejects invalid final JSON after closing the session without saving an audit result', async () => {
    const f = fixture(), model = reviewer({ finalText: '{"verdict":' });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open })).rejects.toThrow();
    expect(model.close).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
    expect(fs.existsSync(path.join(f.directory, 'session/OUTPUT.json'))).toBe(false);
  });

  it.each(['INPUT.json', 'ROLE.md', 'OUTPUT.schema.json'])('rejects changed frozen %s bytes', async file => {
    const f = fixture(), model = reviewer({ onRun: options => {
      const filename = path.join(options.workspace, file); fs.chmodSync(filename, 0o600); fs.appendFileSync(filename, '\n');
    } });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open }))
      .rejects.toThrow('formalization_audit_contract_changed');
    expect(model.close).toHaveBeenCalledOnce(); expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
  });

  it.each(['failed', 'interrupted'])('records a %s session as an error without accepting its output', async status => {
    const f = fixture(), model = reviewer({ status });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open }))
      .rejects.toThrow('formalization_audit_session_incomplete:' + status);
    expect(model.close).toHaveBeenCalledOnce(); expect(readState(f.directory).status).toBe('error');
    expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
  });

  it('cancels an active audit, closes the writer and does not return an approval', async () => {
    const f = fixture(), controller = new AbortController(), model = reviewer({ onRun: () => controller.abort() });
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open, signal: controller.signal }))
      .rejects.toThrow('formalization_audit_cancelled');
    expect(model.interrupt).toHaveBeenCalledOnce(); expect(model.close).toHaveBeenCalledOnce();
    expect(readState(f.directory)).toMatchObject({ status: 'error', error: 'formalization_audit_cancelled' });
    expect(fs.existsSync(path.join(f.directory, 'result.json'))).toBe(false);
    await expect(runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open }))
      .rejects.toThrow('formalization_audit_directory_in_use');
    expect(model.open).toHaveBeenCalledOnce();
  });

  it('accepts an audit worker build without reading the generation worker manifest path', async () => {
    const f = fixture();
    f.evidence.request.buildManifestRef = '/other-container/generation/build.json';
    f.evidence.requestDigest = formalizationDigest(f.evidence.request);
    f.evidence.inputDigest = formalizationInputDigest(f.evidence.request, f.evidence.candidate);
    const result: FormalizationAuditResult = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: reviewer().open });
    expect(() => assertFormalizationAuditResult(f.evidence, result)).not.toThrow();
  });

  it('sends the reading view in the audit turn while keeping the original input and v1 result digest', async () => {
    const f = fixture(70_000), model = reviewer();
    const input = canonicalMathJson(formalizationAuditInput(f.evidence, f.configuration));
    expect(Buffer.byteLength(input)).toBeGreaterThan(128 * 1024);
    const result = await runFormalizationAudit(f.directory, f.root, f.evidence, f.configuration, { openSession: model.open });
    const { message, options } = model.seen[0];
    expect(message).toContain('BEGIN AUDIT READING VIEW');
    expect(message).toContain('theorem-os.formalization-audit-reading-view.v2');
    expect(options.instructions).toContain(FORMALIZATION_AUDIT_READING_PROTOCOL);
    expect(readMathText(path.join(options.workspace, 'INPUT.json'))).toBe(input);
    expect(result.session.inputDigest).toBe(formalizationDigest(formalizationAuditInput(f.evidence, f.configuration)));
    expect(() => assertFormalizationAuditResult(f.evidence, result)).not.toThrow();
  });
});

describe('inline audit reading view', () => {
  function expand(text: string) {
    const packet = JSON.parse(text);
    if (packet.schema !== 'theorem-os.formalization-shared-context.v1') return packet;
    const dictionary: unknown[] = [];
    const resolve = (value: any): any => Array.isArray(value) ? value.map(resolve) : value && typeof value === 'object'
      ? Object.keys(value).length === 1 && '$ref' in value ? dictionary[value.$ref]
        : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolve(child)])) : value;
    for (const entry of packet.dictionary) dictionary.push(resolve(entry));
    const view = resolve(packet.input);
    expect(packet.canonicalInputSha256).toBe(mathDigest(canonicalMathJson(view)));
    return view;
  }

  it('keeps complete source and actual types while locating expanded meanings in the unchanged frozen input', () => {
    const f = fixture(), input = structuredClone(formalizationAuditInput(f.evidence, f.configuration));
    const context = input.snapshot.targets[0].context;
    context.constants.push({ name: 'Pinned.largeImportedDefinition', module: 'Pinned', type: 'Nat',
      definition: 'Synthetic deferred imported observation. '.repeat(5_000) });
    const before = canonicalMathJson(input), text = formalizationAuditReadingView(before)!, packet = expand(text);
    expect(packet.schema).toBe('theorem-os.formalization-audit-reading-view.v2');
    expect(packet.frozenInputSha256).toBe(mathDigest(before));
    expect(packet.input.original).toBe(input.original); expect(packet.input.source).toBe(input.source);
    const focused = packet.input.snapshot.targets[0].context;
    for (const key of ['type', 'bindings', 'references', 'omitted'] as const)
      expect(focused[key]).toEqual(context[key]);
    expect(focused.elaboratedType).toBe(context.semantic!.rawType);
    expect(focused.kernelInputPath).toBe('$.snapshot.targets[0].context.semantic.kernelType');
    expect(focused.localDeclarations.map((entry: any) => ({ name: entry.name, kind: entry.kind, type: entry.type })))
      .toEqual(context.semantic!.localMeaningClosure.map(entry => ({ name: entry.name, kind: entry.kind, type: entry.rawType })));
    expect(focused).not.toHaveProperty('constants'); expect(focused).not.toHaveProperty('structures');
    expect(focused.importedLibrary.constants).toEqual({ inputPath: '$.snapshot.targets[0].context.constants', count: context.constants.length });
    expect(focused.importedLibrary.structures).toEqual({ schema: context.structures!.schema,
      inputPath: '$.snapshot.targets[0].context.structures.entries', count: context.structures!.entries.length });
    const { importedLibrary: _deferred, elaboratedType: _type, kernelInputPath: _path, localDeclarations: _locals, ...complete } = focused;
    packet.input.snapshot.targets[0].context = { ...complete, constants: context.constants, structures: context.structures, semantic: context.semantic };
    expect(canonicalMathJson(packet.input)).toBe(before); expect(canonicalMathJson(input)).toBe(before);
    expect(Buffer.byteLength(text)).toBeLessThan(128 * 1024);
  });

  it('keeps every reached local declaration and exact lookup paths for long values, including generated local meanings', () => {
    const f = fixture(), input = structuredClone(formalizationAuditInput(f.evidence, f.configuration));
    const context = input.snapshot.targets[0].context;
    const rawValue = 'Synthetic complete local meaning with explicit instance arguments. '.repeat(1_500);
    context.semantic!.localMeaningClosure = ['Hidden.first', 'Hidden.second'].map(name => ({ name, kind: 'definition',
      rawType: 'Nat', type: ['const', ['str', null, 'Nat'], []], rawValue, value: ['nat', '0'] }));
    context.semantic!.localMeaningClosure.push({ name: 'Hidden.generated', kind: 'theorem', rawType: 'True',
      type: ['const', ['str', null, 'True'], []] });
    context.omitted.push('Pinned.unexported');
    const before = canonicalMathJson(input), text = formalizationAuditReadingView(before)!, packet = expand(text);
    const locals = packet.input.snapshot.targets[0].context.localDeclarations;
    expect(locals.map((entry: any) => entry.name)).toEqual(['Hidden.first', 'Hidden.second', 'Hidden.generated']);
    for (const [index, local] of locals.entries()) {
      expect(local.type).toBe(context.semantic!.localMeaningClosure[index].rawType);
      expect(local.kernelInputPath).toBe(`$.snapshot.targets[0].context.semantic.localMeaningClosure[${index}]`);
      if (index < 2) expect(local.value).toEqual({ inputPath: local.kernelInputPath + '.rawValue', bytes: Buffer.byteLength(rawValue) });
      else expect(local).not.toHaveProperty('value');
    }
    expect(text).not.toContain(rawValue);
    expect(packet.input.snapshot.targets[0].context.omitted).toEqual(context.omitted);
    expect(packet.frozenInputSha256).toBe(mathDigest(before));
    expect(FORMALIZATION_AUDIT_READING_PROTOCOL).toContain('Use unknown if a necessary meaning remains unresolved');
    expect(FORMALIZATION_AUDIT_READING_PROTOCOL).toContain('deferred, not empty or already checked');
  });

  it('keeps small inputs on the complete inline path', () => {
    const f = fixture();
    expect(formalizationAuditReadingView(canonicalMathJson(formalizationAuditInput(f.evidence)))).toBeUndefined();
  });
});
