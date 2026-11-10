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
  return { source: source ?? 'choose-for-current-gap',
    allowedSources: researchSourceKinds,
    workflow: source === 'mathlib' ? 'Search the pinned source corpus and confirm exact types and imports with Lean.' :
      source === 'verified-library' ? 'Search the frozen knowledge catalog and installed declaration index before proposing a missing helper.' :
        source === 'public-literature' ? 'Use the permitted reference tools; record the public URL and theorem or section in the saved snapshot. State in locator whether you read an abstract, a proof section or full text. Read the relevant proof before ruling out its route; an abstract or failed search cannot establish that no usable proof exists.' :
          'Select pinned Mathlib, an installed verified module, or permitted public literature for the current gap.',
    output: 'sourceUses:[{kind,reference,locator,assumptions,adaptation,consumer:{taskId,taskDigest},lemmaRequestIds,remaining}]',
    acceptance: 'advisory-reference-requiring-current-consumer-check',
    sourcePolicy: 'Exclude OpenAI Math benchmark answers, previous benchmark solver answers, forks, mirrors, archives and cached copies. A source claim never proves its adaptation.' };
}
