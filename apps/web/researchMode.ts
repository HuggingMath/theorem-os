import type { WebProvider, WebRunInput } from './shared';

/** The optional research engine is frozen with each new run, never changed by an observation. */
export function webResearchModeError(input: Pick<WebRunInput, 'researchMode' | 'skillLoading' | 'workers' |
  'coordination' | 'planApproval' | 'modulePlan' | 'researchSelection'>): string | undefined {
  if (input.researchMode !== undefined && !['legacy', 'skill'].includes(input.researchMode)) return '研究方式无效。';
  if (input.skillLoading !== undefined && !['native', 'file'].includes(input.skillLoading)) return '技能加载方式无效。';
  if (input.researchMode !== 'skill') return input.skillLoading === undefined ? undefined : '技能加载选项需要 Skill 研究方式。';
}

export function webResearchArguments(input: WebRunInput, provider?: Pick<WebProvider, 'harness'>): string[] {
  const error = webResearchModeError(input);
  if (error) throw new Error(error);
  return input.researchMode === 'skill'
    ? ['--research-mode', 'skill', '--skill-loading', input.skillLoading ?? webDefaultSkillLoading(provider)] : [];
}

/** A Skill changes research methods; only the execution arrangement controls collaboration. */
export const webSkillWithoutCooperation = (input: Pick<WebRunInput, 'researchMode' | 'workers' | 'coordination'>) =>
  input.researchMode === 'skill' && !(input.coordination === 'cooperative' && input.workers > 1);

export const webDefaultSkillLoading = (provider?: Pick<WebProvider, 'harness'>): 'native' | 'file' =>
  provider?.harness && provider.harness !== 'codex' ? 'file' : 'native';
