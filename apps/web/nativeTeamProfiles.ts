import { fileURLToPath } from 'node:url';
import { eligibleAgentTeamProfiles, normalizeTeamProfilePreferences } from '../../src/solver/agentTeamProfiles';
import { WebStorageError } from './storage';
import type { WebRunInput, WebTeamProfile } from './shared';

const directory = fileURLToPath(new URL('../../skills/theoremos-research/', import.meta.url));
export function webTeamProfiles(): WebTeamProfile[] {
  const profiles = eligibleAgentTeamProfiles(directory);
  if (!profiles.length) throw new WebStorageError(503, '原生团队的角色目录不可用。');
  return profiles;
}

export function normalizeWebTeamPreferences(input: WebRunInput): WebRunInput {
  if (input.nativeTeamPreferredProfiles === undefined) return input;
  const { nativeTeamPreferredProfiles: names, ...rest } = input;
  if (!names.length) return rest;
  const profiles = webTeamProfiles();
  try { return { ...rest, nativeTeamPreferredProfiles: normalizeTeamProfilePreferences(profiles, names) }; }
  catch {
    const unknown = names.find(value => !profiles.some(profile => profile.id === value.trim() || profile.alias === value.trim()));
    throw new WebStorageError(400, `无法选择角色偏好：${unknown}。请从当前角色目录中选择。`);
  }
}
