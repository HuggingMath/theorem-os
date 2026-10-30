import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { explanationDocument } from '../apps/web/explanation';
import type { StaticReportPage } from '../apps/web/staticReport';
import { formalizationDigest, readFormalizationArtifact } from '../src/math/formalization';
import { attachInformalizationGoals, informalizationExtractionQuery, informalizationGoalsQuery, informalizationLibraryContext,
  informalizationOutline, informalizationOutlineSchema, leanSourceSlice, type InformalizationGoalsResult,
  type InformalizationOutline } from '../src/math/informalizationExtraction';
import { INFORMALIZATION_ALIGNMENT, INFORMALIZATION_AUDITOR_INSTRUCTIONS, INFORMALIZATION_WRITER_INSTRUCTIONS,
  assertInformalizationEvidence, informalizationAuditApproved, informalizationAuditFeedback, informalizationAuditInput,
  informalizationAuditRejections, informalizationBatches, informalizationExcerptCoverage, informalizationRoleInstructions,
  informalizationRoleOutputSchema, informalizationWriterInput, informalizationWriterRejections, readInformalizationArtifact,
  readInformalizationRequest, renderInformalization, type InformalizationAlignedAuditOutput, type InformalizationAlignedSection,
  type InformalizationAuditInput, type InformalizationAuditOutput, type InformalizationSection,
  type InformalizationWriterInput, type InformalizationWriterOutput } from '../src/math/informalization';
import { mathDigest, readMathText } from '../src/math/mathRuntimeIo';
import type { MathAgentFailureDiagnostic, MathAgentOptions, MathAgentSession } from '../src/runtime/codexSession';
import { readInformalizationState, runInformalization } from '../src/solver/informalization';
import { informalize } from '../scripts/mathematics/informalize';
import { INFORMALIZATION_NONCE, LIB_SOURCE, PROOF_SOURCE, informalizationFixture, informalizationGoalsReport, informalizationReport,
  informalizationSources, sourceRange } from './helpers/informalizationFixture';
import { ADDITION_PROOF, approvedFormalization } from './helpers/approvedFormalizationFixture';
import { fixtureStatement } from './helpers/formalizationFixture';

// Protocol and host-check fixtures with preset roles; these are not model or Lean accuracy measurements.
const forbidden = vi.hoisted(() => ({ model: vi.fn(async () => { throw new Error('model_must_not_open'); }) }));
vi.mock('../src/runtime/codexSession', async original =>
  ({ ...await original<typeof import('../src/runtime/codexSession')>(), createCodexMathSession: forbidden.model }));
// The report phase's page payload, written as JSON; tests/staticReport.test.ts covers the page itself, which needs a web build.
const pages = vi.hoisted(() => ({ written: [] as { output: string; report: StaticReportPage }[] }));
vi.mock('../apps/web/staticReport', async original => ({ ...await original<typeof import('../apps/web/staticReport')>(),
  writeStaticReport: (_root: string, output: string, report: StaticReportPage) => {
    pages.written.push({ output, report });
    // Called during a test, after this file's imports are bound.
    fs.writeFileSync(output, JSON.stringify(report));
    return output;
  } }));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  forbidden.model.mockClear();
  pages.written.length = 0;
});

type Report = ReturnType<typeof informalizationReport>;
function outlineOf(edit?: (report: Report) => void): InformalizationOutline {
  const report = informalizationReport(); edit?.(report);
  return informalizationOutline(report, { nonce: INFORMALIZATION_NONCE, target: 'double_add_zero', sources: informalizationSources() });
}
// A writer that quotes each declaration's whole source and cites exactly what it must.
function explain(input: InformalizationWriterInput, edit?: (sections: InformalizationSection[]) => void): InformalizationWriterOutput {
  const sections: InformalizationSection[] = input.units.map(unit => ({ declaration: unit.declaration, title: 'T ' + unit.declaration,
    statement: 'S ' + unit.signature,
    proof: unit.kind === 'theorem' ? [{ text: 'Follow the Lean proof of ' + unit.declaration + '.', uses: unit.mustCite, lean: [unit.source] }] : [] }));
  edit?.(sections);
  return { inputDigest: input.inputDigest, sections, overview: input.batch.final ? 'Combine the lemmas into the target.' : null };
}
function review(input: InformalizationAuditInput, edit?: (output: InformalizationAuditOutput) => void): InformalizationAuditOutput {
  const output: InformalizationAuditOutput = { inputDigest: input.inputDigest,
    sections: input.explanation.sections.map(section => ({ declaration: section.declaration,
      statement: { verdict: 'faithful', explanation: '' }, steps: section.proof.map(() => ({ verdict: 'justified', explanation: '' })),
      omissions: [] })),
    overview: { verdict: input.explanation.overview === null ? 'absent' : 'consistent', explanation: '' }, summary: 'No problems.' };
  edit?.(output);
  return output;
}
type Call = { role: 'write' | 'audit'; auditorId?: string; batch: number; round: number; workspace: string;
  input: Record<string, unknown> & { inputDigest: string }; options: MathAgentOptions };
type Behavior = {
  write?: (input: InformalizationWriterInput, count: number) => unknown;
  audit?: (input: InformalizationAuditInput, auditorId: string, count: number) => unknown;
  diagnostic?: (call: Call, count: number) => MathAgentFailureDiagnostic | undefined;
};
// Workspaces are batches/<batch>/round-<round>[/retry-<uuid>]/<write | audit-<id>-<attempt>>.
function presetAgent(behavior: Behavior = {}) {
  const calls: Call[] = [], counts = new Map<string, number>();
  const open = async (options: MathAgentOptions): Promise<MathAgentSession> => {
    const threadId = 'informalization-thread-' + crypto.randomUUID();
    let diagnostic: MathAgentFailureDiagnostic | undefined;
    return { threadId, get lastFailureDiagnostic() { return diagnostic; }, interrupt: async () => {}, close: async () => {},
      run: async (_message, _id, workspace, onStarted) => {
        onStarted('informalization-turn-' + threadId);
        options.onUsage({ inputTokens: 1, outputTokens: 0, totalTokens: 1 });
        const name = path.basename(workspace), parts = workspace.slice(workspace.lastIndexOf('/batches/') + 1).split('/');
        const role = name === 'write' ? 'write' as const : 'audit' as const;
        const auditorId = role === 'audit' ? name.replace(/^audit-/u, '').replace(/-\d+$/u, '') : undefined;
        const input = JSON.parse(readMathText(path.join(workspace, 'INPUT.json'))) as Call['input'];
        const call: Call = { role, ...(auditorId ? { auditorId } : {}), batch: Number(parts[1]),
          round: Number(parts[2]!.replace('round-', '')), workspace, input, options };
        calls.push(call);
        const key = role + ':' + (auditorId ?? ''), count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
        diagnostic = behavior.diagnostic?.(call, count);
        if (diagnostic) return 'failed';
        const output = role === 'write'
          ? behavior.write ? behavior.write(input as unknown as InformalizationWriterInput, count) : explain(input as unknown as InformalizationWriterInput)
          : behavior.audit ? behavior.audit(input as unknown as InformalizationAuditInput, auditorId!, count) : review(input as unknown as InformalizationAuditInput);
        if (output !== undefined) fs.writeFileSync(path.join(workspace, 'OUTPUT.json'), JSON.stringify(output));
        return 'completed';
      } };
  };
  return { open, calls };
}

