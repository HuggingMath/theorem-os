import fs from 'node:fs';
import path from 'node:path';
import { mathDigest, writeMathTextDurable } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';

export const RESEARCH_TOOL_HELP_FILE = '.scratch/theoremos-help.md';
export type ResearchToolHelp = Readonly<{ path: typeof RESEARCH_TOOL_HELP_FILE; text: string; digest: string }>;

/** Keep mandatory contracts inline; command examples and complete optional schemas are read on demand. */
export class ResearchToolHelpBuilder {
  private sections: { id: string; text: string }[] = [];

  instruction(worktree: string): string {
    const file = "'" + path.join(worktree, RESEARCH_TOOL_HELP_FILE).replaceAll("'", "'\\''") + "'";
    return 'Run-specific commands and delivery formats: ' + file + '. Read relevant sections as needed; leave it unchanged.\n';
  }

  section(id: string, detail: string, summary: string): string {
    if (!detail) return '';
    this.sections.push({ id, text: detail });
    return summary + ' Read local tool-help section "' + id + '" before using this protocol.\n';
  }

  build(): ResearchToolHelp | undefined {
    if (!this.sections.length) return undefined;
    const text = '# TheoremOS local tool help\n\n' +
      'Host-prepared command and schema reference for the current dispatch. Leave this file unchanged. ' +
      'The frozen problem, current assignment and mandatory instructions retain authority. ' +
      'Examples are placeholders, historical evidence is advisory, and only independent host checks accept proofs.\n\n' +
      this.sections.map(section => '## ' + section.id + '\n\n' + section.text + '\n').join('\n');
    return { path: RESEARCH_TOOL_HELP_FILE, text, digest: mathDigest(text) };
  }
}

/** Materialize before opening or dispatching a worker turn; fixtures can inspect the same readable bytes. */
export function materializeResearchToolHelp(context: { toolHelp?: ResearchToolHelp }, worktree: string): void {
  const help = context.toolHelp;
  if (!help) return;
  if (help.path !== RESEARCH_TOOL_HELP_FILE || mathDigest(help.text) !== help.digest)
    throw new Error('math_tool_help_identity_changed');
  const file = path.join(worktree, help.path);
  assertMathCanonicalPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assertMathCanonicalPath(file);
  writeMathTextDurable(file, help.text);
}
