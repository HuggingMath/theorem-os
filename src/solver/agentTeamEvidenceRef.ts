import { z } from 'zod';

export const teamEvidenceRefSchema = z.string().regex(
  /^(?:message:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}|(?:research|delivery):[a-f0-9]{64})$/u);

/** Only a dedicated line associates a new assignment with an earlier finding. */
export function nativeAssignmentEvidence(message: string) {
  const lines = message.split(/\r?\n/u);
  const refs = lines.filter(line => line.startsWith('Based on: '));
  const reference = refs.length === 1 ? teamEvidenceRefSchema.safeParse(refs[0]!.slice('Based on: '.length).trim()).data : undefined;
  const objective = lines.filter(line => !line.startsWith('Profiles:') && !line.startsWith('Based on: '))
    .join('\n').trim().replace(/\s+/gu, ' ');
  return { reference, objective };
}
