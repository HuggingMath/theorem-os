import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import { formalizationDigest, type FormalizationEvidence } from '../../src/math/formalization';
import { INFORMALIZATION_ALIGNMENT, INFORMALIZATION_OUTLINE_POLICY, informalizationAuditInput, informalizationBatches, informalizationEvidence, informalizationWriterInput,
  type InformalizationEvidence, type InformalizationRequest, type InformalizationSection } from '../../src/math/informalization';
import { attachInformalizationGoals, informalizationOutline } from '../../src/math/informalizationExtraction';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import type { WebEnvironment, WebExplanationLanguage } from '../../apps/web/shared';
import { sourceRange } from './informalizationFixture';

// Synthetic approved evidence for one-file web proofs: preset prose and audits, never model or benchmark output.
const NONCE = 'fedcba9876543210fedcba9876543210';
export type FixtureUnit = { name: string; kind: 'theorem' | 'definition'; snippet: string; uses?: string[];
  /** Library constants the declaration's terms use. */ external?: string[];
  /** Steps as excerpts of the snippet; default one step quoting the whole snippet (theorems only). */ steps?: string[][];
  /** Prose of each step; default `Step i of name.` */ texts?: string[];
  /** Names each step cites; default the required citations, all in the first step. */ cites?: string[][];
  /** Tactics as snippets of this declaration with their goals; the evidence has goal states when any unit has some. */
  goals?: { snippet: string; before: string[]; after: string[] }[];
  /** Prose of the statement; default `Statement of name.` */ statement?: string;
  /** With alignment: the statement's and each step's linked phrases (a theorem needs a statement link). */
  statementLinks?: Link[]; links?: Link[][] };
type Link = { text: string; lean: string };
const preset = { model: 'deepseek-flash', effort: 'max', profile: '/preset-only', executable: '/no-model' };

/**
 * `aligned` uses phrase alignment (true: the current version): links from the units, and auditors that find every step
 * consistent with its recorded goals. `formalization` binds the proof to that approved formalization, whose original
 * problem is the statement.
 */
