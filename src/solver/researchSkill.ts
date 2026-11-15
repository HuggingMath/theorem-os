import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath } from '../math/paths';
import { readMathAgentSkill, type MathAgentSkill } from '../runtime/agentSkills';
import type { SolverRunState } from './archive';
import { pinSolverResearchSkill, type SolverProblem } from './problem';

export const RESEARCH_SKILL_DIRECTORY = '.agents/skills/theoremos-research';
export type ResearchSkillIdentity = NonNullable<SolverRunState['researchSkill']>;

export function researchSkillIdentity(skill: MathAgentSkill): ResearchSkillIdentity {
  return { name: skill.name, digest: skill.digest, loading: skill.loading };
}

/** A run reads its own pinned project skill, never a mutable personal installation. */
export function prepareResearchSkill(root: string, worktree: string,
  expected: ResearchSkillIdentity, problem?: SolverProblem): MathAgentSkill {
  const source = path.join(root, 'skills/theoremos-research/SKILL.md');
  const skill = readMathAgentSkill(source, expected.loading);
  if (skill.name !== expected.name || skill.digest !== expected.digest) throw new Error('math_research_skill_changed');
  const target = path.join(worktree, RESEARCH_SKILL_DIRECTORY);
  const file = path.join(target, 'SKILL.md');
  assertMathCanonicalPath(file);
  if (!fs.existsSync(target)) {
    // A killed copy must not leave a partial installed skill that every resume rejects.
    // Interrupted staging stays advisory scratch; only a complete pinned copy is published.
    const scratch = path.join(worktree, '.scratch', 'tmp');
    assertMathCanonicalPath(scratch);
    fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const staging = fs.mkdtempSync(path.join(scratch, 'theoremos-skill-'));
    try {
      fs.cpSync(path.dirname(source), staging, { recursive: true, errorOnExist: true, force: false });
      const staged = readMathAgentSkill(path.join(staging, 'SKILL.md'), expected.loading);
      if (staged.name !== expected.name || staged.digest !== expected.digest) throw new Error('math_research_skill_changed');
      const freeze = (directory: string) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const child = path.join(directory, entry.name);
          if (entry.isDirectory()) freeze(child); else fs.chmodSync(child, 0o400);
        }
        fs.chmodSync(directory, 0o700);
      };
      freeze(staging);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.renameSync(staging, target);
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  const copied = readMathAgentSkill(file, expected.loading);
  if (copied.name !== expected.name || copied.digest !== expected.digest) throw new Error('math_research_skill_changed');
  if (problem) pinSolverResearchSkill(problem, worktree, copied);
  return copied;
}
