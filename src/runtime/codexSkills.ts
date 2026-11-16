import type { MathAgentSkill } from './agentSkills';
export { readMathAgentSkill, assertMathAgentSkillsCurrent } from './agentSkills';
export type { MathAgentSkill } from './agentSkills';

/** Checks actual native discovery separately from loading and mathematical behavior. */
export function assertMathAgentSkillsDiscovered(value: unknown, workspace: string, skills: readonly MathAgentSkill[]): void {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const response = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!response || !Array.isArray(response.data)) throw new Error('math_codex_skill_discovery_invalid');
  const entries: unknown[] = response.data;
  const entry = entries.find((value): value is Record<string, unknown> => object(value) && value.cwd === workspace);
  if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw new Error('math_codex_skill_discovery_invalid');
  for (const skill of skills.filter(skill => skill.loading === 'native')) {
    const errors: unknown[] = entry.errors, discovered: unknown[] = entry.skills;
    if (errors.some(value => object(value) && value.path === skill.path))
      throw new Error(`math_codex_skill_discovery_error:${skill.name}`);
    const found = discovered.find((value): value is Record<string, unknown> => object(value) &&
      value.name === skill.name && value.path === skill.path);
    if (!found) throw new Error(`math_codex_skill_not_discovered:${skill.name}`);
    if (found.enabled !== true) throw new Error(`math_codex_skill_disabled:${skill.name}`);
  }
}