function runner(overrides: Parameters<typeof informalizationFixture>[1] = {}) {
  const f = informalizationFixture(roots, overrides), request = f.prepare();
  const extract = vi.fn(async (_directory: string, _request: unknown, sources: readonly { module: string; file: string; text: string }[],
    _options: unknown) => informalizationOutline(informalizationReport(), { nonce: INFORMALIZATION_NONCE, target: 'double_add_zero', sources }));
  const run = (agent: ReturnType<typeof presetAgent>, options: Omit<NonNullable<Parameters<typeof runInformalization>[2]>, 'openSession'> = {}) =>
    runInformalization(f.directory, f.root, { openSession: agent.open, extract: extract as never, waitForRetry: async () => {}, ...options });
  return { ...f, request, extract, run };
}
describe('declaration outline', () => {
  it('orders declarations by dependency with source-order ties and the target last', () => {
    const outline = outlineOf();
    expect(outline.units.map(unit => unit.name)).toEqual(['lib_fact', 'double', 'double_eq', 'double_add_zero']);
    expect(outline).toMatchObject({ target: 'double_add_zero', cyclic: false, axioms: ['propext'] });
    expect(outline.units[0]).toMatchObject({ module: 'Lib', file: 'Lib.lean', source: LIB_SOURCE.trim() });
    expect(outline.units[1]!.source).toBe('/-- Twice a number. -/\ndef double (n : Nat) : Nat := n + n');
    expect(outline.units[3]!.proofDependencies).toEqual(['double', 'double_eq', 'lib_fact']);
  });

  it('names private declarations by their user name in every dependency list', () => {
    const outline = outlineOf(report => {
      report.units[1]!.name = '_private.Proof.0.double_eq';
      report.units[0]!.proofDependencies = ['double', '_private.Proof.0.double_eq', 'lib_fact'];
    });
    expect(outline.units[2]).toMatchObject({ name: 'double_eq', leanName: '_private.Proof.0.double_eq' });
    expect(outline.units[3]!.proofDependencies).toEqual(['double', 'double_eq', 'lib_fact']);
  });

  it.each([
    ['sorryAx', (r: Report) => { r.axioms.push('sorryAx'); }, 'informalization_proof_incomplete'],
    ['a declared axiom', (r: Report) => { r.units[3]!.kind = 'axiom'; }, 'informalization_proof_assumes_axiom: lib_fact'],
    ['a repeated display name', (r: Report) => { r.units[1]!.displayName = 'double'; }, 'informalization_declaration_name_ambiguous: double'],
    ['a module outside the sources', (r: Report) => { r.units[3]!.module = 'Other'; }, 'informalization_declaration_outside_sources: lib_fact'],
    ['another nonce', (r: Report) => { r.nonce = 'f'.repeat(32); }, 'informalization_extraction_report_invalid'],
    ['an unknown dependency', (r: Report) => { r.units[0]!.proofDependencies.push('ghost'); }, 'informalization_extraction_report_invalid'],
    ['a non-theorem target', (r: Report) => { r.units[0]!.kind = 'definition'; }, 'informalization_extraction_report_invalid'],
    ['a range past the line', (r: Report) => { r.units[3]!.range.endColumn = 500; }, 'informalization_declaration_range_invalid'],
  ])('refuses a report with %s', (_name, edit, error) => {
    expect(() => outlineOf(edit)).toThrow(error);
  });

  it('marks a dependency cycle and still places the target last', () => {
    const outline = outlineOf(report => { report.units[3]!.proofDependencies = ['double_add_zero']; });
    expect(outline.cyclic).toBe(true);
    expect(outline.units.map(unit => unit.name)).toEqual(['double', 'double_eq', 'lib_fact', 'double_add_zero']);
  });

  it('slices by codepoint columns over normalized line endings', () => {
    const text = 'def a := 1\r\ntheorem 𝔽x : True :=\r\n  trivial\r\n';
    expect(leanSourceSlice(text, { line: 2, column: 0, endLine: 3, endColumn: 9 })).toBe('theorem 𝔽x : True :=\n  trivial');
    expect(leanSourceSlice(text, { line: 2, column: 8, endLine: 2, endColumn: 10 })).toBe('𝔽x');
    expect(() => leanSourceSlice(text, { line: 2, column: 4, endLine: 2, endColumn: 3 })).toThrow('informalization_declaration_range_invalid');
  });

  it('binds the query to a host nonce and refuses unsafe names', () => {
    const { query, resultFile } = informalizationExtractionQuery({ nonce: INFORMALIZATION_NONCE, rootModule: 'Proof',
      modules: ['Lib', 'Proof'], target: 'double_add_zero' });
    expect(query).toContain('import Proof\n');
    expect(query).toContain(`namespace TheoremOSInformalization_${INFORMALIZATION_NONCE}`);
    expect(resultFile).toBe(`.lake/informalization-${INFORMALIZATION_NONCE}.json`);
    for (const input of [{ nonce: 'NOT-HEX' }, { rootModule: 'Missing' }, { target: 'x" #eval 1' }])
      expect(() => informalizationExtractionQuery({ nonce: INFORMALIZATION_NONCE, rootModule: 'Proof', modules: ['Lib', 'Proof'],
        target: 'double_add_zero', ...input })).toThrow(/informalization_extraction_(?:nonce|name)_invalid/u);
  });

  it('lists the library theorems the units use, without tactic internals', () => {
    const outline = outlineOf();
    expect(informalizationLibraryContext(outline, outline.units)).toEqual([{ name: 'Nat.two_mul', module: 'Init.Data.Nat.Basic',
      signature: 'theorem Nat.two_mul (n : Nat) : 2 * n = n + n' }]);
    expect(informalizationLibraryContext(outline, outline.units.slice(0, 1))).toEqual([]);
  });
});

const outline = outlineOf();
const batchesOf = (maxUnits = 2) => informalizationBatches(outline, { maxUnits, maxSourceBytes: 60_000 });
function writerInput(index: number, accepted = new Map<string, InformalizationSection>()) {
  return informalizationWriterInput({ outline, batch: batchesOf()[index]!, accepted, sources: informalizationSources(), language: 'zh',
    round: 1, problemStatement: 'Show that double (n + 0) is 2n.', feedback: null, previousOutput: null });
}
function auditInput(index: number, explanation = explain(writerInput(index))) {
  return informalizationAuditInput({ outline, batch: batchesOf()[index]!, accepted: new Map(), sources: informalizationSources(),
    language: 'zh', explanation });
}

