import { z } from 'zod';
import { taskGroup, taskVersion, type CooperativeTask, type TaskRecord } from './tasks';

export const researchSourceKinds = ['mathlib', 'verified-library', 'public-literature'] as const;
const text = z.string().trim().min(1).max(8000);
export const researchSourceUseSchema = z.object({
  kind: z.enum(researchSourceKinds), reference: text, locator: text,
  assumptions: z.array(text).max(64), adaptation: text,
  consumer: z.object({ taskId: text, taskDigest: text }).strict(),
  lemmaRequestIds: z.array(text).max(64), remaining: z.array(text).max(64),
}).strict();
export type ResearchSourceUse = z.infer<typeof researchSourceUseSchema>;

/** A reference records an adaptation for a visible exact consumer; it supplies no proof premise. */
export function researchReferenceIssues(value: unknown, source: CooperativeTask, tasks: readonly TaskRecord[],
  proposals: unknown): { path: string; message: string }[] {
  if (value === undefined) return [];
  const parsed = z.array(researchSourceUseSchema).max(32).safeParse(value);
  if (!parsed.success) return parsed.error.issues.map(issue => ({
    path: ['sourceUses', ...issue.path].join('.'), message: issue.message,
  }));
  const ids = new Set(Array.isArray(proposals) ? proposals.map(item => item?.id) : []);
  return parsed.data.flatMap((use, index) => {
    const consumer = tasks.find(node => node.task.id === use.consumer.taskId &&
      taskVersion(node.task) === use.consumer.taskDigest);
    const visible = consumer && (!['research', 'sketch'].includes(consumer.task.kind)) &&
      (taskGroup(consumer.task) === taskGroup(source) || consumer.task.sharing !== 'group');
    const issues: { path: string; message: string }[] = [];
    if (!visible) issues.push({ path: `sourceUses.${index}.consumer`,
      message: 'Name an exact current visible proof consumer and its taskDigest.' });
    if (use.lemmaRequestIds.some(id => !ids.has(id))) issues.push({ path: `sourceUses.${index}.lemmaRequestIds`,
      message: 'Reference typed lemmaRequests published in this same finding.' });
    return issues;
  });
}

export function researchSourceContract(source?: CooperativeTask['researchSource']) {
  const publicWorkflow = 'For the exact consumer gap, reuse saved source snapshots and pinned library results first. ' +
    'If the missing mechanism remains unresolved, proactively search permitted public literature using public mathematical terms, theorem names or author/title identifiers; ' +
    'omit internal task IDs, OAI namespaces and local paths from public queries. ' +
    'Read the relevant proof section and check assumptions before adapting its result. ' +
    'Use actual terms or references from a relevant passage for the next query, keeping the original gap in scope. ' +
    'Distinguish provider failure, irrelevant hits and an empty successful search. ' +
    'Record the public URL, retrieval time and exact section/theorem/lines in the saved snapshot; state abstract/proof-section/full-text scope in locator and retain the remaining inference. ' +
    'When repeated queries add no new evidence, save the scoped result and change that search branch; this does not establish global absence.';
  return { source: source ?? 'choose-for-current-gap',
    allowedSources: researchSourceKinds,
    workflow: source === 'mathlib' ? 'Search the pinned source corpus and confirm exact types and imports with Lean.' :
      source === 'verified-library' ? 'Search the frozen knowledge catalog and installed declaration index before proposing a missing helper.' :
        source === 'public-literature' ? publicWorkflow :
          'Select pinned Mathlib, an installed verified module, or permitted public literature for the current gap. ' + publicWorkflow,
    output: 'sourceUses:[{kind,reference,locator,assumptions,adaptation,consumer:{taskId,taskDigest},lemmaRequestIds,remaining}]',
    acceptance: 'advisory-reference-requiring-current-consumer-check',
    sourcePolicy: 'Exclude OpenAI Math benchmark answers, previous benchmark solver answers, forks, mirrors, archives and cached copies. A source claim never proves its adaptation.' };
}