export function webExplanationEvidence(input: { proof: string; target: string; units: FixtureUnit[];
  language?: WebExplanationLanguage; environment?: WebEnvironment; maxUnits?: number;
  aligned?: boolean | NonNullable<InformalizationRequest['alignment']>; formalization?: FormalizationEvidence;
  /** Written with the outline policy: a summary per declaration and a two-stage route (the lemmas, then the target). */
  outlined?: boolean }): InformalizationEvidence {
  const language = input.language ?? 'zh', environment = getLeanTaskEnvironment(input.environment ?? 'standard');
  const { formalization } = input;
  const alignment = input.aligned === true ? INFORMALIZATION_ALIGNMENT : input.aligned || undefined;
  const sources = [{ module: 'Submission', file: 'Submission.lean', text: input.proof }];
  const outlinePolicy = input.outlined ? INFORMALIZATION_OUTLINE_POLICY as typeof INFORMALIZATION_OUTLINE_POLICY : undefined;
  // Every external constant is a library theorem, except the ones Lean's evaluation leaves.
  const library = [...new Set(input.units.flatMap(unit => unit.external ?? []))].sort().map(name => ({ name,
    kind: name.startsWith('Lean.') ? 'axiom' as const : 'theorem' as const, module: null, signature: `theorem ${name} : True` }));
  const report = { nonce: NONCE, target: input.target, axioms: ['propext'], library, libraryTruncated: false,
    units: input.units.map(unit => ({ name: unit.name, displayName: unit.name, kind: unit.kind, module: 'Submission',
      range: sourceRange(input.proof, unit.snippet), signature: unit.snippet.split(' :=')[0]!,
      statementDependencies: [], proofDependencies: unit.uses ?? [], external: unit.external ?? [], externalTruncated: false })) };
  let outline = informalizationOutline(report, { nonce: NONCE, target: input.target, sources });
  const goals = input.units.flatMap(unit => (unit.goals ?? []).map(item => {
    const outer = sourceRange(input.proof, unit.snippet), inner = sourceRange(unit.snippet, item.snippet);
    const at = (line: number, column: number) => ({ line: outer.line + line - 1, column: line === 1 ? outer.column + column : column });
    const start = at(inner.line, inner.column), end = at(inner.endLine, inner.endColumn);
    return { range: { line: start.line, column: start.column, endLine: end.line, endColumn: end.column }, before: item.before,
      beforeCount: item.before.length, after: item.after, afterCount: item.after.length };
  }));
  if (goals.length) outline = attachInformalizationGoals(outline, [{ module: 'Submission', report: { nonce: NONCE, module: 'Submission',
    truncated: false, tactics: goals } }], { nonce: NONCE, sources });
  const statement = formalization?.request.statement ?? null;
  const request = { language, toolchain: environment.toolchain, mathlibRevision: environment.mathlibRevision ?? null,
    ...statement === null ? {} : { statement }, statementSha256: statement === null ? null : mathDigest(statement),
    ...formalization ? { formalization: { problemId: formalization.request.problemId, evidenceSha256: formalizationDigest(formalization),
      statementSha256: formalization.sourceSha256, originalSha256: formalization.request.statementSha256 } } : {},
    ...alignment ? { alignment } : {}, ...outlinePolicy ? { outlinePolicy } : {}, batching: { maxUnits: input.maxUnits ?? 12, maxSourceBytes: 60_000 },
    sources: [{ module: 'Submission', file: 'Submission.lean', origin: 'Submission.lean', sha256: mathDigest(input.proof),
      bytes: Buffer.byteLength(input.proof) }],
    writer: preset, auditors: [{ ...preset, id: 'auditor-1' }, { ...preset, id: 'auditor-2' }] } as unknown as InformalizationRequest;
  const byName = new Map(input.units.map(unit => [unit.name, unit]));
  const accepted = new Map<string, InformalizationSection>(), batches: InformalizationEvidence['batches'] = [];
  for (const batch of informalizationBatches(outline, request.batching)) {
    const context = { outline, batch, accepted, sources, language, ...alignment ? { alignment } : {}, ...outlinePolicy ? { outlinePolicy } : {} };
    const writerInput = informalizationWriterInput({ ...context, round: 1, problemStatement: statement, feedback: null, previousOutput: null });
    const sections = writerInput.units.map(unit => {
      const fixture = byName.get(unit.declaration)!;
      const steps = fixture.steps ?? (unit.kind === 'theorem' ? [[unit.source]] : []);
      const links = (items: Link[] | undefined) => alignment ? { links: items ?? [] } : {};
      return { declaration: unit.declaration, title: 'Title of ' + unit.declaration,
        statement: fixture.statement ?? 'Statement of ' + unit.declaration,
        ...outlinePolicy ? { summary: 'Summary of ' + unit.declaration + '.' } : {},
        ...alignment ? { statementLinks: fixture.statementLinks ?? [] } : {},
        proof: steps.map((lean, index) => ({ text: fixture.texts?.[index] ?? `Step ${index + 1} of ${unit.declaration}.`,
          uses: fixture.cites?.[index] ?? (index === 0 ? unit.mustCite : []), lean, ...links(fixture.links?.[index]) })) };
    });
    const others = outline.units.slice(0, -1).map(unit => unit.name);
    const route = !batch.final ? null : [...others.length ? [{ claim: 'First the lemmas.', declarations: others }] : [{ claim: 'State the target.', declarations: [input.target] }],
      { claim: 'Then the target follows.', declarations: [input.target] }];
    const writer = { inputDigest: writerInput.inputDigest, sections, overview: batch.final ? 'Combine the lemmas.' : null, ...outlinePolicy ? { route } : {} };
    const auditInput = informalizationAuditInput({ ...context, explanation: writer });
    // The first auditor explains its verdicts, the second leaves them blank (allowed for faithful and justified). With
    // alignment, each step is consistent with the goals recorded for it.
    const goalsOf = (section: number, step: number) => alignment
      ? { goals: auditInput.stepGoals?.[section]?.steps[step] ? 'consistent' as const : 'unrecorded' as const } : {};
    const audit = (auditorId: string) => ({ auditorId, output: { inputDigest: auditInput.inputDigest,
      sections: sections.map((section, sectionIndex) => ({ declaration: section.declaration, statement: { verdict: 'faithful' as const,
        explanation: auditorId === 'auditor-1' ? `The statement matches the signature of ${section.declaration}.` : '' },
        steps: section.proof.map((_, index) => ({ verdict: 'justified' as const,
          explanation: auditorId === 'auditor-1' ? `Step ${index + 1} is what the quoted Lean does.` : '', ...goalsOf(sectionIndex, index) })),
        omissions: [], ...outlinePolicy ? { summary: { verdict: 'faithful' as const, explanation: '' } } : {} })),
      overview: { verdict: batch.final ? 'consistent' as const : 'absent' as const, explanation: '' },
      ...outlinePolicy ? { route: { verdict: batch.final ? 'consistent' as const : 'absent' as const, explanation: '' } } : {}, summary: 'No problems.' } });
    batches.push({ index: batch.index, declarations: batch.declarations, rounds: 1, writerInputDigest: writerInput.inputDigest,
      writer, audits: [audit('auditor-1'), audit('auditor-2')] });
    for (const section of sections) accepted.set(section.declaration, section);
  }
  const sessions = batches.flatMap(batch => (['write', 'audit'] as const).map(role => ({ role, batch: batch.index, round: 1, attempt: 1,
    status: 'completed', model: preset.model, effort: preset.effort, inputDigest: batch.writerInputDigest,
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } })));
  return informalizationEvidence({ request, outline, batches, sessions });
}