describe('host checks', () => {
  it('batches in dependency order by count and by source bytes', () => {
    expect(batchesOf()).toEqual([{ index: 0, count: 2, final: false, declarations: ['lib_fact', 'double'] },
      { index: 1, count: 2, final: true, declarations: ['double_eq', 'double_add_zero'] }]);
    expect(informalizationBatches(outline, { maxUnits: 64, maxSourceBytes: 1 }).map(batch => batch.declarations))
      .toEqual([['lib_fact'], ['double'], ['double_eq'], ['double_add_zero']]);
    expect(batchesOf(64)).toEqual([{ index: 0, count: 1, final: true, declarations: outline.units.map(unit => unit.name) }]);
  });

  it('gives the writer accepted dependency statements, required citations and citable library names', () => {
    const accepted = new Map(explain(writerInput(0)).sections.map(section => [section.declaration, section]));
    const input = writerInput(1, accepted);
    expect(input.dependencies).toEqual([
      { declaration: 'double', kind: 'definition', signature: 'double (n : Nat) : Nat', title: 'T double', statement: 'S double (n : Nat) : Nat' },
      { declaration: 'lib_fact', kind: 'theorem', signature: 'lib_fact (n : Nat) : n + 0 = n', title: 'T lib_fact',
        statement: 'S lib_fact (n : Nat) : n + 0 = n' }]);
    expect(input.units.map(unit => [unit.declaration, unit.mustCite, unit.citableLibrary])).toEqual([
      ['double_eq', [], ['Nat.two_mul', 'Eq']], ['double_add_zero', ['double_eq', 'lib_fact'], ['Eq.mpr', 'Nat']]]);
    expect(input.files).toEqual([{ module: 'Lib', path: 'proof/Lib.lean' }, { module: 'Proof', path: 'proof/Proof.lean' }]);
    expect(writerInput(1).dependencies.every(item => item.statement === null)).toBe(true);
  });

  it('accepts a writer output that cites what the Lean terms use and quotes the source modulo whitespace', () => {
    const input = writerInput(1);
    expect(informalizationWriterRejections(input, explain(input))).toEqual([]);
    expect(informalizationWriterRejections(input, explain(input, sections => {
      sections[0]!.proof = [{ text: 'Unfold and use 2n = n + n.', uses: ['double', 'Nat.two_mul'], lean: ['unfold double\n\n   omega'] }];
    }))).toEqual([]);
    const truncated = { ...input, units: input.units.map(unit => ({ ...unit, externalTruncated: true })) };
    expect(informalizationWriterRejections(truncated, explain(truncated, sections => { sections[0]!.proof[0]!.uses = ['Nat.succ_le']; })))
      .toEqual([]);
  });

  it.each([
    ['a stale input digest', (o: InformalizationWriterOutput) => { o.inputDigest = '0'.repeat(64); }, 'inputDigest must equal INPUT.inputDigest'],
    ['reordered sections', (o: InformalizationWriterOutput) => { o.sections.reverse(); },
      'sections must explain exactly these declarations, in this order: double_eq, double_add_zero'],
    ['a theorem without steps', (o: InformalizationWriterOutput) => { o.sections[0]!.proof = []; }, 'double_eq: a theorem needs at least one proof step'],
    ['an invented citation', (o: InformalizationWriterOutput) => { o.sections[0]!.proof[0]!.uses = ['Nat.mul_comm']; },
      'double_eq step 1: Nat.mul_comm is not used by this declaration\'s Lean terms'],
    ['a tactic-internal citation', (o: InformalizationWriterOutput) => { o.sections[0]!.proof[0]!.uses = ['Lean.Omega.LinearCombo.eval']; },
      'double_eq step 1: Lean.Omega.LinearCombo.eval is not used by this declaration\'s Lean terms'],
    ['a paraphrased excerpt', (o: InformalizationWriterOutput) => { o.sections[0]!.proof[0]!.lean = ['simp [double]; ring']; },
      'double_eq step 1: lean excerpt is not verbatim text of this declaration: simp [double]; ring'],
    ['an excerpt from another declaration', (o: InformalizationWriterOutput) => { o.sections[0]!.proof[0]!.lean = ['rw [lib_fact]']; },
      'double_eq step 1: lean excerpt is not verbatim text of this declaration: rw [lib_fact]'],
    ['an uncited lemma application', (o: InformalizationWriterOutput) => { o.sections[1]!.proof[0]!.uses = ['double_eq']; },
      'double_add_zero: the Lean proof uses lib_fact; cite each in the step that uses it'],
    ['no overview in the final batch', (o: InformalizationWriterOutput) => { o.overview = null; }, 'overview is required in the final batch'],
    ['an extra key', (o: InformalizationWriterOutput) => { Object.assign(o, { confidence: 1 }); }, /^output: Unrecognized key/u],
  ])('rejects a writer output with %s', (_name, edit, problem) => {
    const input = writerInput(1), output = explain(input); edit(output);
    const problems = informalizationWriterRejections(input, output);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(typeof problem === 'string' ? new RegExp('^' + problem.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$', 'u') : problem);
  });

  it('requires a null overview before the final batch', () => {
    const input = writerInput(0);
    expect(informalizationWriterRejections(input, { ...explain(input), overview: 'Too early.' }))
      .toEqual(['overview must be null before the final batch']);
  });

  it('shows auditors the Lean proof and the explanation only', () => {
    const input = auditInput(1);
    expect(input).not.toHaveProperty('problemStatement');
    expect(input).not.toHaveProperty('feedback');
    expect(input.explanation.overview).toBe('Combine the lemmas into the target.');
    expect(informalizationAuditRejections(input, review(input))).toEqual([]);
    expect(informalizationAuditApproved(review(input))).toBe(true);
  });

  it.each([
    ['a missing step verdict', (o: InformalizationAuditOutput) => { o.sections[0]!.steps = []; }, 'double_eq: steps must have one verdict per explained step (1)'],
    ['an unexplained gap', (o: InformalizationAuditOutput) => { o.sections[1]!.steps[0]!.verdict = 'gap'; },
      'double_add_zero step 1: a gap verdict needs an explanation'],
    ['an unexplained mismatch', (o: InformalizationAuditOutput) => { o.sections[0]!.statement.verdict = 'mismatch'; },
      'double_eq: a mismatch statement verdict needs an explanation'],
    ['a paraphrased omission', (o: InformalizationAuditOutput) => { o.sections[0]!.omissions = [{ lean: 'induction n', explanation: 'Missing.' }]; },
      'double_eq: omission lean is not verbatim text of this declaration: induction n'],
    ['an absent overview verdict', (o: InformalizationAuditOutput) => { o.overview.verdict = 'absent'; }, 'overview verdict must be consistent or inconsistent'],
    ['an unexplained inconsistent overview', (o: InformalizationAuditOutput) => { o.overview.verdict = 'inconsistent'; },
      'an inconsistent overview verdict needs an explanation'],
  ])('rejects an audit with %s', (_name, edit, problem) => {
    const input = auditInput(1), output = review(input); edit(output);
    expect(informalizationAuditRejections(input, output)).toEqual([problem]);
  });

  it('approves only when every verdict approves, and attributes each finding to its auditor', () => {
    const input = auditInput(1);
    const gap = review(input, output => { output.sections[1]!.steps[0] = { verdict: 'gap', explanation: 'Why does n + 0 rewrite to n?' }; });
    const omission = review(input, output => { output.sections[0]!.omissions = [{ lean: 'omega', explanation: 'The arithmetic is not stated.' }]; });
    const mismatch = review(input, output => { output.sections[0]!.statement = { verdict: 'mismatch', explanation: 'Drops n.' }; });
    for (const output of [gap, omission, mismatch]) {
      expect(informalizationAuditRejections(input, output)).toEqual([]);
      expect(informalizationAuditApproved(output)).toBe(false);
    }
    const feedback = informalizationAuditFeedback([{ auditorId: 'auditor-1', output: gap }, { auditorId: 'auditor-2', output: omission }]);
    expect(feedback.split('\n').slice(1)).toEqual(['auditor-1, double_add_zero, step 1 gap: Why does n + 0 rewrite to n?',
      'auditor-2, double_eq, unexplained Lean "omega": The arithmetic is not stated.']);
  });

  it('publishes serializable role contracts', () => {
    for (const role of ['write', 'audit'] as const) {
      const schema = informalizationRoleOutputSchema(role);
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      expect(schema.title).toBe('TheoremOS informalization ' + role + ' OUTPUT.json');
    }
    expect(INFORMALIZATION_WRITER_INSTRUCTIONS).toContain('Cite every name in mustCite');
    expect(INFORMALIZATION_AUDITOR_INSTRUCTIONS).toContain('You are not given the informal problem');
    expect(INFORMALIZATION_AUDITOR_INSTRUCTIONS).toContain('their absence is not an omission');
  });
});

type GoalsReport = ReturnType<typeof informalizationGoalsReport>;
const goalResults = (edit?: (report: GoalsReport) => void): InformalizationGoalsResult[] => ['Lib', 'Proof'].map(module => {
  const report = informalizationGoalsReport(module); if (module === 'Proof') edit?.(report);
  return { module, report };
});
const withGoals = (results = goalResults(), base = outline) =>
  attachInformalizationGoals(base, results, { nonce: INFORMALIZATION_NONCE, sources: informalizationSources() });
const tacticsOf = (value: InformalizationOutline) => value.units.map(unit => unit.goals?.tactics.map(tactic => tactic.tactic));
// A tactic record of `double_add_zero` with this many codepoints of goal text in each of 4 printed goals.
const heavy = (snippet: string, size: number) => ({ range: sourceRange(PROOF_SOURCE, snippet), before: Array(4).fill('x'.repeat(size)),
  beforeCount: 4, after: [], afterCount: 0 });

describe('goal states', () => {
  it('binds the goals query to a host nonce and its own result file, and refuses unsafe names', () => {
    const { query, resultFile } = informalizationGoalsQuery({ nonce: INFORMALIZATION_NONCE, module: 'Proof', file: 'Proof.lean', index: 1 });
    expect(query.startsWith('import Lean\n')).toBe(true);
    expect(query).toContain(`namespace TheoremOSInformalizationGoals_${INFORMALIZATION_NONCE}`);
    expect(query).toContain(`#eval tosRun "${INFORMALIZATION_NONCE}" "Proof" "Proof.lean" "${resultFile}"`);
    expect(query).toContain('IO.Process.exit 0');
    expect(resultFile).toBe(`.lake/informalization-goals-${INFORMALIZATION_NONCE}-1.json`);
    for (const input of [{ nonce: 'NOT-HEX' }, { module: 'x" #eval 1' }, { file: '/abs/Proof.lean' }, { file: 'Sub/../Proof.lean' },
      { file: 'Proof".lean' }, { file: 'Proof.olean' }, { index: -1 }, { index: 1.5 }])
      expect(() => informalizationGoalsQuery({ nonce: INFORMALIZATION_NONCE, module: 'Proof', file: 'Proof.lean', index: 0, ...input }))
        .toThrow(/informalization_extraction_(?:nonce|name)_invalid/u);
  });

  it('attaches each tactic to the declaration that contains it and drops tactics outside every declaration', () => {
    const attached = withGoals();
    expect(attached.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'complete' });
    expect(tacticsOf(attached)).toEqual([[], [], ['unfold double', 'omega'], ['rw [lib_fact]', 'exact double_eq n']]);
    expect(attached.units[3]!.goals).toEqual({ truncated: false, tactics: [
      { range: { line: 11, column: 2, endLine: 11, endColumn: 15 }, tactic: 'rw [lib_fact]', before: ['n : Nat\n⊢ double (n + 0) = 2 * n'],
        beforeCount: 1, after: ['n : Nat\n⊢ double n = 2 * n'], afterCount: 1 },
      { range: { line: 12, column: 2, endLine: 12, endColumn: 19 }, tactic: 'exact double_eq n', before: ['n : Nat\n⊢ double n = 2 * n'],
        beforeCount: 1, after: [], afterCount: 0 }] });
    expect(outline.units.some(unit => 'goals' in unit)).toBe(false);
    expect(outline).not.toHaveProperty('goalStates');
  });

  it('prefers the smallest enclosing declaration', () => {
    // A widened target that also covers double_eq, listed before it.
    const nested = { ...outline, units: outline.units.map(unit => unit.name !== 'double_add_zero' ? unit :
      { ...unit, range: { ...unit.range, line: 6, column: 0 } }).reverse() };
    expect(tacticsOf(withGoals(goalResults(), nested))).toEqual([['rw [lib_fact]', 'exact double_eq n'], ['unfold double', 'omega'], [], []]);
  });

  it('keeps one entry per range, in source order', () => {
    const attached = withGoals(goalResults(report => {
      report.tactics.push({ ...report.tactics[2]!, before: ['case dup\nn : Nat\n⊢ n + n = 2 * n'] });
      report.tactics.reverse();
    }));
    expect(tacticsOf(attached)[2]).toEqual(['unfold double', 'omega']);
    expect(attached.units[2]!.goals!.tactics[1]!.before).toEqual(['case dup\nn : Nat\n⊢ n + n = 2 * n']);
  });
  it('names a tactic by its first line, clipped to 200 codepoints', () => {
    const long = 'exact ' + '𝔽'.repeat(300);
    const text = `theorem big (n : Nat) : n = n := by\n  ${long}\n`;
    const report = { nonce: INFORMALIZATION_NONCE, target: 'big', axioms: [], library: [], libraryTruncated: false,
      units: [{ name: 'big', displayName: 'big', kind: 'theorem', module: 'Big', range: sourceRange(text, text.trimEnd()),
        signature: 'big (n : Nat) : n = n', statementDependencies: [], proofDependencies: [], external: [], externalTruncated: false }] };
    const sources = [{ module: 'Big', file: 'Big.lean', text }];
    const big = informalizationOutline(report, { nonce: INFORMALIZATION_NONCE, target: 'big', sources });
    const attached = attachInformalizationGoals(big, [{ module: 'Big', report: { nonce: INFORMALIZATION_NONCE, module: 'Big', truncated: false,
      tactics: [{ range: sourceRange(text, long), before: [], beforeCount: 0, after: [], afterCount: 0 }] } }], { nonce: INFORMALIZATION_NONCE, sources });
    expect(attached.units[0]!.goals!.tactics[0]!.tactic).toBe('exact ' + '𝔽'.repeat(194) + ' …');
    const multiline = withGoals(goalResults(report => {
      report.tactics.push({ ...report.tactics[1]!, range: sourceRange(PROOF_SOURCE, 'unfold double\n  omega') });
    }));
    expect(tacticsOf(multiline)[2]).toEqual(['unfold double', 'unfold double', 'omega']);
  });

  it('drops nested tactics before outer ones when a declaration exceeds its budget', () => {
    // Each record is about 16 KB, so two of the three fit in 48 KB; the nested rewrite rule goes, though it precedes `exact`.
    const attached = withGoals(goalResults(report => {
      report.tactics = [heavy('rw [lib_fact]', 4000), heavy('lib_fact]', 4000), heavy('exact double_eq n', 4000)];
      report.tactics[1]!.range.endColumn -= 1;
    }));
    expect(attached.units[3]!.goals!.tactics.map(tactic => tactic.tactic)).toEqual(['rw [lib_fact]', 'exact double_eq n']);
    expect(attached.units[3]!.goals!.truncated).toBe(true);
    expect(attached.units[2]!.goals).toEqual({ truncated: false, tactics: [] });
    expect(attached.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'truncated' });
  });

  it.each([
    ['a goal count that disagrees with the printed goals', (r: GoalsReport) => { r.tactics[1]!.beforeCount = 2; }],
    ['a range past the line', (r: GoalsReport) => { r.tactics[2]!.range.endColumn = 500; }],
    ['another module', (r: GoalsReport) => { r.module = 'Lib'; }],
    ['another nonce', (r: GoalsReport) => { r.nonce = 'f'.repeat(32); }],
    ['an extra key', (r: GoalsReport) => { Object.assign(r.tactics[1]!, { kind: 'unfold' }); }],
    ['more than 4 printed goals', (r: GoalsReport) => { r.tactics[1]!.before = Array(5).fill('⊢ True'); r.tactics[1]!.beforeCount = 5; }],
  ])('drops the goals of a file whose report has %s', (_name, edit) => {
    const attached = withGoals(goalResults(edit));
    expect(attached.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'truncated', reason: 'Proof: informalization_goals_report_invalid' });
    expect(attached.units.map(unit => unit.goals)).toEqual([{ truncated: false, tactics: [] }, undefined, undefined, undefined]);
  });

  it('marks goal states unavailable when no file has them, with each reason', () => {
    const attached = withGoals([{ module: 'Proof', failure: 'informalization_goals_timeout' }]);
    expect(attached.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'unavailable',
      reason: 'Lib: informalization_goals_not_run\nProof: informalization_goals_timeout' });
    expect(attached.units).toEqual(outline.units);
    const astral = withGoals(['Lib', 'Proof'].map(module => ({ module, failure: '𝕜'.repeat(3000) })));
    expect([...astral.goalStates!.reason!]).toHaveLength(4000);
    expect(informalizationOutlineSchema.parse(astral)).toEqual(astral);
  });

  it('marks the units of a file whose query stopped early', () => {
    const attached = withGoals(goalResults(report => { report.truncated = true; }));
    expect(attached.goalStates).toEqual({ protocol: 'lean-tactic-goals-v1', status: 'truncated' });
    expect(attached.units.map(unit => unit.goals!.truncated)).toEqual([false, true, true, true]);
  });

  it('gives both roles the recorded goals and leaves inputs without goals unchanged', () => {
    const attached = withGoals(), batch = batchesOf()[1]!, sources = informalizationSources();
    const context = { batch, accepted: new Map(), sources, language: 'zh' as const };
    const writer = informalizationWriterInput({ ...context, outline: attached, round: 1, problemStatement: 'Show that double (n + 0) is 2n.',
      feedback: null, previousOutput: null });
    expect(writer.units.map(unit => unit.goals?.tactics.map(tactic => tactic.tactic))).toEqual([['unfold double', 'omega'],
      ['rw [lib_fact]', 'exact double_eq n']]);
    expect(informalizationWriterRejections(writer, explain(writer))).toEqual([]);
    const audit = informalizationAuditInput({ ...context, outline: attached, explanation: explain(writer) });
    expect(audit.units[1]!.goals).toEqual(attached.units[3]!.goals);
    expect(writerInput(1).units.some(unit => 'goals' in unit)).toBe(false);
    const unavailable = withGoals([]);
    expect(informalizationWriterInput({ ...context, outline: unavailable, round: 1, problemStatement: 'Show that double (n + 0) is 2n.',
      feedback: null, previousOutput: null }).inputDigest).toBe(writerInput(1).inputDigest);
  });
});

