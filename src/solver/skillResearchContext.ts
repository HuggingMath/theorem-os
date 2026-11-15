import fs from 'node:fs';
import path from 'node:path';
import { mathematicsRuntimeInstruction } from '../math/mathRuntimeEnvironment';
import { mathToolsInstruction } from '../math/mathTools';
import { assertMathAgentSkillsCurrent, type MathAgentSkill } from '../runtime/agentSkills';
import type { SolverRunState } from './archive';
import { compileContextSections, type ContextSection } from './contextCompiler';
import { continuationContextSection, readContinuationSnapshot } from './continuationInput';
import { DECLARATION_INDEX_FILE } from './declarationIndex';
import { solverProofFeedback } from './feedback';
import type { ContextAccess, ContextBundle, ResearchDispatchOptions } from './modules/context';
import type { SolverProblem } from './problem';
import { ResearchToolHelpBuilder, materializeResearchToolHelp } from './researchToolHelp';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Only selected after this frozen responsibility was actually dispatched to the same native thread. */
export function skillResearchContinuationSection(problem: Pick<SolverProblem, 'receiptDigest'>,
  state: Pick<SolverRunState, 'environmentDigest'>): ContextSection {
  return { id: 'same-thread-skill-research', kind: 'continuation',
    text: 'Continue the same original research in this saved thread using the pinned skill. ' +
      'The full frozen task and original statement are already in this thread; their source and acceptance rules still apply. ' +
      'Read current owned sources and RESEARCH.md before relying on saved claims.\n' +
      JSON.stringify({ problemReceiptDigest: problem.receiptDigest, environmentDigest: state.environmentDigest }) };
}

