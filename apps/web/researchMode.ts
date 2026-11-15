import type { WebRunInput } from './shared';

/** The optional research engine is frozen with each new run, never changed by an observation. */
export function webResearchModeError(input: Pick<WebRunInput, 'researchMode' | 'skillLoading' | 'workers' |
  'coordination' | 'planApproval' | 'modulePlan' | 'researchSelection'>): string | undefined {
  if (input.researchMode !== undefined && !['legacy', 'skill'].includes(input.researchMode)) return '研究方式无效。';
  if (input.skillLoading !== undefined && !['native', 'file'].includes(input.skillLoading)) return '技能加载方式无效。';
  if (input.researchMode !== 'skill') return input.skillLoading === undefined ? undefined : '技能加载选项需要单研究者模式。';
  if (input.workers !== 1 || input.coordination !== 'independent' || input.planApproval || input.modulePlan ||
      input.researchSelection?.agent || input.researchSelection?.skills?.length)
    return '单研究者模式需要 1 个 Agent 和独立研究，不能同时使用协作计划或自定义研究策略。';
}

export function webResearchArguments(input: WebRunInput): string[] {
  const error = webResearchModeError(input);
  if (error) throw new Error(error);
  return input.researchMode === 'skill'
    ? ['--research-mode', 'skill', '--skill-loading', input.skillLoading ?? 'native'] : [];
}
