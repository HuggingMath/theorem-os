import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WebResearchAssets } from '../apps/web/researchAssets';
import { WebStorage } from '../apps/web/storage';
import type { WorkerInput } from '../apps/web/shared';
import { webExpertCardArguments } from '../apps/web/worker';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { resolveAgentTeamProfiles } from '../src/solver/agentTeamProfiles';
import { readPersonalExperts } from '../src/solver/personalExperts';

it('passes a private release from web selection to the assigned profile only, with no legacy policy', async () => {
  const owner = 'fixture-owner', directory = fs.mkdtempSync(path.join(os.tmpdir(), 'web-expert-handoff-'));
  const assets = new WebResearchAssets(new WebStorage(directory));
  try {
    const knowledge = 'Products of compact spaces are compact in the product topology.';
    const item = assets.create(owner, { requestId: 'create', type: 'skill', name: 'Topology expert',
      description: 'Product topologies', content: { mode: 'replace', instructions: 'Use the legacy selector.',
        examples: [knowledge] } });
    const release = await assets.publish(owner, item.id, { requestId: 'publish', expectedRevision: item.revision,
      version: 'v1', license: 'private', visibility: 'private' });
    const ref = (await assets.waitForPublication(owner, release.id)).release!;
    const researchConfiguration = assets.freezeNativeTeam(owner, { skills: [ref] }, 'standard');
    const input: WorkerInput['input'] = { providerId: 'fixture', model: 'fixture', effort: 'high', apiKey: 'fixture',
      task: 'Test', source: 'theorem goal : True := by sorry', workers: 1, coordination: 'independent',
      researchMode: 'skill', maxTurns: 0, maxRunSeconds: 0, nativeTeamCapacity: 8 };
    const [flag, file] = webExpertCardArguments(directory, { input, researchConfiguration });
    expect(flag).toBe('--skill-expert-cards-file');
    const frozen = readPersonalExperts(file!)!;
    const skill = readMathAgentSkill(path.resolve('skills/theoremos-research/SKILL.md'));
    const assignment = resolveAgentTeamProfiles(skill, 'Profiles: researcher, asset:' + item.id, frozen.cards);
    expect(assignment.section.text).toContain(knowledge);
    expect(assignment.section.text).not.toContain('Use the legacy selector.');
    expect(assignment.evidence.sources).toContainEqual(expect.objectContaining({ profileId: 'asset:' + item.id,
      assetVersion: 'v1', releaseDigest: ref.digest }));
    expect(resolveAgentTeamProfiles(skill, 'Profiles: engineer', frozen.cards).section.text).not.toContain(knowledge);
  } finally { await assets.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
