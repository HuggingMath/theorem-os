import { parseMathResponse, type DeliveryRecord } from './deliveries';
import { bindMathematicalGap, mathematicalGapSchema, type MathematicalGap, type MathematicalGapScope } from './mathematicalGaps';
import { type CooperativeTask, type TaskAssignment, type TaskRecord } from './tasks';
import { researchReferenceIssues, type ResearchSourceUse } from './researchReferences';
import { checkOutcomeSchema, type CheckOutcome, type NextCheckRecord, type NextCheckScope } from './nextCheckContract';
import { bindCheckOutcome } from './nextChecks';
import type { ProofSearchRecord } from './proofSearchRecords';

export type ResearchSubmission =
  | Readonly<{ kind: 'notes'; text: string }>
  | Readonly<{ kind: 'event'; value: unknown }>;
export type ResearchAdmissionScope = Readonly<{
  source: CooperativeTask;
  assignment: TaskAssignment;
  identity: Readonly<{ problemReceiptDigest: string; environmentDigest: string }>;
  tasks: readonly TaskRecord[];
  deliveries?: readonly DeliveryRecord[];
  nextChecks?: readonly NextCheckRecord[];
  proofSearchRecords?: Readonly<Record<string, ProofSearchRecord>>;
}>;
export type ResearchFinding = Record<string, unknown> & {
  taskId: string;
  taskDigest: string;
  conclusion: 'supporting' | 'refuted' | 'inconclusive';
  summary: string;
  mathematicalGap?: MathematicalGap;
  sourceUses?: readonly ResearchSourceUse[];
  checkOutcome?: CheckOutcome;
};
export type ResearchAdmissionIssue = Readonly<{ path: string; message: string }>;
export type ResearchAdmission =
  | Readonly<{ status: 'admitted'; finding: ResearchFinding; mathematicalGapScope?: MathematicalGapScope; checkOutcomeScope?: NextCheckScope }>
  | Readonly<{ status: 'rejected'; code: string; issues: readonly ResearchAdmissionIssue[];
      recovery: 'correct-and-resubmit' | 'assignment-superseded' }>;

/** Carries correctable field feedback through the existing delivery rejection paths. */
export class ResearchAdmissionError extends Error {
  readonly issues: readonly ResearchAdmissionIssue[];
  readonly recovery: 'correct-and-resubmit' | 'assignment-superseded';
  constructor(readonly admission: Extract<ResearchAdmission, { status: 'rejected' }>) {
    super(admission.code);
    this.name = 'ResearchAdmissionError';
    this.issues = admission.issues;
    this.recovery = admission.recovery;
  }
}

