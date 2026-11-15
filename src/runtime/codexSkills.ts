import type { MathAgentSkill } from './agentSkills';
export { readMathAgentSkill, assertMathAgentSkillsCurrent } from './agentSkills';
export type { MathAgentSkill } from './agentSkills';

/** Checks actual native discovery separately from loading and mathematical behavior. */
export function assertMathAgentSkillsDiscovered(value: unknown, workspace: string, skills: readonly MathAgentSkill[]): void {
  const response = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (!response || !Array.isArray(response.data)) throw new Error('math_codex_skill_discovery_invalid');
  const entry = response.data.find(value => value && typeof value === 'object' && !Array.isArray(value) && value.cwd === workspace);
  if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors)) throw new Error('math_codex_skill_discovery_invalid');
  for (const skill of skills.filter(skill => skill.loading === 'native')) {
    if (entry.errors.some(value => value && typeof value === 'object' && !Array.isArray(value) && value.path === skill.path))
      throw new Error(`math_codex_skill_discovery_error:${skill.name}`);
    const found = entry.skills.find(value => value && typeof value === 'object' && !Array.isArray(value) &&
      value.name === skill.name && value.path === skill.path);
    if (!found) throw new Error(`math_codex_skill_not_discovered:${skill.name}`);
    if (found.enabled !== true) throw new Error(`math_codex_skill_disabled:${skill.name}`);
  }
}
