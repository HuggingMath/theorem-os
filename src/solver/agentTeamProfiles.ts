import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
import { NativeAgentControlInputError } from '../runtime/nativeAgentControl';
import { mathDigest } from '../math/mathRuntimeIo';
import type { ContextSection } from './contextCompiler';
import type { FrozenPersonalExpert } from './personalExpertSchema';

type Profile = { id: string; name: string; nameZh?: string; alias?: string; file: string; heading: string; anchor: string };

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const agentTeamProfileEvidenceSchema = z.object({
  schema: z.literal('theorem-os.agent-team-profile-evidence.v1'), skillDigest: digest,
  selected: z.array(z.string()), loaded: z.array(z.string()), unresolved: z.array(z.string()),
  sources: z.array(z.object({ profileId: z.string(), kind: z.enum(['profile', 'collected-reading', 'personal-expert']),
    assetVersion: z.string().optional(), releaseDigest: digest.optional(),
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
    result.push({ id: match[1]!, name: match[5]!.trim(), nameZh: match[2]!, alias: match[6]!,
      file: 'references/' + match[3]!, heading: match[4]!, anchor: match[4]! });
  }
  const roles = read(directory, 'references/team-roles.md');
  for (const match of roles.matchAll(/^\| (.+?) \(`([a-z-]+)`\) \| [^|\n]* \|(?: ([^|\n]+) \|)?$/gmu)) {
    const link = /^\[([^\]]+)\]\(([a-z-]+\.md)#([a-z-]+)\)$/u.exec(match[1]!);
    const name = link?.[1] ?? match[1]!;
    const heading = link?.[1] ?? roles.split('\n').find(line => line.startsWith('### ' + name + ' — '))?.slice(4);
    if (heading) result.push({ id: match[2]!, name, nameZh: match[3]?.trim(), file: 'references/' + (link?.[2] ?? 'team-roles.md'),
      heading, anchor: link?.[3] ?? headingAnchor(heading) });
  }
  return result;
}

export function eligibleAgentTeamProfiles(directory: string) {
  return profiles(directory).filter(item => item.id !== 'lead').map(({ id, name, nameZh, alias }) =>
    ({ id, name, ...(nameZh && { nameZh }), ...(alias && { alias }), kind: alias ? 'domain' as const : 'work' as const }));
}

/** A preference identifies catalogue knowledge without loading it into any member. */
export function getPreferredAgentTeamProfiles(skill: MathAgentSkill, names: readonly string[]): string[] {
  if (!names.length) return [];
  assertMathAgentSkillsCurrent([skill]);
  return normalizeTeamProfilePreferences(eligibleAgentTeamProfiles(path.dirname(skill.path)), names);
}

export function normalizeTeamProfilePreferences(catalogue: readonly { id: string; alias?: string }[], names: readonly string[]): string[] {
  return [...new Set(names.map(value => {
    const name = value.trim();
    const entry = catalogue.find(profile => profile.id === name || profile.alias === name);
    if (!entry) throw new Error('math_team_preferred_profile_invalid: ' + JSON.stringify(name));
    return entry.id;
  }))].sort();
}

/** Only an explicit Profiles line selects knowledge; ordinary mathematical prose cannot assign a role. */
export function agentTeamProfileSelection(message: string): string[] {
  const line = /^Profiles:[ \t]*([^\r\n]+)(?:\r?\n|$)/u.exec(message.trimStart());
  return [...new Set(line?.[1]?.split(',').map(value => value.trim()).filter(Boolean) ?? [])];
}

/** New assignments must load every explicit selection; historical records remain readable below. */
export function resolveNewMemberProfiles(skill: MathAgentSkill, message: string, cards?: readonly FrozenPersonalExpert[]) {
  const selected = agentTeamProfileSelection(message);
  if (selected.includes('lead')) throw new NativeAgentControlInputError(
    'math_team_profile_reserved: lead belongs to the coordinator. Replace it in Profiles: with a member specialty ' +
    '(e.g. prover, researcher or engineer) for the assigned gap, or omit the header.');
  if (selected.length) assertMathAgentSkillsCurrent([skill]);
  const profiles = resolveProfiles(skill, selected, false, cards);
  const emptyHeader = !selected.length && message.trimStart().startsWith('Profiles:');
  if (emptyHeader || profiles.evidence.unresolved.length) throw new NativeAgentControlInputError(
    'math_team_profile_unresolved: ' + (emptyHeader ? 'empty Profiles: header' : JSON.stringify(profiles.evidence.unresolved)) +
    '. Use only comma-separated IDs or slugs from the pinned Skill (references/team-roles.md or references/domain-experts.md)' +
    (cards?.length ? ' or asset:<assetId> from this run\'s personal expert catalogue' : '') + '. ' +
    'For example, put "Profiles: prover" alone on the first line. Put descriptions or custom expertise in the body; the header is optional.');
  return profiles;
}

export function resolveAgentTeamLeadProfile(skill: MathAgentSkill) {
  return resolveProfiles(skill, ['lead'], true);
}

export function resolveAgentTeamProfiles(skill: MathAgentSkill, message: string, cards?: readonly FrozenPersonalExpert[]) {
  return resolveProfiles(skill, agentTeamProfileSelection(message), false, cards);
}

/** Bind injected profiles and available reading separately; neither establishes their use. */
function resolveProfiles(skill: MathAgentSkill, selected: string[], coordinator: boolean, cards?: readonly FrozenPersonalExpert[]): {
  section: ContextSection; evidence: AgentTeamProfileEvidence;
} {
  const directory = path.dirname(skill.path), catalogue = profiles(directory);
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
    const card = requested.startsWith('asset:') && cards?.find(item => requested === 'asset:' + item.assetId);
    if (card) {
      loaded.add(requested);
      sources.push({ profileId: requested, kind: 'personal-expert', loading: 'injected', assetVersion: card.version,
        releaseDigest: card.digest, file: requested, heading: card.name, anchor: 'knowledge', firstLine: 1,
        lastLine: card.knowledge.split('\n').length, digest: mathDigest(card.knowledge), fileDigest: card.digest });
      passages.push('User-selected expert knowledge (advisory): ' + JSON.stringify({
        profile: requested, name: card.name, version: card.version, knowledge: card.knowledge }));
      continue;
    }
    const profile = catalogue.find(item => item.id === requested || item.alias === requested);
    if (!profile || (!coordinator && profile.id === 'lead')) { unresolved.push(requested); continue; }
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
    (coordinator ? 'Your coordinator charter (host-selected for Lead only):\n' :
      'Professional knowledge for this assignment (from the pinned Skill; advisory, not proof evidence):\n') +
    JSON.stringify(evidence) + '\n' +
    (selected.length ? '' : 'No catalogue profile was selected. Read references/domain-experts.md and references/team-roles.md for relevant knowledge; clarify a missing specialization with Lead.\n') +
    (unresolved.includes('lead') ? 'The lead profile is reserved for your coordinator. Continue as a member on your assigned question.\n' : '') +
    (unresolved.some(name => name !== 'lead') ? 'Unresolved names may describe custom expertise. Use the assignment to clarify that knowledge; do not claim a catalogue passage was loaded for them.\n' : '') +
    'Use relevant definitions, assumptions and distinctions from the injected profile; choose your own proof approach. ' +
    'Read linked material only when it addresses a concrete missing concept. Sources marked available-on-demand are locators, not loaded text. ' +
    'This record distinguishes supplied knowledge from available reading. When useful, report knowledge actually used with its source anchor and application. ' +
    'The source locators identify collected notes, not a new external-source read ' +
    'or proof acceptance.\n' + passages.join('\n\n') };
  return { section: context, evidence };
}

/** Compatibility wrapper for context callers; dispatchers can retain resolveAgentTeamProfiles().evidence. */
export function agentTeamProfileSection(skill: MathAgentSkill, message: string, cards?: readonly FrozenPersonalExpert[]): ContextSection {
  return resolveAgentTeamProfiles(skill, message, cards).section;
}
