import { isWebAgentActionBody, isWebAgentLeanCheck } from './agentActions';
import { webFormalizationActivityLimits as limits, webFormalizationRoles, type WebFormalizationActivityBody } from './formalizationTypes';

/**
 * The check the server applies to a formalization worker's activity messages (see formalizationActivity.ts). Kept apart
 * from the worker side, which reaches into the runtime's session types, so the server does not compile them.
 */
type Item = Record<string, unknown>;
const object = (value: unknown): Item | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : undefined;
const only = (item: Item, allowed: readonly string[]) => Object.keys(item).every(key => allowed.includes(key));
const short = (value: unknown, limit: number) => value === undefined || typeof value === 'string' && value.length <= limit;
const flag = (value: unknown) => value === undefined || value === true;
const reasonCode = (value: unknown) => typeof value === 'string' && /^[a-z0-9_]{1,100}$/u.test(value);
const strings = (value: unknown, count: number, limit: number) => Array.isArray(value) && value.length <= count && value.every(item => typeof item === 'string' && item.length <= limit);

function isSummary(value: unknown) {
  const summary = object(value);
  return !!summary && only(summary, ['verdict', 'taskKind', 'text', 'sections']) &&
    (summary.verdict === undefined || ['approved', 'changes_requested', 'unknown'].includes(summary.verdict as string)) &&
    (summary.taskKind === undefined || ['prove', 'decision', 'construction'].includes(summary.taskKind as string)) &&
    short(summary.text, limits.summaryText) && Array.isArray(summary.sections) && summary.sections.length <= 8 && summary.sections.every(entry => {
      const section = object(entry);
      return !!section && only(section, ['kind', 'items', 'omitted']) &&
        ['conclusions', 'assumptions', 'definitions', 'unresolved', 'targets', 'issues'].includes(section.kind as string) &&
        strings(section.items, limits.summaryItems, limits.summaryItem) &&
        (section.omitted === undefined || typeof section.omitted === 'number' && Number.isSafeInteger(section.omitted) && section.omitted > 0);
    });
}
function isStep(value: unknown) {
  const step = object(value);
  if (!step || typeof step.round !== 'number' || !Number.isSafeInteger(step.round) || step.round < 1 || step.round > 1_000) return false;
  switch (step.step) {
    case 'role': return only(step, ['round', 'step', 'workerId', 'role', 'slot', 'state', 'summary', 'reason']) &&
      typeof step.workerId === 'string' && /^[A-Za-z0-9_-]{1,64}$/u.test(step.workerId) &&
      (webFormalizationRoles as readonly unknown[]).includes(step.role) && typeof step.slot === 'string' && /^[A-Za-z0-9_-]{1,60}$/u.test(step.slot) &&
      ['started', 'finished', 'failed'].includes(step.state as string) && (step.summary === undefined || isSummary(step.summary)) &&
      (step.reason === undefined || reasonCode(step.reason));
    case 'compile': return only(step, ['round', 'step', 'state', 'source', 'sourceClipped', 'targets', 'lean', 'text']) &&
      ['started', 'passed', 'failed'].includes(step.state as string) && short(step.source, limits.source) && flag(step.sourceClipped) &&
      (step.targets === undefined || strings(step.targets, limits.targets, 200)) && (step.lean === undefined || isWebAgentLeanCheck(step.lean)) &&
      short(step.text, limits.summaryText);
    case 'revision': return only(step, ['round', 'step', 'stage', 'text', 'textClipped']) && ['plan', 'round'].includes(step.stage as string) &&
      typeof step.text === 'string' && short(step.text, limits.feedback) && flag(step.textClipped);
    case 'approved': return only(step, ['round', 'step']);
    case 'stopped': return only(step, ['round', 'step', 'reason', 'text', 'textClipped']) && reasonCode(step.reason) &&
      short(step.text, limits.feedback) && flag(step.textClipped);
    default: return false;
  }
}

/** The shape and limits createFormalizationActivity produces; the server stores nothing else from a worker. */
export function isWebFormalizationActivityBody(value: unknown): value is WebFormalizationActivityBody {
  const entry = object(value);
  if (!entry || JSON.stringify(entry).length > limits.encoded) return false;
  if (entry.type === 'action') return only(entry, ['type', 'action']) && isWebAgentActionBody(entry.action);
  return entry.type === 'step' && only(entry, ['type', 'step']) && isStep(entry.step);
}
