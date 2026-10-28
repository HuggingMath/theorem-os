/**
 * Durable Lead wake-ups. An event that needs a Lead decision is numbered and saved with the state that
 * produced it, so a restart re-asks an unanswered decision instead of re-guessing it from task statuses.
 * Conditions recomputed from durable state on every dispatch (pause or rejection digests, a reconsidered
 * blocked frontier) are not wake-ups; only one-shot events that would otherwise be lost are.
 */
export type LeadWakeReason =
  | 'initial-plan' | 'restored-legacy-state' | 'canonical-source-invalid'
  | 'task-type-invalid' | 'feasibility-review-reassigned' | 'task-check-failed' | 'task-repeated-attempt'
  | 'task-repeated-input-blocked' | 'task-blocked' | 'task-delivery-rejected' | 'worker-stopped'
  | 'integration-blocked' | 'conditional-recheck-failed' | 'research-finding' | 'progress-decision-requested'
  | 'route-blocker-recorded' | 'route-reopened' | 'review-changes-requested' | 'statement-review-rejected'
  | 'assembly-failed' | 'plan-rejected' | 'lead-draft-preserved' | 'lead-checkpoint-unchanged'
  | 'lead-turn-superseded' | 'lead-turn-interrupted' | 'lead-turn-rejected' | 'lead-pause-idle';

/** Unchanged checkpoints after which an unfinished Lead slice stops doubling; a pause past it is final. */
export const LEAD_MAX_BACKOFF = 3;

/**
 * `requested` numbers wake-ups; `consumed` is the last one a dispatch took or a dedupe gate answered;
 * `settled` is the last consumed one whose Lead turn ended. Always settled <= consumed <= requested.
 */
export type LeadWakes = { requested: number; consumed: number; settled: number;
  recent?: { seq: number; reason: LeadWakeReason; at: number }[] };

const RECENT_LEAD_WAKES = 16;

export const emptyLeadWakes = (): LeadWakes => ({ requested: 0, consumed: 0, settled: 0 });
export const leadWakePending = (wakes: LeadWakes) => wakes.requested > wakes.consumed;

export function requestLeadWake(wakes: LeadWakes, reason: LeadWakeReason, at = Date.now()) {
  wakes.requested++;
  wakes.recent = [...wakes.recent ?? [], { seq: wakes.requested, reason, at }].slice(-RECENT_LEAD_WAKES);
}
/** A dispatch takes every wake-up requested before it was admitted; later ones stay pending. */
export function consumeLeadWakes(wakes: LeadWakes, through = wakes.requested) {
  wakes.consumed = Math.max(wakes.consumed, Math.min(through, wakes.requested));
}
/** Wake-ups answered without a turn (unchanged input, stalled rejection, an adopted saved plan). */
export function dropLeadWakes(wakes: LeadWakes, through = wakes.requested) {
  consumeLeadWakes(wakes, through); wakes.settled = wakes.consumed;
}
/** The previous Lead turn ended: its consumed wake-ups no longer depend on the live process. */
export function settleLeadWakes(wakes: LeadWakes) { wakes.settled = wakes.consumed; }
/** A new process has no live Lead turn, so an unsettled dispatch's wake-ups are pending again. */
export function reopenLeadWakes(wakes: LeadWakes) { wakes.consumed = wakes.settled; }

export function leadWakeViolations(wakes: LeadWakes): string[] {
  const counts = [wakes.settled, wakes.consumed, wakes.requested];
  if (counts.some(value => !Number.isSafeInteger(value) || value < 0)) return ['Lead wake counters are not counts.'];
  if (wakes.settled > wakes.consumed || wakes.consumed > wakes.requested)
    return [`Lead wake counters are out of order: settled ${wakes.settled}, consumed ${wakes.consumed}, requested ${wakes.requested}.`];
  return (wakes.recent ?? []).some(item => item.seq > wakes.requested || item.seq < 1)
    ? ['A recent Lead wake names an unrequested sequence number.'] : [];
}
