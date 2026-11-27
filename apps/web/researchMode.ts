import { z } from 'zod';
import { MIN_TEAM_AGENTS, MAX_TEAM_AGENTS } from '../../src/solver/teamCapacity';
import { retiredPortfolioMessage, retiredResearchCoordinationMessage, type WebProvider, type WebRunInput } from './shared';

export const nativeTeamCapacitySchema = z.number().int().min(MIN_TEAM_AGENTS).max(MAX_TEAM_AGENTS);
export const nativeTeamPreferencesSchema = z.array(z.string().trim().min(1).max(100)).max(256);
export const webPortfolioSecondsSchema = z.number().int().min(1).max(86_400);

/** Team preset for Web callers. Capacity counts the Lead and its isolated members. */
export function webAgentTeamPreset(capacity = 3): Pick<WebRunInput, 'researchMode' | 'workers' | 'coordination' | 'nativeTeamCapacity'> {
  return { researchMode: 'skill', workers: 1, coordination: 'independent', nativeTeamCapacity: nativeTeamCapacitySchema.parse(capacity) };
}

const requestsRetiredPortfolio = (input: Pick<WebRunInput, 'portfolioExploration' | 'portfolioSeconds'>) =>
  input.portfolioExploration === true || input.portfolioSeconds !== undefined;

export function retiredWebRunInputError(input: Partial<Pick<WebRunInput, 'workers' | 'portfolioExploration' | 'portfolioSeconds'>>) {
  if ((input.workers ?? 1) > 1) return retiredResearchCoordinationMessage;
  if (requestsRetiredPortfolio(input)) return retiredPortfolioMessage;
}

/** The optional research engine is frozen with each new run, never changed by an observation. */
export function webResearchModeError(input: Pick<WebRunInput, 'researchMode' | 'skillLoading' | 'workers' |
  'coordination' | 'planApproval' | 'modulePlan' | 'researchSelection' | 'nativeTeamCapacity' | 'nativeTeamPreferredProfiles' |
  'portfolioExploration' | 'portfolioSeconds'>, provider?: Pick<WebProvider, 'harness'>): string | undefined {
  if (requestsRetiredPortfolio(input)) return retiredPortfolioMessage;
  if (input.nativeTeamPreferredProfiles?.length && input.nativeTeamCapacity === undefined) return '角色偏好仅适用于 Codex 原生团队。';
  if (input.nativeTeamCapacity !== undefined) {
    if (!nativeTeamCapacitySchema.safeParse(input.nativeTeamCapacity).success)
      return '原生团队容量必须为 2 至 8 人（含 Lead）。';
    if (provider?.harness && provider.harness !== 'codex') return '原生团队需要 Codex 执行器。';
    if (input.researchMode !== 'skill' || input.workers !== 1 || input.coordination !== 'independent' || input.modulePlan)
      return '原生团队由一名 Lead 自主派工，不能与宿主协作或自定义模块方案一起使用。';
  }
  if (input.researchMode !== undefined && !['legacy', 'skill'].includes(input.researchMode)) return '研究方式无效。';
  if (input.skillLoading !== undefined && !['native', 'file'].includes(input.skillLoading)) return '技能加载方式无效。';
  if (input.researchMode !== 'skill') return input.skillLoading === undefined ? undefined : '技能加载选项需要 Skill 研究方式。';
}

export function webResearchArguments(input: WebRunInput, provider?: Pick<WebProvider, 'harness'>): string[] {
  const error = retiredWebRunInputError(input) ?? webResearchModeError(input, provider);
  if (error) throw new Error(error);
  return input.researchMode === 'skill'
    ? ['--research-mode', 'skill', '--skill-loading', input.skillLoading ?? webDefaultSkillLoading(provider),
      ...(input.nativeTeamCapacity ? ['--skill-delegation', 'team', '--skill-max-agents', String(input.nativeTeamCapacity)] : []),
      ...(input.nativeTeamPreferredProfiles?.length ? ['--skill-preferred-profiles', input.nativeTeamPreferredProfiles.join(',')] : [])] : [];
}

/** A Skill changes research methods; only the execution arrangement controls collaboration. */
export const webSkillWithoutCooperation = (input: Pick<WebRunInput, 'researchMode' | 'workers' | 'coordination'>) =>
  input.researchMode === 'skill' && !(input.coordination === 'cooperative' && input.workers > 1);

export const webDefaultSkillLoading = (provider?: Pick<WebProvider, 'harness'>): 'native' | 'file' =>
  provider?.harness && provider.harness !== 'codex' ? 'file' : 'native';