// Phrase alignment: a writer that links each theorem's binder and each step's last tactic line to its prose.
type AlignedSection = InformalizationAlignedSection;
const signatureBinder = (signature: string) => signature.slice(signature.indexOf('('), signature.indexOf(')') + 1);
function alignedExplain(input: InformalizationWriterInput, edit?: (sections: AlignedSection[]) => void) {
  const base = explain(input), sections = base.sections.map((section, index): AlignedSection => {
    const unit = input.units[index]!, binder = signatureBinder(unit.signature), last = unit.source.split('\n').at(-1)!.trim();
    return { ...section, statement: 'For every ' + binder + ': ' + section.statement,
      statementLinks: [{ text: binder, lean: unit.kind === 'theorem' ? binder : unit.signature }],
      proof: section.proof.map(step => ({ ...step, text: step.text + ' It ends with ' + last + '.', links: [{ text: last, lean: last }] })) };
  });
  edit?.(sections);
  return { ...base, sections };
}
const alignedWriterInput = (index: number, base = outline) => informalizationWriterInput({ outline: base, batch: batchesOf()[index]!,
  accepted: new Map(), sources: informalizationSources(), language: 'zh', alignment: INFORMALIZATION_ALIGNMENT, round: 1,
  problemStatement: 'Show that double (n + 0) is 2n.', feedback: null, previousOutput: null });
const alignedAuditInput = (index: number, base = outline, explanation = alignedExplain(alignedWriterInput(index, base))) =>
  informalizationAuditInput({ outline: base, batch: batchesOf()[index]!, accepted: new Map(), sources: informalizationSources(),
    language: 'zh', alignment: INFORMALIZATION_ALIGNMENT, explanation });
