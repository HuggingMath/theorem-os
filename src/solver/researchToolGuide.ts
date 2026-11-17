import path from 'node:path';
import { DECLARATION_INDEX_FILE } from './declarationIndex';
import type { ContextAccess } from './modules/context';
import type { SolverProblem } from './problem';
import { ResearchToolHelpBuilder } from './researchToolHelp';

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Shared optional tool reference; callers retain their own mandatory delivery contracts. */
export function buildResearchToolGuide(problem: Pick<SolverProblem, 'receiptDigest'>,
  access: Pick<ContextAccess, 'root' | 'tools' | 'worktree' | 'retrievalRoot' | 'corpusFile' |
    'knowledgeFile' | 'knowledgeDigest' | 'libraryCatalog'>, environmentDigest: string, teamMode = false) {
  const command = `bun ${quote(access.tools ?? path.join(access.root, 'bin/math.ts'))}`;
  const help = new ResearchToolHelpBuilder();
  help.section('lean', `${command} check-lean --worktree ${quote(access.worktree)} --file 'OWNED_FILE.lean' --timeout-seconds 0\n` +
    'Repeat --file for all relevant saved source files. Paths are relative to the Lean project, without its prefix. ' +
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
    'do not infer that a declaration is absent from one search miss.', '');
  if (!teamMode) help.section('cooperation', `${command} research-observe --worktree ${quote(access.worktree)} --finding '.scratch/finding.json' ` +
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
  return { command, help };
}
