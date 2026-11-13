/** Read the host's quoted declaration/premise contracts without treating their JSON as Lean source. */
export function conditionalPayloads(source: string): { declaration: string;
  dependencies: { theoremName: string; type: string }[] }[] {
  return [...source.matchAll(/:\s+theorem_os_conditional_type% ("(?:[^"\r\n\\]|\\.)*")/gu)]
    .map(match => JSON.parse(JSON.parse(match[1]!)));
}
