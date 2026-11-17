import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { MathAgentSkill } from '../runtime/agentSkills';
import { mathDigest } from '../math/mathRuntimeIo';
import type { ContextSection } from './contextCompiler';

type Profile = { id: string; name: string; alias?: string; file: string; heading: string; anchor: string };

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const agentTeamProfileEvidenceSchema = z.object({
  schema: z.literal('theorem-os.agent-team-profile-evidence.v1'), skillDigest: digest,
  selected: z.array(z.string()), loaded: z.array(z.string()), unresolved: z.array(z.string()),
  sources: z.array(z.object({ profileId: z.string(), kind: z.enum(['profile', 'collected-reading']),
    loading: z.enum(['injected', 'available-on-demand']).optional(),
    file: z.string(), heading: z.string(), anchor: z.string(), firstLine: z.number().int().positive(),
    lastLine: z.number().int().positive(), digest, fileDigest: digest }).strict()),
}).strict();
export type AgentTeamProfileEvidence = z.infer<typeof agentTeamProfileEvidenceSchema>;

function read(directory: string, file: string): string {
  const absolute = path.join(directory, file);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
}

/** Read one complete Markdown section, including its subordinate headings. */
function section(text: string, heading: string) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^#{1,6} /u.test(line) && line.replace(/^#+ /u, '').trim() === heading);
  if (start < 0) throw new Error('math_team_profile_section_missing:' + heading);
  const level = /^#+/u.exec(lines[start]!)![0].length;
  const boundary = new RegExp('^#{1,' + level + '} ', 'u');
  let end = start + 1;
  while (end < lines.length && !boundary.test(lines[end]!)) end++;
  return { text: lines.slice(start, end).join('\n').trim(), firstLine: start + 1, lastLine: end };
}

function headingAnchor(heading: string) {
  return heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/gu, '-');
}

/** The pinned Skill is the catalogue; task text never supplies filesystem paths. */
function profiles(directory: string): Profile[] {
  const domains = read(directory, 'references/domain-experts.md');
  const result: Profile[] = [];
  for (const match of domains.matchAll(/^\| (D\d{3}) \| \[([^\]]+)\]\((domain-experts\/[a-z-]+\.md)#([a-z0-9-]+)\) \| ([^|]+) \| `([^`]+)` \|$/gmu)) {
    result.push({ id: match[1]!, name: match[5]!.trim(), alias: match[6]!,
      file: 'references/' + match[3]!, heading: match[4]!, anchor: match[4]! });
  }
  const roles = read(directory, 'references/team-roles.md');
  for (const match of roles.matchAll(/^\| (.+?) \(`([a-z-]+)`\) \|/gmu)) {
    const link = /^\[([^\]]+)\]\(([a-z-]+\.md)#([a-z-]+)\)$/u.exec(match[1]!);
    const name = link?.[1] ?? match[1]!;
    const heading = link?.[1] ?? roles.split('\n').find(line => line.startsWith('### ' + name + ' — '))?.slice(4);
    if (heading) result.push({ id: match[2]!, name, file: 'references/' + (link?.[2] ?? 'team-roles.md'),
      heading, anchor: link?.[3] ?? headingAnchor(heading) });
  }
  return result;
}

/** Only an explicit Profiles line selects knowledge; ordinary mathematical prose cannot assign a role. */
export function agentTeamProfileSelection(message: string): string[] {
  const line = /^Profiles:[ \t]*([^\r\n]+)(?:\r?\n|$)/u.exec(message.trimStart());
  return [...new Set(line?.[1]?.split(',').map(value => value.trim()).filter(Boolean) ?? [])];
}

/** Bind injected profiles and available reading separately; neither establishes their use. */
export function resolveAgentTeamProfiles(skill: MathAgentSkill, message: string): {
  section: ContextSection; evidence: AgentTeamProfileEvidence;
} {
  const directory = path.dirname(skill.path), catalogue = profiles(directory);
  const selected = agentTeamProfileSelection(message);
  const loaded = new Set<string>(), unresolved: string[] = [], passages: string[] = [];
  const sources: AgentTeamProfileEvidence['sources'] = [];
  const load = (profileId: string, kind: AgentTeamProfileEvidence['sources'][number]['kind'],
    file: string, heading: string, anchor: string, loading: 'injected' | 'available-on-demand' = 'injected') => {
    const fileText = read(directory, file), passage = section(fileText, heading);
    sources.push({ profileId, kind, loading, file, heading, anchor, firstLine: passage.firstLine, lastLine: passage.lastLine,
      digest: mathDigest(passage.text), fileDigest: mathDigest(fileText) });
    return passage.text;
  };
  for (const requested of selected) {
    const profile = catalogue.find(item => item.id === requested || item.alias === requested);
    if (!profile) { unresolved.push(requested); continue; }
    if (loaded.has(profile.id)) continue;
    loaded.add(profile.id);
    const text = load(profile.id, 'profile', profile.file, profile.heading, profile.anchor);
    passages.push(`Profile ${profile.id} (${profile.name}); source: ${profile.file}#${profile.anchor}\n${text}`);
    // Domain profiles link their own local collected reading, not arbitrary task-supplied material.
    const reading = /\]\(\.\.\/(domain-materials\/[a-z-]+\.md)#([a-z0-9-]+)\)/u.exec(text);
    if (reading) {
      const file = 'references/' + reading[1]!;
      load(profile.id, 'collected-reading', file, reading[2]!, reading[2]!, 'available-on-demand');
      passages.push(`Collected reading available on demand (not injected): ${file}#${reading[2]}. ` +
        `Read the relevant section of ${JSON.stringify(path.join(directory, file))} when its knowledge is needed.`);
    }
  }
  const evidence: AgentTeamProfileEvidence = { schema: 'theorem-os.agent-team-profile-evidence.v1',
    skillDigest: skill.digest, selected, loaded: [...loaded], unresolved, sources };
  const context: ContextSection = { id: 'agent-team-profiles', kind: 'assignment', text:
    'Professional knowledge for this assignment (from the pinned Skill; advisory, not proof evidence):\n' +
    JSON.stringify(evidence) + '\n' +
    (selected.length ? '' : 'No catalogue profile was selected. Read references/domain-experts.md and references/team-roles.md for relevant knowledge; clarify a missing specialization with Lead.\n') +
    (unresolved.length ? 'Unresolved names may describe custom expertise. Use the assignment to clarify that knowledge; do not claim a catalogue passage was loaded for them.\n' : '') +
    'Use relevant definitions, assumptions and distinctions from the injected profile; choose your own proof approach. ' +
    'Read linked material only when it addresses a concrete missing concept. Sources marked available-on-demand are locators, not loaded text. ' +
    'This record distinguishes supplied knowledge from available reading. When useful, report knowledge actually used with its source anchor and application. ' +
    'The source locators identify collected notes, not a new external-source read ' +
    'or proof acceptance.\n' + passages.join('\n\n') };
  return { section: context, evidence };
}

/** Compatibility wrapper for context callers; dispatchers can retain resolveAgentTeamProfiles().evidence. */
export function agentTeamProfileSection(skill: MathAgentSkill, message: string): ContextSection {
  return resolveAgentTeamProfiles(skill, message).section;
}
