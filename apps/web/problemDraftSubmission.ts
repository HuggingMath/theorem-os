import { canonicalMathJson, mathDigest } from '../../src/math/mathRuntimeIo';
import { defaultResearchModulePlan } from '../../src/solver/modules/policy';
import type { ProblemDraftValue } from './problemDraftTypes';
import type { WebFormalization } from './formalizationTypes';
import type { WebRun } from './shared';
import type { ResearchReleaseRef } from './researchAssetTypes';

const equal = (left: unknown, right: unknown) => canonicalMathJson(left) === canonicalMathJson(right);
export function matchesProblemFormalization(value: ProblemDraftValue, item: WebFormalization): boolean {
  if (value.mode !== 'natural') return false;
  const { settings } = value;
  return item.original === value.text && item.workflow === 'solve' && item.environment === settings.environment
    && item.providerId === settings.providerId && item.model === settings.model.trim() && item.effort === settings.effort
    && Boolean(item.humanReview) === (settings.participation === 'guided') && item.maxRunSeconds === settings.maxRunSeconds
    && item.maxTotalTokens === settings.maxTotalTokens && equal(item.research, settings.research);
}
export function matchesProblemRun(value: ProblemDraftValue, run: WebRun): boolean {
  if (value.mode !== 'lean') return false;
  const { draft } = value, config = run.researchConfiguration;
  // The run endpoint trims ordinary Lean sources and instructions; keep the original draft unchanged.
  const submittedSource = run.formalization ? draft.source : draft.source.trim();
  if (run.source !== submittedSource || run.task !== draft.task.trim() || run.providerId !== draft.providerId || run.model !== draft.model.trim()
    || run.environment !== draft.environment || run.effort !== draft.effort || run.coordination !== draft.coordination
    || run.maxTurns !== Number(draft.maxTurns) || run.maxRunSeconds !== Number(draft.maxRunSeconds) || run.workers !== Number(draft.workers)
    || (run.maxTotalTokens ?? 0) !== Math.round(Number(draft.maxTotalTokens ?? '') * 10_000)
    || Boolean(run.planApproval) !== Boolean(draft.planApproval && draft.coordination === 'cooperative' && Number(draft.workers) >= 2)
    || draft.knowledgeDigest !== undefined && (run.knowledgeDigest ?? null) !== draft.knowledgeDigest) return false;
  const refs = [...(config?.agent ? [config.agent.ref] : []), ...(config?.skills.map(item => item.ref) ?? []), ...(config?.libraries.map(item => item.ref) ?? [])];
  const sameRef = (a: ResearchReleaseRef, b: ResearchReleaseRef) => a.assetId === b.assetId && a.version === b.version && (!a.digest || a.digest === b.digest);
  const selected = [...(value.libraries ?? [])];
  if (selected.some(ref => !refs.some(actual => sameRef(ref, actual)))) return false;
  // Frozen selections also contain Agent/Skill dependencies. Only those dependencies may be extra.
  for (let index = 0; index < selected.length; index++) {
    const ref = selected[index], agent = config?.agent && sameRef(ref, config.agent.ref) ? config.agent.content : undefined;
    const skill = config?.skills.find(item => sameRef(ref, item.ref))?.content;
    for (const dependency of [...(agent?.skills ?? []), ...(agent?.libraries ?? []), ...(skill?.dependencies ?? [])]) {
      if (!selected.some(item => sameRef(dependency, item))) selected.push(dependency);
    }
  }
  if (refs.some(ref => !selected.some(item => sameRef(item, ref)))) return false;
  const expectedPlan = draft.modulePlan ?? config?.agent?.content.modulePlan ?? defaultResearchModulePlan();
  const actualPlan = run.modulePlan ?? defaultResearchModulePlan();
  if (equal(expectedPlan, actualPlan)) return true;
  const skillIds = new Set(config?.skills.flatMap(item => item.content.slots.map(slot => `skill_${mathDigest(`${item.ref.assetId}\0${item.ref.version}\0${slot}`).slice(0, 24)}`)));
  return equal(expectedPlan, { ...actualPlan, custom: actualPlan.custom.filter(item => !skillIds.has(item.id)) });
}