// An aligned audit that approves everything and says each step agrees with its recorded goals.
function alignedReview(input: InformalizationAuditInput, edit?: (output: InformalizationAlignedAuditOutput) => void) {
  const base = review(input), output: InformalizationAlignedAuditOutput = { ...base, sections: base.sections.map((section, index) => ({
    ...section, steps: section.steps.map((step, stepIndex) => ({ ...step,
      goals: input.stepGoals?.[index]?.steps[stepIndex] ? 'consistent' as const : 'unrecorded' as const })) })) };
  edit?.(output);
  return output;
}
const exactly = (problem: string) => new RegExp('^' + problem.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$', 'u');

describe('phrase alignment', () => {
  it('accepts links verbatim on both sides, inside the signature or the step\'s own excerpts, modulo Lean whitespace', () => {
    for (const index of [0, 1]) {
      const input = alignedWriterInput(index);
      expect(input.alignment).toBe(INFORMALIZATION_ALIGNMENT);
      expect(informalizationWriterRejections(input, alignedExplain(input))).toEqual([]);
    }
    const input = alignedWriterInput(1);
    expect(informalizationWriterRejections(input, alignedExplain(input, sections => {
      sections[0]!.proof = [{ text: 'Unfold double, then omega closes n + n = 2 * n.', uses: ['double', 'Nat.two_mul'],
        lean: ['unfold double\n  omega'], links: [{ text: 'omega closes n + n = 2 * n', lean: 'double\n\n   omega' }] }];
    }))).toEqual([]);
  });

  it.each([
    ['a paraphrased phrase', (s: AlignedSection[]) => { s[0]!.statementLinks[0]!.text = '(n : ℕ)'; },
      'double_eq statement: link text is not verbatim text of it: (n : ℕ)'],
    ['a statement link into the proof', (s: AlignedSection[]) => { s[0]!.statementLinks[0]!.lean = 'unfold double'; },
      'double_eq statement: link lean is not verbatim text of the Lean it explains: unfold double'],
    ['a theorem statement without links', (s: AlignedSection[]) => { s[1]!.statementLinks = []; },
      'double_add_zero statement: link at least one phrase to the Lean signature'],
    ['a step link outside its own excerpts', (s: AlignedSection[]) => {
      s[0]!.proof = [{ text: 'Unfold double.', uses: ['double'], lean: ['unfold double'], links: [{ text: 'Unfold double', lean: 'unfold double' }] },
        { text: 'Then omega.', uses: ['Nat.two_mul'], lean: ['omega'], links: [{ text: 'omega', lean: 'unfold double' }] }];
    }, 'double_eq step 2: link lean is not verbatim text of the Lean it explains: unfold double'],
    ['a step phrase from another step', (s: AlignedSection[]) => { s[1]!.proof[0]!.links[0]!.text = 'Follow the Lean proof of double_eq'; },
      'double_add_zero step 1: link text is not verbatim text of it: Follow the Lean proof of double_eq'],
  ])('rejects a linked explanation with %s', (_name, edit, problem) => {
    const input = alignedWriterInput(1), problems = informalizationWriterRejections(input, alignedExplain(input, edit));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(exactly(problem));
  });

  it('requires links exactly when the request opts in, and leaves unaligned inputs unchanged', () => {
    const aligned = alignedWriterInput(1), plain = writerInput(1);
    expect(informalizationWriterRejections(aligned, explain(aligned)))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^sections\.0\.statementLinks: /u), expect.stringMatching(/^sections\.0\.proof\.0\.links: /u)]));
    expect(informalizationWriterRejections(plain, alignedExplain(plain)))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^sections\.0: Unrecognized key/u)]));
    expect(plain).not.toHaveProperty('alignment');
    expect(aligned.inputDigest).not.toBe(plain.inputDigest);
    expect(auditInput(1)).not.toHaveProperty('stepGoals');
    expect(auditInput(1)).not.toHaveProperty('alignment');
  });
  it('gives auditors the goals the page shows beside each step and checks the goals verdict against them', () => {
    const attached = withGoals(), input = alignedAuditInput(1, attached);
    const goal = (target: string) => 'n : Nat\n⊢ ' + target;
    expect(input.stepGoals).toEqual([
      { declaration: 'double_eq', steps: [{ before: [goal('double n = 2 * n')], beforeCount: 1, after: [], afterCount: 0, lines: { start: 7, end: 8 } }] },
      { declaration: 'double_add_zero', steps: [{ before: [goal('double (n + 0) = 2 * n')], beforeCount: 1, after: [], afterCount: 0,
        lines: { start: 11, end: 12 } }] }]);
    expect(informalizationAuditRejections(input, alignedReview(input))).toEqual([]);
    expect(informalizationAuditApproved(alignedReview(input))).toBe(true);
    expect(alignedAuditInput(1).stepGoals!.map(section => section.steps)).toEqual([[null], [null]]);
    const plain = alignedAuditInput(1);
    expect(informalizationAuditRejections(plain, alignedReview(plain))).toEqual([]);
  });

  it.each([
    ['unrecorded goals that were recorded', withGoals(), (o: InformalizationAlignedAuditOutput) => { o.sections[0]!.steps[0]!.goals = 'unrecorded'; },
      'double_eq step 1: goals must be consistent or inconsistent'],
    ['a goals verdict where none were recorded', outline, (o: InformalizationAlignedAuditOutput) => { o.sections[1]!.steps[0]!.goals = 'consistent'; },
      'double_add_zero step 1: goals must be unrecorded'],
    ['unexplained inconsistent goals', withGoals(), (o: InformalizationAlignedAuditOutput) => { o.sections[1]!.steps[0]!.goals = 'inconsistent'; },
      'double_add_zero step 1: inconsistent goals need an explanation'],
  ])('rejects an aligned audit with %s', (_name, base, edit, problem) => {
    const input = alignedAuditInput(1, base);
    expect(informalizationAuditRejections(input, alignedReview(input, edit))).toEqual([problem]);
    const missing = alignedReview(input, output => { Reflect.deleteProperty(output.sections[0]!.steps[0]!, 'goals'); });
    expect(informalizationAuditRejections(input, missing)).toEqual([expect.stringMatching(/^sections\.0\.steps\.0\.goals: /u)]);
  });

  it('withholds approval on inconsistent goals and tells the writer which step disagrees', () => {
    const input = alignedAuditInput(1, withGoals());
    const goals = alignedReview(input, output => {
      output.sections[1]!.steps[0] = { verdict: 'justified', goals: 'inconsistent', explanation: 'The recorded goal is double (n + 0) = 2 * n, not n + 0 = n.' };
    });
    const both = alignedReview(input, output => {
      output.sections[0]!.steps[0] = { verdict: 'gap', goals: 'inconsistent', explanation: 'omega closes n + n = 2 * n, which the step never states.' };
    });
    for (const output of [goals, both]) {
      expect(informalizationAuditRejections(input, output)).toEqual([]);
      expect(informalizationAuditApproved(output)).toBe(false);
    }
    expect(informalizationAuditFeedback([{ auditorId: 'auditor-1', output: goals }, { auditorId: 'auditor-2', output: both }]).split('\n').slice(1)).toEqual([
      'auditor-1, double_add_zero, step 1 goals inconsistent: The recorded goal is double (n + 0) = 2 * n, not n + 0 = n.',
      'auditor-2, double_eq, step 1 gap, goals inconsistent: omega closes n + n = 2 * n, which the step never states.']);
  });
  it('adds the alignment rules and fields only to aligned role contracts', () => {
    const extra = { write: 3, audit: 2 } as const;
    for (const role of ['write', 'audit'] as const) {
      const plain = informalizationRoleInstructions(role), aligned = informalizationRoleInstructions(role, INFORMALIZATION_ALIGNMENT);
      expect(plain).toBe(role === 'write' ? INFORMALIZATION_WRITER_INSTRUCTIONS : INFORMALIZATION_AUDITOR_INSTRUCTIONS);
      expect(plain).not.toContain(INFORMALIZATION_ALIGNMENT);
      const added = aligned.split('\n').filter(line => !plain.split('\n').includes(line));
      expect(added).toHaveLength(extra[role]);
      expect(added[0]).toMatch(/^INPUT\.alignment is lean-phrase-alignment-v1: /u);
      expect(aligned.split('\n').filter(line => !added.includes(line)).join('\n')).toBe(plain);
      const field = role === 'write' ? 'statementLinks' : 'unrecorded';
      const schema = informalizationRoleOutputSchema(role, INFORMALIZATION_ALIGNMENT);
      expect(JSON.parse(JSON.stringify(schema))).toEqual(schema);
      expect(JSON.stringify(schema)).toContain(field);
      expect(schema.$comment).toContain('both sides of each link are verbatim');
      expect(JSON.stringify(informalizationRoleOutputSchema(role))).not.toContain(field);
    }
  });
});
const provenance = { sources: [{ origin: 'Lib.lean', sha256: 'a'.repeat(64) }, { origin: 'Proof.lean', sha256: 'b'.repeat(64) }],
  toolchain: 'leanprover/lean4:v4.33.0', mathlibRevision: null };
const allSections = () => batchesOf().flatMap((_batch, index) => explain(writerInput(index)).sections);

describe('rendering', () => {
  it('writes definitions first, numbered lemmas in dependency order and the main proof last', () => {
    const markdown = renderInformalization({ language: 'zh', outline, sections: allSections(), overview: 'Combine.', provenance });
    const headings = markdown.split('\n').filter(line => line.startsWith('#'));
    expect(headings).toEqual(['# 证明：double_add_zero', '## 主定理：T double_add_zero', '## 证明思路', '## 定义与引理',
      '### 定义 1：T double', '### 引理 2：T lib_fact', '### 引理 3：T double_eq', '## 主定理的证明']);
    expect(markdown).toContain('1. Follow the Lean proof of double_add_zero.\n\n   *依据*：引理 3 `double_eq`，引理 2 `lib_fact`');
    expect(markdown).toContain('   ```lean\n   theorem double_eq (n : Nat) : double n = 2 * n := by\n     unfold double\n     omega\n   ```');
    expect(markdown).toContain('Lean：`theorem lib_fact (n : Nat) : n + 0 = n := rfl`');
    expect(markdown).toContain('> 本文由模型根据 Lean 证明自动撰写');
    expect(markdown.trimEnd().split('\n').slice(-2)).toEqual([
      `来源：\`Lib.lean\` (sha256 ${'a'.repeat(64)})，\`Proof.lean\` (sha256 ${'b'.repeat(64)})，Lean leanprover/lean4:v4.33.0。`,
      '使用的公理：`propext`。']);
  });

  it('renders English and keeps code fences longer than any backtick run in the Lean text', () => {
    const sections = allSections();
    sections[1]!.proof = [{ text: 'A note.', uses: [], lean: ['n + n'] }];
    sections[0]!.proof[0]!.lean = ['a `b` c', 'x\n```\ny'];
    const markdown = renderInformalization({ language: 'en', outline, sections, overview: 'Combine.',
      provenance: { ...provenance, mathlibRevision: 'db584cd6d46c92f209a44c0f1c829460d327499d' } });
    expect(markdown).toContain('# Proof of double_add_zero');
    expect(markdown).toContain('### Definition 1: T double');
    expect(markdown).toContain('**Notes**\n\n1. A note.');
    expect(markdown).toContain('Lean: `` a `b` c ``');
    expect(markdown).toContain('   ````lean\n   x\n   ```\n   y\n   ````');
    expect(markdown).toContain(', Mathlib db584cd6d46c92f209a44c0f1c829460d327499d.');
  });

  it('refuses sections that do not match the outline and measures quoted source', () => {
    expect(() => renderInformalization({ language: 'zh', outline, sections: allSections().slice(1), overview: 'x', provenance }))
      .toThrow('informalization_render_sections_invalid');
    // Three theorems are quoted whole; the definition has no steps.
    const coverage = informalizationExcerptCoverage(outline.units, allSections());
    expect(coverage).toBeGreaterThan(0.6); expect(coverage).toBeLessThan(1);
    const sections = allSections().map(section => ({ ...section, proof: section.proof.map(step => ({ ...step, lean: ['n'] })) }));
    expect(informalizationExcerptCoverage(outline.units, sections)).toBeLessThan(0.1);
  });
});

