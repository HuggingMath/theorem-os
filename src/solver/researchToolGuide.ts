import path from 'node:path';
import type { AgentTeamTransport } from './agentTeamTool';
import { DECLARATION_INDEX_FILE } from './declarationIndex';
import type { ContextAccess } from './modules/context';
import type { SolverProblem } from './problem';
import { ResearchToolHelpBuilder } from './researchToolHelp';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export const researchToolCommand = (root: string, tools?: string) => `bun ${quote(tools ?? path.join(root, 'bin/math.ts'))}`;

export const checkpointCommand = (command: string, worktree: string, file: string, requestId: string) =>
  `${command} checkpoint --worktree ${quote(worktree)} --log ${quote(file)} --request-id ${quote(requestId)}`;

export const longCommandGuidance =
  'For a long calculation, record the inputs, print progress and save completed batches in .scratch/tmp. Use unbuffered output for Python (python3 -u). ' +
  'With native exec_command, keep the session ID returned after a short yield_time_ms. Poll with write_stdin and empty chars. ' +
  'Send Ctrl-C (U+0003) to that session before abandoning or replacing the calculation, then check that it has exited. ' +
  'Keep progress on disk and note how to resume in RESEARCH.md when needed. If the shell cannot poll, run one resumable batch at a time.';

/** Shared optional tool reference; callers retain their own mandatory delivery contracts. */
export function buildResearchToolGuide(problem: Pick<SolverProblem, 'receiptDigest' | 'projectRelative' | 'targets' | 'ownedFiles' | 'frozenFiles'>,
  access: Pick<ContextAccess, 'root' | 'tools' | 'worktree' | 'retrievalRoot' | 'corpusFile' |
    'knowledgeFile' | 'knowledgeDigest' | 'libraryCatalog' | 'teamRole' | 'assignment'>, environmentDigest: string,
  teamTransport?: AgentTeamTransport) {
  const command = researchToolCommand(access.root, access.tools);
  const help = new ResearchToolHelpBuilder();
  if (access.assignment?.kind === 'lead') help.section('Lead plan submission',
    `Save one plan or revision in .scratch/plan.json. Omit progressReview on the initial plan.\n` +
    `Publish for immediate host intake: ${command} plan-apply --publish --file .scratch/plan.json\n` +
    `To save the plan in RESEARCH.md for intake on return: ${command} plan-apply --file .scratch/plan.json\n` +
    'Both validate the draft. Live publication binds the current dispatch automatically.', '');
  const editable = new Set(problem.ownedFiles.filter(file => file.endsWith('.lean') && !Object.hasOwn(problem.frozenFiles ?? {}, file)));
  const file = problem.targets.find(target => editable.has(target.proofPath))?.proofPath ?? editable.values().next().value;
  const leanCheckCommand = file && `${command} check-lean --worktree ${quote(access.worktree)} --file ${quote(file)} --timeout-seconds 0`;
  const report = teamTransport === 'native-agent-control' ? 'native send_message' :
    teamTransport === 'host-tools' ? 'theoremos_team ' + (access.teamRole?.role === 'worker' ? 'progress' : 'message') : undefined;
  const longCommandSummary = help.section('long-commands', longCommandGuidance + '\n\n' +
    'Start a foreground calculation and get control back while it runs.\n' +
    'exec_command ' + JSON.stringify({ cmd: 'python3 -u .scratch/tmp/experiment.py', workdir: access.worktree,
      login: false, yield_time_ms: 1000, max_output_tokens: 1000 }) + '\n' +
    'Replace the example session ID with the one returned by exec_command.\n' +
    'write_stdin ' + JSON.stringify({ session_id: 12345, chars: '', yield_time_ms: 5000, max_output_tokens: 1000 }) + '\n' +
    'To interrupt just this command, send Ctrl-C.\n' +
    'write_stdin ' + JSON.stringify({ session_id: 12345, chars: '\u0003', yield_time_ms: 1000, max_output_tokens: 1000 }) + '\n' +
    'Before a handoff, collect finished outputs and settle any commands you are leaving. After a session restart, continue from completed batches.',
    'Use a pollable session and saved progress for a long calculation.');
  help.section('lean', (file && leanCheckCommand ? `${leanCheckCommand}\n` +
    `Edit ${quote(path.join(problem.projectRelative, file))} from the worktree root; pass ${quote(file)} to --file. ` +
    (teamTransport ? 'To test a peer result, append --candidate followed by its actual message:, research: or delivery: reference to this single-file check. ' : '') : '') +
    'Repeat --file for all relevant saved source files. Paths are relative to the Lean project, without its prefix. ' +
    'For a concrete claim or library application, save a focused probe and check it before expanding the surrounding proof. ' +
    'Read classification, firstBlocking and diagnosticArtifacts; stdout is JSON and stderr is progress. Poll unfinished processes. ' +
    'An infrastructure-error identifies an environment fault; leanStarted:false confirms compilation did not start. Preserve proof work and report error.code, error.fingerprint and error.recovery to Lead/host. ' +
    'Retry after an environment repair or changed health result; repeating the same failed command does not repair its environment. ' +
    'Sandbox /proc cannot establish whether a host helper died. Use check-lean --health --worktree with this same worktree to check namespace visibility, lease and pinned tools. ' +
    'Preserve the compiler exit status: use check-lean directly; for a manual shell check, capture output to a file and save the exit status before displaying a preview. ' +
    'A pipeline ending in head or a successful cat/echo is not evidence that Lean passed. ' +
    'Digests use the diagnostic tool scheme; an unchanged successful result can be reused. A local diagnostic is advisory.\n' +
    `rg --line-number --ignore-case --fixed-strings --max-count 12 -- 'KEYWORD' ${quote(path.join(access.worktree, DECLARATION_INDEX_FILE))}\n` +
    'Use native exec_command for text lookup and source reads, and native apply_patch for edits. ' +
    'The JSONL declaration index records names, project-relative files, lines and indexed types. ' +
    'Read matching source with its surrounding scopes, imports and complete type; the index is a lexical aid. ' +
    'A ripgrep exit code of 1 means no match. Choose literal terms or an explicit pattern as appropriate; ' +
    'do not infer that a declaration is absent from one search miss. ' +
    (report ? `Share a useful probe result or blocker through ${report}, with its saved source path and exact diagnostic; private tool output is not a team report.` :
      'Save useful probe results and exact diagnostics with source references in RESEARCH.md for continuation.'), '');
  if (!teamTransport) help.section('cooperation', `${command} research-observe --worktree ${quote(access.worktree)} --finding '.scratch/finding.json' ` +
    '[--probe LEAN_FILE] [--snapshot-sources]\n' +
    'For cooperative task assignments only. The finding file contains the finding object, not the outer delivery event. ' +
    'This validates and appends to the current assignment log; it never supplies proof acceptance. Read the result for correction feedback.', '');
  if (access.corpusFile) help.section('lean-search', `${command} search-lean --workspace ${quote(access.retrievalRoot)} ` +
    `--corpus ${quote(access.corpusFile)} --query 'SHORT_LIBRARY_KEYWORDS' --goal 'EXACT_LEAN_GOAL_AND_CONTEXT'\n` +
    'Up to eight --query arguments share one scan. Hits are lexical hints; inspect source and test applicability.', '');
  if (access.knowledgeFile) {
    const catalog = `--catalog ${quote(access.knowledgeFile)} --sha256 ${quote(access.knowledgeDigest!)}`;
    help.section('knowledge', `${command} knowledge search ${catalog} --environment ${quote(environmentDigest)} ` +
      `--problem-receipt ${quote(problem.receiptDigest)} --query 'KEYWORDS' --goal 'EXACT_LEAN_CONTEXT'\n` +
      `${command} knowledge get ${catalog} --id 'THEOREM_ID' --metadata --max-bytes 16000\n` +
      'Follow field read handles and nextOffset until complete. Read complete types, premises and dependencies before reuse. ' +
      'Historical evidence requires a fresh current check. Installed-frozen declarations are imported by name, never copied or redeclared. ' +
      'Adapt only allowed archived declarations and their required dependencies into owned files. A search miss does not show a theorem is absent.', '');
  }
  if (access.libraryCatalog) help.section('library', `${command} library search --worktree ${quote(access.worktree)} --query 'KEYWORDS' --goal 'EXACT_LEAN_CONTEXT'\n` +
    `${command} library get --worktree ${quote(access.worktree)} --name 'QUALIFIED_NAME' --max-bytes 16000\n` +
    'Follow nextOffset until the source is complete. Import installed-frozen names; do not copy library sources. ' +
    `${command} library request --worktree ${quote(access.worktree)} --name 'QUALIFIED_NAME' --reason 'EXACT_USE_AND_PREMISES'\n` +
    'A request saves the current run for host-controlled continuation; it does not mutate frozen dependencies or accept a proof.', '');
  help.section('huggingmath', `${command} hub --help\n` +
    'Optional transfer of completed frozen results uses hub export, then an operator session profile with preview/apply/record. ' +
    'Keep the profile and import journal outside this research worktree. No upload is part of normal research; ' +
    'historical evidence cannot grant Hub verification, canonical status or publication.', '');
  help.section('other-tools', `${command} --help lists available commands. Read COMMAND --help before using an unfamiliar interface. ` +
    'Use native web search when actually exposed. Finite checks, proof-search and kernel-certificate do not call a model or accept the original problem. ' +
    'Their exact input formats are available from their existing --help commands.', '');
  return { command, help, leanCheckCommand, longCommandSummary };
}