const rejection = (code: string, path: string, message: string): ResearchAdmission => ({
  status: 'rejected', code, issues: [{ path, message }], recovery: 'correct-and-resubmit',
});
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Admit advisory reports only: Git, artifacts and independent Lean acceptance remain host responsibilities. */
export function prepareResearchDelivery(input: ResearchSubmission, scope: ResearchAdmissionScope): ResearchAdmission {
  let value: unknown;
  if (input.kind === 'notes') {
    try { value = parseMathResponse(input.text, 'math-result', {}, 'summary'); }
    catch (error) {
      if (error instanceof SyntaxError)
        return rejection('math_research_delivery_invalid', '$', 'The research control response must contain valid JSON.');
      if (error instanceof Error && /^math_(?:math-result_requires_one_block|response_invalid)$/u.test(error.message))
        return rejection(error.message, '$', error.message === 'math_response_invalid'
          ? 'The research control response must be a JSON object.' : 'Publish exactly one math-result response.');
      throw error;
    }
  } else value = input.value;
  if (!object(value)) return rejection('math_research_delivery_invalid', '$', 'The research finding must be an object.');
  for (const [key, expected] of [['taskId', scope.assignment.taskId], ['taskDigest', scope.assignment.taskDigest]] as const) {
    if (Object.hasOwn(value, key) && value[key] !== expected)
      return rejection('math_research_delivery_invalid', key, 'Use the frozen assignment ' + key + ': ' + expected + '.');
  }
  const finding: Record<string, unknown> = { taskId: scope.assignment.taskId, taskDigest: scope.assignment.taskDigest,
    conclusion: 'inconclusive', ...value };
  if (typeof finding.summary !== 'string' || !finding.summary.trim())
    return rejection('math_research_delivery_invalid', 'summary', 'Provide a nonempty summary of the finding.');
  if (!['supporting', 'refuted', 'inconclusive'].includes(finding.conclusion as string))
    return rejection('math_research_delivery_invalid', 'conclusion', 'Use supporting, refuted, or inconclusive.');
  if (finding.statement !== undefined && (typeof finding.statement !== 'string' || !finding.statement.trim()))
    return rejection('math_delivery_invalid', 'statement', 'Provide a nonempty statement string.');
  for (const key of ['premises', 'remainingObligations']) {
    if (finding[key] !== undefined && (!Array.isArray(finding[key]) ||
        !(finding[key] as unknown[]).every(item => typeof item === 'string')))
      return rejection('math_delivery_invalid', key, 'Provide an array of strings.');
  }
  const referenceIssues = researchReferenceIssues(finding.sourceUses, scope.source, scope.tasks, finding.lemmaRequests);
  if (referenceIssues.length) return { status: 'rejected', code: 'math_research_delivery_invalid',
    issues: referenceIssues, recovery: 'correct-and-resubmit' };
  let mathematicalGapScope: MathematicalGapScope | undefined;
  if (finding.mathematicalGap !== undefined) {
    const parsed = mathematicalGapSchema.safeParse(finding.mathematicalGap);
    if (!parsed.success) return { status: 'rejected', code: 'math_delivery_invalid', recovery: 'correct-and-resubmit',
      issues: parsed.error.issues.map(issue => ({ path: ['mathematicalGap', ...issue.path].join('.'), message: issue.message })) };
    finding.mathematicalGap = parsed.data;
    try { mathematicalGapScope = bindMathematicalGap(parsed.data, scope.source, scope, scope.identity); }
    catch (error) {
      if (!(error instanceof Error) || !/^math_delivery_invalid:gap_(?:consumer|previous|dependency|next_check_target)$/u.test(error.message)) throw error;
      const issue = error.message.endsWith('gap_previous')
        ? { path: 'mathematicalGap.previousDeliveryId', message: 'Reference a visible prior gap delivery with an immutable scope for this consumer and problem; omit the reference if none exists.' }
        : error.message.endsWith('gap_next_check_target')
          ? { path: 'mathematicalGap.nextCheck', message: 'Reference a visible planned task. Executable checks require its exact current contract and file/declaration context; proof-search requires a typed ordinary lemma. Host advisory checks cannot be targets.' }
        : error.message.endsWith('gap_consumer')
          ? { path: 'mathematicalGap.consumer', message: 'Reference the exact current visible goal contract by taskId and taskDigest.' }
          : { path: 'mathematicalGap', message: 'The source dependency scope is unavailable; refresh the assignment inputs.' };
      return { status: 'rejected', code: error.message, issues: [issue], recovery: 'correct-and-resubmit' };
    }
  }
  let checkOutcomeScope: NextCheckScope | undefined;
  if (finding.checkOutcome !== undefined) {
    const parsed = checkOutcomeSchema.safeParse(finding.checkOutcome);
    if (!parsed.success) return { status: 'rejected', code: 'math_research_delivery_invalid', recovery: 'correct-and-resubmit',
      issues: parsed.error.issues.map(issue => ({ path: ['checkOutcome', ...issue.path].join('.'), message: issue.message })) };
    try { checkOutcomeScope = bindCheckOutcome(parsed.data, scope.source, scope.assignment, scope, scope.identity); }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'math_delivery_invalid:check_outcome_scope') throw error;
      return rejection(error.message, 'checkOutcome.checkId', 'Use the pending check assigned to this task in COOPERATION.json.nextChecks; changed inputs require a new scoped check.');
    }
    if (value.conclusion !== undefined && value.conclusion !== parsed.data.conclusion)
      return rejection('math_research_delivery_invalid', 'conclusion', 'Match the scoped checkOutcome conclusion.');
    finding.checkOutcome = parsed.data; finding.conclusion = parsed.data.conclusion; finding.needsDecision = true;
  } else if (input.kind === 'notes' && scope.nextChecks?.some(record => record.taskId === scope.source.id && record.status === 'pending'))
    return rejection('math_research_delivery_invalid', 'checkOutcome', 'Complete this scoped investigation with checkOutcome; use inconclusive when the requested inference remains unknown.');
  return { status: 'admitted', finding: finding as ResearchFinding, ...(mathematicalGapScope ? { mathematicalGapScope } : {}),
    ...(checkOutcomeScope ? { checkOutcomeScope } : {}) };
}
