import fs from 'node:fs';
import path from 'node:path';
import { mathBuildFile } from '../math/mathBuildManifest';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';

/** A pinned skill directory. Loading mode is part of the run's frozen configuration. */
export type MathAgentSkill = Readonly<{
  name: string;
  path: string;
  digest: string;
  loading: 'native' | 'file';
}>;

/** Identity includes references and scripts, not just the entrypoint passed to Codex. */
export function readMathAgentSkill(skillFile: string, loading: MathAgentSkill['loading'] = 'native'): MathAgentSkill {
  if (!path.isAbsolute(skillFile) || path.normalize(skillFile) !== skillFile || path.basename(skillFile) !== 'SKILL.md' ||
      !['native', 'file'].includes(loading)) throw new Error('math_codex_skill_invalid');
  assertMathCanonicalPath(skillFile);
  const directory = path.dirname(skillFile);
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const collect = (relative: string) => {
    const absolute = path.join(directory, relative);
    assertMathCanonicalPath(absolute);
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).toSorted((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) collect(child);
      else if (entry.isFile()) {
        const identity = mathBuildFile(path.join(directory, child));
        files.push({ path: child.split(path.sep).join('/'), bytes: identity.bytes!, sha256: identity.sha256! });
      }
      else throw new Error('math_codex_skill_file_invalid');
    }
  };
  collect('');
  const text = readMathText(skillFile);
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text)?.[1];
  // Project skills use a plain scalar name; do not interpret arbitrary YAML as executable configuration.
  const name = frontmatter && /^name:[ \t]*([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]*$/mu.exec(frontmatter)?.[1];
  if (!name || name.length > 64 || !/^description:[ \t]*\S.+$/mu.test(frontmatter))
    throw new Error('math_codex_skill_metadata_invalid');
  const entrypoint = files.find(file => file.path === 'SKILL.md');
  if (!entrypoint || entrypoint.sha256 !== mathDigest(text)) throw new Error('math_codex_skill_changed');
  return { name, path: skillFile, digest: mathDigest(canonicalMathJson({ name, files })), loading };
}

export function assertMathAgentSkillsCurrent(skills: readonly MathAgentSkill[]): void {
  const names = new Set<string>();
  for (const skill of skills) {
    if (!skill || typeof skill.name !== 'string' || typeof skill.path !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(skill.digest ?? '') || !['native', 'file'].includes(skill.loading) || names.has(skill.name))
      throw new Error('math_codex_skill_invalid');
    names.add(skill.name);
    const current = readMathAgentSkill(skill.path, skill.loading);
    if (current.name !== skill.name || current.digest !== skill.digest) throw new Error(`math_codex_skill_changed:${skill.name}`);
  }
}
