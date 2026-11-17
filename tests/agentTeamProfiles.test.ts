import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { mathDigest } from '../src/math/mathRuntimeIo';
import { agentTeamProfileEvidenceSchema, agentTeamProfileSection, agentTeamProfileSelection,
  resolveAgentTeamProfiles } from '../src/solver/agentTeamProfiles';

const skill = readMathAgentSkill(path.resolve('skills/theoremos-research/SKILL.md'));
const record = (text: string) => JSON.parse(text.split('\n')[1]!);

describe('Lead-selected professional knowledge', () => {
  it('loads domain knowledge, its collected reading and the independent work responsibility', () => {
    const { text } = agentTeamProfileSection(skill, 'Profiles: D006, prover\nStudy the specified representation.');
    expect(record(text)).toMatchObject({ skillDigest: skill.digest, selected: ['D006', 'prover'],
      loaded: ['D006', 'prover'], unresolved: [] });
    expect(text).toContain('references/domain-experts/algebra.md');
    expect(text).toContain('references/domain-materials/algebra.md#representation-theory');
    expect(text).toContain('Maschke');
    expect(text).toContain('Locator:');
    expect(text).toContain('### Lean Prover');
    expect(text).not.toContain('## commutative-algebra');
    expect(text).not.toContain('## real-analysis');
  });

  it('resolves a domain slug and linked support expertise, without loading aliases twice', () => {
    const { text } = agentTeamProfileSection(skill, 'Profiles: graph-theory, D064, certificate-engineer');
    expect(record(text)).toMatchObject({ loaded: ['D064', 'certificate-engineer'], unresolved: [] });
    expect(text).toContain('references/formal-specialists.md');
    expect(text.match(/Profile D064 /gu)).toHaveLength(1);
  });

  it('has a complete loadable profile and reading section for every published domain ID', () => {
    for (let index = 1; index <= 100; index++) {
      const id = 'D' + String(index).padStart(3, '0');
      const { text } = agentTeamProfileSection(skill, 'Profiles: ' + id);
      expect(record(text)).toMatchObject({ loaded: [id], unresolved: [] });
      expect(text).toContain('Collected reading; source: references/domain-materials/');
    }
  });

  it('selects only from the explicit opening line, not a mathematical reference or example in the task', () => {
    expect(agentTeamProfileSelection('Use D006 as a reading reference.\nProfiles: D041')).toEqual([]);
    expect(agentTeamProfileSelection('Discuss real-analysis and engineering.')).toEqual([]);
    expect(agentTeamProfileSelection('  Profiles: D041, prover, D041\r\nCurrent assignment')).toEqual(['D041', 'prover']);
  });

  it('keeps custom expertise explicit and does not invent loaded catalogue knowledge', () => {
    const { text } = agentTeamProfileSection(skill, 'Profiles: custom-specialty, engineer\nQuestion and custom background.');
    expect(record(text)).toMatchObject({ selected: ['custom-specialty', 'engineer'], loaded: ['engineer'],
      unresolved: ['custom-specialty'] });
    const unselected = agentTeamProfileSection(skill, 'A general research assignment.').text;
    expect(record(unselected)).toMatchObject({ selected: [], loaded: [], unresolved: [] });
  });

  it('returns serializable evidence binding every injected passage to its exact source bytes', () => {
    const { section, evidence } = resolveAgentTeamProfiles(skill, 'Profiles: D041, prover');
    expect(agentTeamProfileEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence)))).toEqual(evidence);
    expect(record(section.text)).toEqual(evidence);
    expect(evidence.sources.map(source => [source.profileId, source.kind])).toEqual([
      ['D041', 'profile'], ['D041', 'collected-reading'], ['prover', 'profile'],
    ]);
    for (const source of evidence.sources) {
      const text = fs.readFileSync(path.join(path.dirname(skill.path), source.file), 'utf8');
      const passage = text.split('\n').slice(source.firstLine - 1, source.lastLine).join('\n').trim();
      expect(mathDigest(text)).toBe(source.fileDigest);
      expect(mathDigest(passage)).toBe(source.digest);
      expect(section.text).toContain(passage);
    }
    expect(evidence.sources[0]).toMatchObject({ file: 'references/domain-experts/analysis.md',
      anchor: 'real-analysis', heading: 'real-analysis' });
  });

  it('resolves the current selection again on a resumed or amended assignment without retaining former expertise', () => {
    const old = resolveAgentTeamProfiles(skill, 'Profiles: D041, prover').evidence;
    const resumed = resolveAgentTeamProfiles(skill, 'Profiles: D041, prover').evidence;
    const amended = resolveAgentTeamProfiles(skill, 'Profiles: D006, custom-specialty, engineer').evidence;
    expect(resumed).toEqual(old);
    expect(amended).toMatchObject({ selected: ['D006', 'custom-specialty', 'engineer'],
      loaded: ['D006', 'engineer'], unresolved: ['custom-specialty'] });
    expect(amended.sources.every(source => source.profileId !== 'D041')).toBe(true);
    expect(amended.sources.every(source => source.profileId !== 'custom-specialty')).toBe(true);
    expect(old.loaded).toEqual(['D041', 'prover']);
  });

  it('changes material identity when a pinned reading changes while keeping a previous loading record intact', () => {
    const temporaryRoot = process.env.TMPDIR || '/data/lzh/default-storage/tmp';
    fs.mkdirSync(temporaryRoot, { recursive: true });
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'theoremos-profile-evidence-'));
    try {
      fs.mkdirSync(path.join(directory, 'references/domain-experts'), { recursive: true });
      fs.mkdirSync(path.join(directory, 'references/domain-materials'), { recursive: true });
      const entry = path.join(directory, 'SKILL.md');
      fs.writeFileSync(entry, '---\nname: example\ndescription: Load mathematical example knowledge.\n---\n');
      fs.writeFileSync(path.join(directory, 'references/domain-experts.md'),
        '| D041 | [实分析专家](domain-experts/analysis.md#real-analysis) | Real Analysis | `real-analysis` |\n');
      fs.writeFileSync(path.join(directory, 'references/domain-experts/analysis.md'),
        '## real-analysis\nBackground.\nReading: [Collected](../domain-materials/analysis.md#real-analysis).\n');
      const reading = path.join(directory, 'references/domain-materials/analysis.md');
      fs.writeFileSync(reading, '## real-analysis\nOriginal material.\n');
      const first = resolveAgentTeamProfiles(readMathAgentSkill(entry), 'Profiles: D041').evidence;
      fs.writeFileSync(reading, '## real-analysis\nRevised material.\n');
      const next = resolveAgentTeamProfiles(readMathAgentSkill(entry), 'Profiles: D041').evidence;
      expect(first.skillDigest).not.toBe(next.skillDigest);
      expect(first.sources[0]).toEqual(next.sources[0]);
      expect(first.sources[1]!.digest).not.toBe(next.sources[1]!.digest);
      expect(first.sources[1]!.fileDigest).not.toBe(next.sources[1]!.fileDigest);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
});
