import { MAX_RESEARCH_NOTES_BYTES } from './deliveries';
import { ResearchAdmissionError, type ResearchFinding } from './researchAdmission';

/** Retain probe code in the same immutable notes snapshot as its advisory finding. */
export function researchPublicationNotes(finding: ResearchFinding, probes?: unknown): string {
  const invalid = (message: string): never => {
    throw new ResearchAdmissionError({ status: 'rejected', code: 'math_research_delivery_invalid',
      issues: [{ path: 'probes', message }], recovery: 'correct-and-resubmit' });
  };
  if (probes === undefined) return JSON.stringify(finding);
  if (!Array.isArray(probes) || probes.length > 16) invalid('Provide at most 16 retained Lean probes.');
  const blocks = (probes as unknown[]).map(probe => {
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) return invalid('A probe must contain source and code strings.');
    const { source, code } = probe as Record<string, unknown>;
    if (typeof source !== 'string' || !source.trim() || source.length > 1000 || /[\r\n]/u.test(source) ||
        typeof code !== 'string' || !code.trim() || code.includes('```'))
      return invalid('Retain plain Lean code without Markdown fences and a single-line source label.');
    return 'Retained probe (' + JSON.stringify(source) + '; advisory, not proof acceptance):\n```lean\n' + code + '\n```';
  });
  const text = [...blocks, '```math-result\n' + JSON.stringify(finding) + '\n```'].join('\n\n');
  if (Buffer.byteLength(text) > MAX_RESEARCH_NOTES_BYTES) invalid('The complete finding and probes exceed the research notes byte limit.');
  return text;
}