describe('preparation', () => {
  it('freezes the project-local import closure with digests, the root last', () => {
    const f = informalizationFixture(roots), request = f.prepare();
    expect(request.sources).toEqual([
      { module: 'Lib', file: 'Lib.lean', origin: 'Lib.lean', sha256: mathDigest(LIB_SOURCE), bytes: Buffer.byteLength(LIB_SOURCE) },
      { module: 'Proof', file: 'Proof.lean', origin: 'Proof.lean', sha256: mathDigest(PROOF_SOURCE), bytes: Buffer.byteLength(PROOF_SOURCE) }]);
    expect(request).toMatchObject({ rootModule: 'Proof', environment: 'standard', mathlibRevision: null,
      statementSha256: mathDigest('Show that double (n + 0) is 2n.') });
    for (const file of ['request.json', 'sources/Lib.lean', 'sources/Proof.lean'])
      expect(fs.statSync(path.join(f.directory, file)).mode & 0o777).toBe(0o400);
    expect(readInformalizationRequest(f.directory).sources).toEqual(informalizationSources());
    // The source project is not read again.
    fs.writeFileSync(path.join(f.project, 'Lib.lean'), 'theorem changed : True := trivial\n');
    expect(readInformalizationRequest(f.directory).sources[0]!.text).toBe(LIB_SOURCE);
    const frozen = path.join(f.directory, 'sources/Lib.lean');
    fs.chmodSync(frozen, 0o600); fs.appendFileSync(frozen, '\n');
    expect(() => readInformalizationRequest(f.directory)).toThrow('informalization_source_changed: Lib.lean');
    expect(() => f.prepare()).toThrow('informalization_directory_exists');
  });

  it.each([
    ['a module-system file', { 'Lib.lean': LIB_SOURCE, 'Proof.lean': 'module\n\n' + PROOF_SOURCE }, undefined,
      'informalization_module_system_unsupported: Proof.lean'],
    ['an excluded path', { 'Lib.lean': LIB_SOURCE, 'test/Proof.lean': PROOF_SOURCE }, 'test/Proof.lean', 'informalization_source_excluded: test/Proof.lean'],
    ['a proof outside the project', { 'Lib.lean': LIB_SOURCE, 'Proof.lean': PROOF_SOURCE }, '../Outside.lean', 'informalization_proof_outside_project'],
  ])('refuses %s', (_name, files, proofFile, error) => {
    const f = informalizationFixture(roots, {}, files);
    if (proofFile) {
      f.preparation.proofFile = path.join(f.project, proofFile);
      if (!fs.existsSync(f.preparation.proofFile)) fs.writeFileSync(f.preparation.proofFile, PROOF_SOURCE);
    }
    expect(() => f.prepare()).toThrow(error);
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('refuses repeated auditor ids', () => {
    const auditor = { model: 'preset-informalization', effort: 'none', profile: '/preset-only', executable: '/no-model', id: 'same' };
    const f = informalizationFixture(roots, { auditors: [auditor, { ...auditor }] });
    expect(() => f.prepare()).toThrow('informalization_auditor_id_duplicate');
    expect(fs.existsSync(f.directory)).toBe(false);
  });
});

describe('informalization runner', () => {
  it('approves batch by batch with blind auditors and publishes a re-verifiable proof', async () => {
    const r = runner(), agent = presetAgent();
    const result = await r.run(agent);
    expect(result).toMatchObject({ status: 'approved', batches: 2, approvedBatches: 2, rounds: 2, modelInvoked: true,
      proof: path.join(r.directory, 'artifact', 'proof.md') });
    expect(forbidden.model).not.toHaveBeenCalled();
    expect(r.extract).toHaveBeenCalledTimes(1);
    const key = (call: Call) => [call.batch, call.role, call.auditorId ?? ''].join(':');
    expect(agent.calls.map(key).toSorted()).toEqual(['0:audit:auditor-1', '0:audit:auditor-2', '0:write:', '1:audit:auditor-1',
      '1:audit:auditor-2', '1:write:']);
    const [write0, write1] = agent.calls.filter(call => call.role === 'write');
    expect(write0!.input).toMatchObject({ problemStatement: 'Show that double (n + 0) is 2n.', feedback: null, previousOutput: null,
      batch: { index: 0, count: 2, final: false } });
    expect(write1!.input.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ declaration: 'lib_fact', title: 'T lib_fact' })]));
    const audits = agent.calls.filter(call => call.role === 'audit' && call.batch === 1);
    expect(new Set(audits.map(call => call.input.inputDigest)).size).toBe(1);
    for (const call of audits) {
      expect(call.input).not.toHaveProperty('problemStatement');
      expect(readMathText(path.join(call.workspace, 'proof/Proof.lean'))).toBe(PROOF_SOURCE);
      expect(call.options).toMatchObject({ readIsolation: { environment: 'standard' }, model: 'preset-informalization' });
    }
    // The host check also runs inside the turn and steers the role once.
    const validate = write1!.options.completedOutput!;
    expect(() => validate.validate(explain(write1!.input as unknown as InformalizationWriterInput))).not.toThrow();
    let rejected: unknown;
    try { validate.validate({ ...explain(write1!.input as unknown as InformalizationWriterInput), overview: null }); } catch (error) { rejected = error; }
    expect(validate.validationFeedback!(rejected)).toContain('overview is required in the final batch');

    const evidence = readInformalizationArtifact(path.join(r.directory, 'artifact'));
    expect(evidence).toMatchObject({ status: 'approved', authority: 'model', proofCompiledByHost: true, humanReviewed: false,
      target: 'double_add_zero', metrics: { declarations: 4, steps: 3, citations: 2 } });
    expect(evidence.sessions).toHaveLength(6);
    const markdown = readMathText(result.proof!);
    expect(markdown).toContain('## 主定理的证明\n\n1. Follow the Lean proof of double_add_zero.');
    expect(markdown).toContain(`\`Lib.lean\` (sha256 ${mathDigest(LIB_SOURCE)})`);
    expect(readInformalizationState(r.directory)).toMatchObject({ status: 'approved' });

    // An approved run only re-verifies its artifact.
    const idle = presetAgent({ write: () => { throw new Error('must not run'); } });
    expect(await r.run(idle)).toMatchObject({ status: 'approved', rounds: 2 });
    expect(idle.calls).toHaveLength(0);
    const inspect = async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try { return { code: await informalize(['--phase', 'inspect', '--directory', r.directory]), report: JSON.parse(String(log.mock.calls.at(-1)?.[0])) }; }
      finally { log.mockRestore(); }
    };
    expect(await inspect()).toMatchObject({ code: 0, report: { modelInvoked: false,
      state: { present: true, status: 'approved', sessionCount: 6, batches: [{ index: 0, status: 'approved', rounds: 1, declarations: 2 },
        { index: 1, status: 'approved', rounds: 1, declarations: 2 }] },
      artifact: { status: 'approved', valid: true, proof: result.proof, humanReviewed: false, proofCompiledByHost: true,
        axioms: ['propext'], metrics: { declarations: 4, steps: 3, citations: 2 } } } });

    type Evidence = { batches: { writer: InformalizationWriterOutput; audits: { output: InformalizationAuditOutput }[] }[] };
    const tamper = (edit: (value: Evidence) => void) => {
      const value = structuredClone(evidence) as unknown as Evidence; edit(value);
      return () => assertInformalizationEvidence(value);
    };
    expect(tamper(value => { value.batches[1]!.writer.sections[1]!.proof[0]!.text = 'Another argument.'; })).toThrow('informalization_evidence_invalid');
    expect(tamper(value => { value.batches[1]!.audits[0]!.output.sections[1]!.steps[0]!.verdict = 'gap'; })).toThrow('informalization_evidence_invalid');
    expect(tamper(value => { value.batches[1]!.writer.sections[1]!.proof[0]!.uses = []; })).toThrow('informalization_evidence_invalid');
    fs.chmodSync(result.proof!, 0o600); fs.appendFileSync(result.proof!, '\nAdded.\n');
    expect(() => readInformalizationArtifact(path.join(r.directory, 'artifact'))).toThrow('informalization_artifact_changed');
    expect(await inspect()).toMatchObject({ code: 2, report: { artifact: { status: 'invalid', valid: false,
      error: expect.stringContaining('informalization_artifact_changed') } } });
  });

  it('returns host rejections to the writer as feedback for the next round', async () => {
    const r = runner(), agent = presetAgent({ write: (input, count) => count === 1 ? undefined :
      count === 3 ? explain(input, sections => { sections[1]!.proof[0]!.uses = ['lib_fact']; }) : explain(input) });
    expect(await r.run(agent)).toMatchObject({ status: 'approved', approvedBatches: 2, rounds: 4 });
    const writes = agent.calls.filter(call => call.role === 'write');
    expect(writes.map(call => [call.batch, call.round])).toEqual([[0, 1], [0, 2], [1, 1], [1, 2]]);
    expect(writes[1]!.input.feedback).toContain('OUTPUT.json was not written as complete JSON');
    expect(writes[1]!.input.previousOutput).toBeNull();
    expect(writes[3]!.input.feedback).toContain('double_add_zero: the Lean proof uses double_eq; cite each in the step that uses it');
    expect((writes[3]!.input.previousOutput as InformalizationWriterOutput).sections[1]!.proof[0]!.uses).toEqual(['lib_fact']);
    // Rejected outputs are not audited.
    expect(agent.calls.filter(call => call.role === 'audit')).toHaveLength(4);
  });

  it('sends audit findings back, attributed, and re-audits the revision from scratch', async () => {
    const r = runner(), agent = presetAgent({ audit: (input, auditorId, count) => auditorId === 'auditor-2' && count === 2 ?
      review(input, output => { output.sections[1]!.steps[0] = { verdict: 'gap', explanation: 'Where is n + 0 = n used?' }; }) : review(input) });
    expect(await r.run(agent)).toMatchObject({ status: 'approved', rounds: 3 });
    const writes = agent.calls.filter(call => call.role === 'write');
    expect(writes.map(call => [call.batch, call.round])).toEqual([[0, 1], [1, 1], [1, 2]]);
    expect(writes[2]!.input.feedback).toContain('auditor-2, double_add_zero, step 1 gap: Where is n + 0 = n used?');
    expect(writes[2]!.input.previousOutput).toEqual(explain(writes[1]!.input as unknown as InformalizationWriterInput));
    const reaudit = agent.calls.filter(call => call.role === 'audit' && call.round === 2);
    expect(reaudit).toHaveLength(2);
    for (const call of reaudit) expect(JSON.stringify(call.input)).not.toContain('Where is n + 0 = n used?');
    expect(readInformalizationState(r.directory)!.batches.map(batch => [batch.status, batch.rounds, batch.feedback]))
      .toEqual([['approved', 1, undefined], ['approved', 2, undefined]]);
  });

  it('stops as exhausted when a finding survives every round', async () => {
    const r = runner(), agent = presetAgent({ audit: (input, auditorId) => auditorId === 'auditor-1' && input.batch.index === 0 ?
      review(input, output => { output.sections[0]!.omissions = [{ lean: 'rfl', explanation: 'Say why n + 0 is n by definition.' }]; }) : review(input) });
    const result = await r.run(agent);
    expect(result).toMatchObject({ status: 'exhausted', approvedBatches: 0, rounds: 3 });
    expect(result.error).toMatch(/^informalization_rounds_exhausted: batch 1\/2 \(lib_fact, double\)\nIndependent auditors/u);
    expect(result.error).toContain('auditor-1, lib_fact, unexplained Lean "rfl": Say why n + 0 is n by definition.');
    expect(agent.calls.filter(call => call.role === 'write').map(call => call.round)).toEqual([1, 2, 3]);
    expect(fs.existsSync(path.join(r.directory, 'artifact'))).toBe(false);
    // Resuming an exhausted run does not dispatch again.
    const idle = presetAgent();
    expect(await r.run(idle)).toMatchObject({ status: 'exhausted', rounds: 3 });
    expect(idle.calls).toHaveLength(0);
  });

  it('stops on a non-retryable role failure and resumes from every closed role', async () => {
    const r = runner(), failing = presetAgent({ diagnostic: (call, count) =>
      call.auditorId === 'auditor-2' && count === 2 ? { code: 'other' } : undefined });
    const stopped = await r.run(failing);
    expect(stopped).toMatchObject({ status: 'stopped', approvedBatches: 1, rounds: 2 });
    expect(stopped.error).toMatch(/^informalization_role_incomplete:failed:other/u);
    const resumed = presetAgent(), events: string[] = [];
    expect(await r.run(resumed, { onEvent: event => events.push([event.event, event.role, event.batch].join(':')) }))
      .toMatchObject({ status: 'approved', approvedBatches: 2, rounds: 2 });
    expect(resumed.calls.map(call => [call.batch, call.role, call.auditorId])).toEqual([[1, 'audit', 'auditor-2']]);
    expect(resumed.calls[0]!.workspace).toMatch(/\/batches\/1\/round-1\/retry-[0-9a-f-]+\/audit-auditor-2-1$/u);
    expect(events).toEqual(expect.arrayContaining(['informalization_role_restored:write:1', 'informalization_role_restored:audit:1']));
    expect(events).not.toContain('informalization_extraction_started::');
    expect(r.extract).toHaveBeenCalledTimes(1);
  });

  it('retries a retryable provider failure in a fresh workspace without spending a round', async () => {
    const r = runner(), waitForRetry = vi.fn(async (_ms: number, signal: AbortSignal) => { signal.throwIfAborted(); });
    const agent = presetAgent({ diagnostic: (call, count) => call.role === 'write' && count === 1 ? { code: 'serverOverloaded' } : undefined });
    expect(await r.run(agent, { waitForRetry })).toMatchObject({ status: 'approved', rounds: 2 });
    expect(waitForRetry).toHaveBeenCalledTimes(1);
    expect(waitForRetry.mock.calls[0]![0]).toBeGreaterThan(0);
    const writes = agent.calls.filter(call => call.role === 'write');
    expect(writes.map(call => [call.batch, call.round])).toEqual([[0, 1], [0, 1], [1, 1]]);
    expect(writes[1]!.workspace).toMatch(/\/batches\/0\/round-1\/retry-[0-9a-f-]+\/write$/u);
    expect(readInformalizationState(r.directory)!.error).toBeUndefined();
  });

  it('stops when an auditor writes no valid audit in three attempts', async () => {
    const r = runner(), agent = presetAgent({ audit: (input, auditorId) =>
      auditorId === 'auditor-1' ? { ...review(input), inputDigest: '0'.repeat(64) } : review(input) });
    const result = await r.run(agent);
    expect(result).toMatchObject({ status: 'stopped', approvedBatches: 0, rounds: 1,
      error: 'informalization_audit_invalid: auditor-1 wrote no valid audit in 3 attempts' });
    expect(agent.calls.filter(call => call.auditorId === 'auditor-1').map(call => path.basename(call.workspace)))
      .toEqual(['audit-auditor-1-1', 'audit-auditor-1-2', 'audit-auditor-1-3']);
    expect(agent.calls.filter(call => call.auditorId === 'auditor-2')).toHaveLength(1);
  });

  it('stops before any model call when the proof does not extract, and extracts again on resume', async () => {
    const r = runner(), agent = presetAgent();
    r.extract.mockRejectedValueOnce(new Error('informalization_proof_does_not_compile: Proof.lean: 9:2: unsolved goals'));
    expect(await r.run(agent)).toMatchObject({ status: 'stopped', modelInvoked: false, rounds: 0,
      error: 'informalization_proof_does_not_compile: Proof.lean: 9:2: unsolved goals' });
    expect(agent.calls).toHaveLength(0);
    const [directory, request, sources] = r.extract.mock.calls[0]!;
    expect(path.dirname(directory)).toBe(r.directory);
    expect(path.basename(directory)).toMatch(/^extraction-[0-9a-f-]+$/u);
    expect(request).toMatchObject({ target: 'double_add_zero', rootModule: 'Proof' });
    expect(sources).toEqual(informalizationSources());
    expect(await r.run(agent)).toMatchObject({ status: 'approved' });
    expect(r.extract).toHaveBeenCalledTimes(2);
  });

  it('runs an aligned request with linked prose and goal checks, and records the alignment in the evidence', async () => {
    const r = runner({ alignment: INFORMALIZATION_ALIGNMENT });
    r.extract.mockImplementation(async (_directory, _request, sources) => attachInformalizationGoals(
      informalizationOutline(informalizationReport(), { nonce: INFORMALIZATION_NONCE, target: 'double_add_zero', sources }),
      goalResults(), { nonce: INFORMALIZATION_NONCE, sources }));
    // The first write leaves the links out; the host sends that back.
    const agent = presetAgent({ write: (input, count) => count === 1 ? explain(input) : alignedExplain(input),
      audit: input => alignedReview(input) });
    expect(r.request.alignment).toBe(INFORMALIZATION_ALIGNMENT);
    expect(await r.run(agent)).toMatchObject({ status: 'approved', approvedBatches: 2, rounds: 3 });
    const writes = agent.calls.filter(call => call.role === 'write');
    expect(writes[1]!.input.feedback).toContain('sections.0.statementLinks: ');
    expect(writes[1]!.input.previousOutput).toBeNull();
    for (const call of agent.calls) {
      expect(call.input.alignment).toBe(INFORMALIZATION_ALIGNMENT);
      expect(readMathText(path.join(call.workspace, 'ROLE.md'))).toBe(informalizationRoleInstructions(call.role, INFORMALIZATION_ALIGNMENT));
      expect(JSON.parse(readMathText(path.join(call.workspace, 'OUTPUT.schema.json'))))
        .toEqual(informalizationRoleOutputSchema(call.role, INFORMALIZATION_ALIGNMENT));
    }
    const audit = agent.calls.find(call => call.role === 'audit' && call.batch === 1)!;
    expect((audit.input as unknown as InformalizationAuditInput).stepGoals!.map(section => section.steps.map(step => step?.lines)))
      .toEqual([[{ start: 7, end: 8 }], [{ start: 11, end: 12 }]]);

    const evidence = readInformalizationArtifact(path.join(r.directory, 'artifact'));
    expect(evidence.alignment).toBe(INFORMALIZATION_ALIGNMENT);
    expect((evidence.batches[1]!.writer.sections[0] as AlignedSection).statementLinks).toEqual([{ text: '(n : Nat)', lean: '(n : Nat)' }]);
    type Evidence = { alignment?: string; batches: { writer: { sections: AlignedSection[] };
      audits: { output: InformalizationAlignedAuditOutput }[] }[] };
    const tamper = (edit: (value: Evidence) => void) => {
      const value = structuredClone(evidence) as unknown as Evidence; edit(value);
      return () => assertInformalizationEvidence(value);
    };
    expect(tamper(value => { value.batches[1]!.writer.sections[0]!.proof[0]!.links[0]!.lean = 'rw [lib_fact]'; }))
      .toThrow('informalization_evidence_invalid');
    expect(tamper(value => { value.batches[1]!.audits[0]!.output.sections[1]!.steps[0]!.goals = 'unrecorded'; }))
      .toThrow('informalization_evidence_invalid');
    expect(tamper(value => { delete value.alignment; })).toThrow('informalization_evidence_invalid');
  });

  it('keeps unaligned role files unchanged', async () => {
    const r = runner(), agent = presetAgent();
    expect(await r.run(agent)).toMatchObject({ status: 'approved' });
    expect(r.request).not.toHaveProperty('alignment');
    for (const call of agent.calls) {
      expect(call.input).not.toHaveProperty('alignment');
      expect(readMathText(path.join(call.workspace, 'ROLE.md')))
        .toBe(call.role === 'write' ? INFORMALIZATION_WRITER_INSTRUCTIONS : INFORMALIZATION_AUDITOR_INSTRUCTIONS);
    }
    expect(readInformalizationArtifact(path.join(r.directory, 'artifact'))).not.toHaveProperty('alignment');
  });

  it('stops at the token limit before dispatching another role', async () => {
    const r = runner({ maxTotalTokens: 1 }), agent = presetAgent();
    expect(await r.run(agent)).toMatchObject({ status: 'stopped', error: 'math_total_token_limit',
      tokenBudget: { status: 'exhausted', reportedTotalTokens: 1 } });
    expect(agent.calls).toHaveLength(1);
  });
});

