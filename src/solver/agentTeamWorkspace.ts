import fs from 'node:fs';
import path from 'node:path';
import { assertMathCanonicalPath, isMathPathWithin } from '../math/paths';
import { mathDigest } from '../math/mathRuntimeIo';
import { git } from './problem';

const commitPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

function copySourceExcludes(source: string, metadata: string): void {
  const excludes = git(source, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
  if (fs.existsSync(excludes)) fs.copyFileSync(excludes, path.join(metadata, 'info', 'exclude'));
}

/** Transfer only an explicitly authorized commit ancestry, without tags, remote refs, or alternates. */
export function importAgentTeamCommit(source: string, target: string, commit: string): void {
  assertMathCanonicalPath(source); assertMathCanonicalPath(target);
  if (!commitPattern.test(commit)) throw new Error('math_agent_team_source_commit_invalid');
  git(target, ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.file.allow=always', 'fetch', '--quiet',
    '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', source, commit]);
  if (git(target, ['rev-parse', `${commit}^{commit}`]) !== commit)
    throw new Error('math_agent_team_source_commit_changed');
}

/** Host-owned storage survives member cleanup and is hidden from every research process. */
export function archiveAgentTeamCommits(directory: string, source: string, commits: readonly string[]): void {
  assertMathCanonicalPath(directory); assertMathCanonicalPath(source);
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    git(directory, ['init', '--quiet', '--bare', `--object-format=${git(source, ['rev-parse', '--show-object-format'])}`]);
  }
  for (const commit of new Set(commits)) {
    importAgentTeamCommit(source, directory, commit);
    git(directory, ['update-ref', `refs/math/agent-team/evidence/${commit}`, commit]);
  }
}

/** A member keeps its files across stopped-writer migration; only its shared Git metadata is replaced. */
export function prepareAgentTeamWorkspace(input: {
  sourceWorktree: string; worktree: string; seedCommit: string; migrationDirectory: string;
}): void {
  const { sourceWorktree, worktree, seedCommit } = input;
  for (const directory of [sourceWorktree, worktree, input.migrationDirectory]) assertMathCanonicalPath(directory);
  if (isMathPathWithin(worktree, input.migrationDirectory) || sourceWorktree === worktree || !commitPattern.test(seedCommit))
    throw new Error('math_agent_team_source_workspace_invalid');
  fs.mkdirSync(worktree, { recursive: true, mode: 0o700 });
  const metadata = path.join(worktree, '.git');
  const stage = path.join(input.migrationDirectory, mathDigest(worktree));
  const replacement = path.join(stage, 'repository', '.git'), previous = path.join(stage, 'linked.git');
  // A host crash between the two renames must leave the same draft recoverable.
  if (!fs.existsSync(metadata) && fs.existsSync(previous) && fs.existsSync(replacement)) fs.renameSync(replacement, metadata);
  if (fs.existsSync(metadata) && fs.statSync(metadata).isDirectory()) {
    if (git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']) !== metadata ||
        fs.existsSync(path.join(metadata, 'objects', 'info', 'alternates')))
      throw new Error('math_agent_team_source_repository_not_independent');
    git(worktree, ['merge-base', '--is-ancestor', seedCommit, 'HEAD']);
    return;
  }
  if (!fs.existsSync(metadata)) {
    git(worktree, ['init', '--quiet', `--object-format=${git(sourceWorktree, ['rev-parse', '--show-object-format'])}`]);
    importAgentTeamCommit(sourceWorktree, worktree, seedCommit);
    git(worktree, ['checkout', '--quiet', '--detach', seedCommit]);
    copySourceExcludes(sourceWorktree, metadata);
    return;
  }
  const head = git(worktree, ['rev-parse', 'HEAD']);
  git(worktree, ['merge-base', '--is-ancestor', seedCommit, head]);
  const oldDirectory = git(worktree, ['rev-parse', '--path-format=absolute', '--git-dir']);
  const oldCommon = git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const registration = path.join(oldDirectory, 'gitdir');
  if (!isMathPathWithin(path.join(oldCommon, 'worktrees'), oldDirectory) ||
      fs.readFileSync(registration, 'utf8').trim() !== metadata)
    throw new Error('math_agent_team_source_worktree_registration_invalid');
  fs.rmSync(stage, { recursive: true, force: true });
  const repository = path.dirname(replacement); fs.mkdirSync(repository, { recursive: true, mode: 0o700 });
  git(repository, ['init', '--quiet', `--object-format=${git(worktree, ['rev-parse', '--show-object-format'])}`]);
  importAgentTeamCommit(worktree, repository, head);
  git(repository, ['update-ref', '--no-deref', 'HEAD', head]);
  git(repository, ['read-tree', head]);
  copySourceExcludes(worktree, replacement);
  fs.renameSync(metadata, previous);
  try { fs.renameSync(replacement, metadata); }
  catch (error) { fs.renameSync(previous, metadata); throw error; }
  // Remove just this validated stopped worktree registration, without touching its files or other members.
  fs.rmSync(oldDirectory, { recursive: true });
  fs.rmSync(stage, { recursive: true, force: true });
}