/** Stable host contracts and current facts; research methods live in the pinned skill. */
export function buildSkillResearchContext(problem: SolverProblem, state: Readonly<SolverRunState>,
  access: ContextAccess & { researchSkill: MathAgentSkill }): ContextBundle {
  const skill = access.researchSkill;
  assertMathAgentSkillsCurrent([skill]);
  if (!state.researchSkill || state.researchSkill.digest !== skill.digest || state.researchSkill.name !== skill.name ||
      state.researchSkill.loading !== skill.loading) throw new Error('math_research_skill_changed');
  const command = `bun ${quote(access.tools ?? path.join(access.root, 'bin/math.ts'))}`;
  const project = path.join(access.worktree, problem.projectRelative);
  const help = new ResearchToolHelpBuilder();
  help.section('lean', `${command} check-lean --worktree ${quote(access.worktree)} --file 'OWNED_FILE.lean' --timeout-seconds 0\n` +
    'Repeat --file for all relevant saved source files. Paths are relative to the Lean project, without its prefix. ' +
    'Read firstBlocking and diagnosticArtifacts; stdout is JSON and stderr is progress. Poll unfinished processes. ' +
    'Digests use the diagnostic tool scheme; an unchanged successful result can be reused. A local diagnostic is advisory.\n' +
    `${command} declarations search --index ${quote(path.join(access.worktree, DECLARATION_INDEX_FILE))} --query 'KEYWORDS'\n` +
    `${command} declarations get --index ${quote(path.join(access.worktree, DECLARATION_INDEX_FILE))} --name 'QUALIFIED_NAME'\n` +
    'Read the saved source for complete scopes, imports and types; the index is a bounded lexical aid.', '');
  help.section('delivery', 'Save useful source and worktree-root RESEARCH.md before returning. The host confirms writer shutdown and freezes actual source. ' +
    'A successful check-lean covering every original proof file, with no remaining proof holes, also hands writing back automatically. ' +
    'Only independent host checks of all original targets can accept the original problem.\n' +
    'To publish independent declarations while the original problem is unfinished, write ' +
    quote(path.join(access.worktree, '.scratch/declaration-submission.json')) + ' containing ' +
    '{"declarations":[{"file":"OWNED_FILE.lean","name":"Qualified.helper","type":"COMPLETE_CLOSED_LEAN_TYPE"}]}, then stop editing and return. ' +
    'Optional description and premises describe scope, not additional proof authority. The host verifies each actual declaration and complete type independently. ' +
    'Other incomplete goals may remain; a helper that depends on them or on new axioms is rejected. ' +
    'The request is consumed after the turn, and its host feedback is saved at .scratch/declaration-feedback.json. ' +
    'It never claims the original problem is solved. No task graph, role acknowledgment or fabricated receipt is required.', '');
  if (access.corpusFile) help.section('lean-search', `${command} search-lean --workspace ${quote(access.retrievalRoot)} ` +
    `--corpus ${quote(access.corpusFile)} --query 'SHORT_LIBRARY_KEYWORDS' --goal 'EXACT_LEAN_GOAL_AND_CONTEXT'\n` +
    'Up to eight --query arguments share one scan. Hits are lexical hints; inspect source and test applicability.', '');
  if (access.knowledgeFile) {
    if (!access.knowledgeDigest || access.knowledgeDigest !== state.knowledgeDigest) throw new Error('math_knowledge_identity_changed');
    const catalog = `--catalog ${quote(access.knowledgeFile)} --sha256 ${quote(access.knowledgeDigest)}`;
    help.section('knowledge', `${command} knowledge search ${catalog} --environment ${quote(state.environmentDigest)} ` +
      `--problem-receipt ${quote(problem.receiptDigest)} --query 'KEYWORDS' --goal 'EXACT_LEAN_CONTEXT'\n` +
      `${command} knowledge get ${catalog} --id 'THEOREM_ID' --metadata --max-bytes 16000\n` +
      'Follow field read handles and nextOffset until complete. Read complete types, premises and dependencies before reuse. ' +
      'Historical evidence requires a fresh current check. Installed-frozen declarations are imported by name, never copied or redeclared. ' +
      'Adapt only allowed archived declarations and their required dependencies into owned files. A search miss does not show a theorem is absent.', '');
  } else if (state.knowledgeDigest) throw new Error('math_knowledge_identity_missing');
  if (access.libraryCatalog) help.section('library', `${command} library search --worktree ${quote(access.worktree)} --query 'KEYWORDS' --goal 'EXACT_LEAN_CONTEXT'\n` +
    `${command} library get --worktree ${quote(access.worktree)} --name 'QUALIFIED_NAME' --max-bytes 16000\n` +
    'Follow nextOffset until the source is complete. Import installed-frozen names; do not copy library sources. ' +
    `${command} library request --worktree ${quote(access.worktree)} --name 'QUALIFIED_NAME' --reason 'EXACT_USE_AND_PREMISES'\n` +
    'A request saves the current run for host-controlled continuation; it does not mutate frozen dependencies or accept a proof.', '');
  help.section('other-tools', `${command} --help lists available commands. Read COMMAND --help before using an unfamiliar interface. ` +
    'Use native web search when actually exposed. Finite checks, proof-search and kernel-certificate do not call a model or accept the original problem. ' +
    'Their exact input formats are available from their existing --help commands.', '');
  materializeResearchToolHelp({ toolHelp: help.build() }, access.worktree);
  const editable = problem.ownedFiles.filter(file => !Object.hasOwn(problem.frozenFiles ?? {}, file));
  const instructions = 'Research the fixed original mathematics problem in this isolated worktree using the pinned theoremos-research skill.\n' +
    `Lean project: ${project}. Editable Lean paths relative to it: ${JSON.stringify(editable)}. ` +
    `Public research notes: ${path.join(access.worktree, 'RESEARCH.md')}. Temporary experiments and requests belong in .scratch/tmp or the documented .scratch paths.\n` +
    'Keep original declaration kinds, names, types, hypotheses, imports, options and scopes fixed; fill only allowed proof/definition bodies. ' +
    'Preserve trusted files and frozen definitions. New imports must be permitted by the frozen source policy. ' +
    'Accepted proofs cannot use sorry, admit, native_decide, unsafe or new axioms. Independent helpers may be submitted while other goals remain unfinished. ' +
    'Do not read external candidate solutions. Do not edit the pinned skill, host help, configuration or receipts. ' +
    'A message, local diagnostic or historical receipt is never acceptance. The host freezes sources after writer shutdown and checks every original target. ' +
    'There is no host task graph or timed research slice in this mode. ' +
    (state.researchDelegation ? `Native read-only investigators are available on demand, with at most ${state.researchDelegation.maxAgents} agents including you. ` +
      'Delegate bounded questions only when parallel work helps. Children return advisory findings or candidates; you alone integrate formal sources. ' +
      'Wait for useful results before returning; the host stops the entire session tree on delivery. All provider requests share your total allowance.\n'
      : 'Native child delegation is disabled in this run.\n') +
    help.instruction(access.worktree) + mathematicsRuntimeInstruction(access.environment.DEEPSCIENTIST_MATH_ENV_FILE) +
    (access.mathTools ? '\n' + mathToolsInstruction(access.mathTools, access.worktree) : '');
  const originalProblem: ContextSection = { id: 'original-problem', kind: 'problem', text: access.taskText + '\n\n' +
    JSON.stringify({ problemReceiptDigest: problem.receiptDigest, environmentDigest: state.environmentDigest,
      statement: problem.contract.informalStatement, formalStatement: problem.contract.formalStatement,
      assumptions: problem.contract.assumptions, targets: problem.targets,
      baselineCommit: problem.baseCommit, ownedFiles: problem.ownedFiles, frozenFiles: Object.keys(problem.frozenFiles ?? {}) }) };
  const mandatory: ContextSection[] = [];
  const feedback = [access.sourceFeedback, state.check && !state.check.passed
    ? solverProofFeedback(state.check, access.previousCheck, access.previousFailures) : undefined].filter(Boolean).join('\n\n');
  if (feedback) mandatory.push({ id: 'host-feedback', kind: 'feedback', text: feedback });
  const declarationFeedback = path.join(access.worktree, '.scratch/declaration-feedback.json');
  if (fs.existsSync(declarationFeedback)) mandatory.push({ id: 'declaration-feedback', kind: 'feedback',
    text: `Declaration check feedback is saved at ${declarationFeedback}; read it before resubmitting those declarations.` });
  if (Boolean(access.continuation) !== Boolean(state.continuationDigest)) throw new Error('math_continuation_identity_missing');
  if (access.continuation) {
    const snapshot = readContinuationSnapshot(access.continuation.file, state.continuationDigest!, {
      taskDigest: state.taskDigest, problemReceiptDigest: problem.receiptDigest });
    mandatory.push(continuationContextSection(snapshot, command, problem.projectRelative));
  }
  mandatory.push({ id: 'saved-work', kind: 'sources', text: 'Read the current owned source files and worktree-root RESEARCH.md. ' +
    `The current owned declaration index is ${path.join(access.worktree, DECLARATION_INDEX_FILE)}. ` +
    'Current files and complete references remain available even when their full text is not included in this message. Continue the original research from saved work.' });
  const compile = (options: ResearchDispatchOptions = {}) => compileContextSections({ instructions,
    mandatory: [options.continuation ? skillResearchContinuationSection(problem, state) : originalProblem,
      ...mandatory, ...(options.checkpointInstruction ? [{ id: 'checkpoint', kind: 'checkpoint' as const,
      text: options.checkpointInstruction }] : [])], maxContextBytes: access.maxContextBytes,
    maxOptionalContextBytes: access.maxOptionalContextBytes, inlineManifest: false });
  const continued = compile({ continuation: true });
  return { instructions, ...compile(), continuationMessage: continued.message, continuationManifest: continued.manifest,
    compileDispatch: compile,
    scope: 'original-problem-and-allowed-library', sources: { problemReceiptDigest: problem.receiptDigest } };
}