const additionUnit = (name: string, snippet: string, proofDependencies: string[]) => ({ name, displayName: name, kind: 'theorem',
  module: 'Proof', range: sourceRange(ADDITION_PROOF, snippet), signature: snippet.split(' :=')[0]!.replace(/^theorem /u, ''),
  statementDependencies: [], proofDependencies, external: ['Nat'], externalTruncated: false });
function additionOutline(sources: readonly { module: string; file: string; text: string }[]) {
  const report = { nonce: INFORMALIZATION_NONCE, target: 'addition', axioms: [], library: [], libraryTruncated: false, units: [
    additionUnit('addition', 'theorem addition (n : Nat) : n + 0 = n := by\n  exact helper n', ['helper']),
    additionUnit('helper', 'theorem helper (n : Nat) : n + 0 = n := rfl', [])] };
  const goals = { nonce: INFORMALIZATION_NONCE, module: 'Proof', truncated: false, tactics: [{ range: sourceRange(ADDITION_PROOF, 'exact helper n'),
    before: ['n : Nat\n⊢ n + 0 = n'], beforeCount: 1, after: [], afterCount: 0 }] };
  return attachInformalizationGoals(informalizationOutline(report, { nonce: INFORMALIZATION_NONCE, target: 'addition', sources }),
    [{ module: 'Proof', report: goals }], { nonce: INFORMALIZATION_NONCE, sources });
}
/** An aligned informalization of ADDITION_PROOF bound to an approved formalization run. */
async function formalizedRunner(overrides: Parameters<typeof informalizationFixture>[1] = {}, proof = ADDITION_PROOF) {
  const formalization = await approvedFormalization(roots);
  const f = informalizationFixture(roots, { target: 'addition', statement: null, alignment: INFORMALIZATION_ALIGNMENT,
    formalizationArtifact: path.join(formalization, 'artifact'), ...overrides }, { 'Proof.lean': proof });
  const run = (agent: ReturnType<typeof presetAgent>) => runInformalization(f.directory, f.root, { openSession: agent.open,
    extract: (async (_directory: string, _request: unknown, sources: readonly { module: string; file: string; text: string }[]) =>
      additionOutline(sources)) as never, waitForRetry: async () => {} });
  return { ...f, formalization, run };
}
const alignedAgent = () => presetAgent({ write: input => alignedExplain(input), audit: input => alignedReview(input) });
async function cli(args: string[]) {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try { return { code: await informalize(args), report: JSON.parse(String(log.mock.calls.at(-1)?.[0])) }; }
  finally { log.mockRestore(); }
}

describe('formalized proofs', () => {
  it('binds the proof to its approved formalization, whose original problem becomes the statement', async () => {
    const f = await formalizedRunner(), request = f.prepare(), artifact = path.join(f.formalization, 'artifact');
    const evidence = readFormalizationArtifact(artifact);
    expect(request).toMatchObject({ target: 'addition', statement: fixtureStatement, statementSha256: mathDigest(fixtureStatement),
      alignment: INFORMALIZATION_ALIGNMENT, formalization: { problemId: 'synthetic_addition', evidenceSha256: formalizationDigest(evidence),
        statementSha256: evidence.sourceSha256, originalSha256: evidence.request.statementSha256 } });
    for (const name of ['Statement.lean', 'original.txt', 'evidence.json']) {
      expect(fs.readFileSync(path.join(f.directory, 'formalization', name))).toEqual(fs.readFileSync(path.join(artifact, name)));
      expect(fs.statSync(path.join(f.directory, 'formalization', name)).mode & 0o777).toBe(0o400);
    }
    expect(readInformalizationRequest(f.directory).formalization).toEqual(evidence);
  });

  it.each([
    ['a changed theorem header', {}, ADDITION_PROOF.replace('theorem addition (n : Nat) : n + 0 = n', 'theorem addition (n : Nat) : 0 + n = n'),
      'informalization_formalization_declaration_changed: addition'],
    ['a renamed theorem', { target: 'sum' }, ADDITION_PROOF.replaceAll('addition', 'sum'), 'informalization_formalization_target_missing'],
    ['a target the formalization does not state', { target: 'helper' }, ADDITION_PROOF, 'informalization_formalization_target_missing'],
    ['another environment', { environment: 'mathlib' as const }, ADDITION_PROOF, 'informalization_formalization_environment_mismatch'],
    ['a statement of its own', { statement: 'Show n + 0 = n.' }, ADDITION_PROOF, 'informalization_formalization_statement_conflict'],
  ])('refuses a proof with %s before writing anything', async (_name, overrides, proof, error) => {
    const f = await formalizedRunner(overrides, proof);
    expect(() => f.prepare()).toThrow(error);
    expect(fs.existsSync(f.directory)).toBe(false);
  });

  it('refuses a formalization copy other than the one the request records', async () => {
    const f = await formalizedRunner(), other = path.join(await approvedFormalization(roots, 'other_addition'), 'artifact');
    f.prepare();
    for (const name of ['Statement.lean', 'original.txt', 'evidence.json']) {
      const copy = path.join(f.directory, 'formalization', name);
      fs.chmodSync(copy, 0o600); fs.copyFileSync(path.join(other, name), copy);
    }
    expect(() => readInformalizationRequest(f.directory)).toThrow('informalization_formalization_mismatch');
  });
  it('explains the proof with the original problem in the writer\'s input only, and places the reviewers\' fragments in it', async () => {
    const f = await formalizedRunner(); f.prepare();
    const agent = alignedAgent();
    expect(await f.run(agent)).toMatchObject({ status: 'approved', batches: 1, rounds: 1 });
    const write = agent.calls.find(call => call.role === 'write')!;
    expect(write.input).toMatchObject({ problemStatement: fixtureStatement, alignment: INFORMALIZATION_ALIGNMENT });
    for (const call of agent.calls.filter(item => item.role === 'audit')) expect(JSON.stringify(call.input)).not.toContain(fixtureStatement);
    const evidence = readInformalizationArtifact(path.join(f.directory, 'artifact'));
    const formalization = readFormalizationArtifact(path.join(f.formalization, 'artifact'));
    expect(evidence).toMatchObject({ statementSha256: mathDigest(fixtureStatement), alignment: INFORMALIZATION_ALIGNMENT,
      formalization: { problemId: 'synthetic_addition', evidenceSha256: formalizationDigest(formalization) } });

    const document = explanationDocument(evidence, ADDITION_PROOF, formalization);
    const [helper, addition] = document.sections;
    expect(addition!.statementLinks).toEqual([{ start: 'For every '.length, end: 'For every (n : Nat)'.length,
      lean: [{ line: 3, start: 17, end: 26 }] }]);
    expect(addition!.steps[0]).toMatchObject({ goals: { before: ['n : Nat\n⊢ n + 0 = n'], after: [] }, goalsChecked: 2,
      links: [{ lean: [{ line: 4, start: 2, end: 16 }] }] });
    expect(helper!.steps[0]).not.toHaveProperty('goals');
    expect(helper!.steps[0]).not.toHaveProperty('goalsChecked');
    expect(document).toMatchObject({ alignment: INFORMALIZATION_ALIGNMENT,
      problem: { problemId: 'synthetic_addition', original: fixtureStatement } });
    // Fragments are placed in the formalization's own declaration, not the helper that repeats its statement.
    const where = Object.fromEntries(document.problem!.correspondences.map(item => [item.aspect, [item.leanText, item.lean, item.reviewers]]));
    expect(where).toEqual({ domains: ['(n : Nat)', [{ line: 3, start: 17, end: 26 }], 2],
      assumptions: ['addition (n : Nat) :', [{ line: 3, start: 8, end: 28 }], 2],
      conclusions: ['n + 0 = n', [{ line: 3, start: 29, end: 38 }], 2], definitions: ['+', [{ line: 3, start: 31, end: 32 }], 2],
      quantifierScope: ['theorem addition (n : Nat)', [{ line: 3, start: 0, end: 26 }], 2],
      instanceCoherence: ['forall (n : Nat), n + 0 = n', [], 2] });
    expect(() => explanationDocument(evidence, ADDITION_PROOF)).toThrow('explanation_formalization_mismatch');
    const other = readFormalizationArtifact(path.join(await approvedFormalization(roots, 'other_addition'), 'artifact'));
    expect(() => explanationDocument(evidence, ADDITION_PROOF, other)).toThrow('explanation_formalization_mismatch');
  });

  it('writes the offline report page from the approved run without a model', async () => {
    const f = await formalizedRunner(); f.prepare();
    const output = path.join(f.base, 'addition.html');
    await expect(cli(['--phase', 'report', '--directory', f.directory, '--output', output])).rejects.toThrow('informalization_artifact_missing');
    await f.run(alignedAgent());
    const evidence = readInformalizationArtifact(path.join(f.directory, 'artifact'));
    const formalization = readFormalizationArtifact(path.join(f.directory, 'formalization'));
    expect(await cli(['--phase', 'report', '--directory', f.directory, '--output', output])).toEqual({ code: 0, report: {
      schema: 'theorem-os.informalization-cli.v1', phase: 'report', directory: f.directory, modelInvoked: false,
      requestDigest: evidence.requestDigest, output, bytes: fs.statSync(output).size, alignment: INFORMALIZATION_ALIGNMENT,
      formalization: evidence.formalization } });
    expect(pages.written).toEqual([{ output, report: { page: 'explain', data: { schema: 'theorem-os.web-explanation-report.v1',
      title: 'synthetic_double', environment: 'standard', proof: ADDITION_PROOF,
      document: explanationDocument(evidence, ADDITION_PROOF, formalization),
      markdown: readMathText(path.join(f.directory, 'artifact', 'proof.md')), filename: 'addition.md' } } }]);
    expect(forbidden.model).not.toHaveBeenCalled();
    await expect(cli(['--phase', 'report', '--directory', f.directory])).rejects.toThrow('--output is required');
    await expect(cli(['--phase', 'inspect', '--directory', f.directory, '--output', output])).rejects.toThrow('--output is not valid for --phase inspect');
  });

  it('refuses a report whose declarations are not all in the root file', async () => {
    const r = runner(); await r.run(presetAgent());
    await expect(cli(['--phase', 'report', '--directory', r.directory, '--output', path.join(r.base, 'double.html')]))
      .rejects.toThrow('informalization_report_multiple_files: lib_fact');
    expect(pages.written).toEqual([]);
  });
});
