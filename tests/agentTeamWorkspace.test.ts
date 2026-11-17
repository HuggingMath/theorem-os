import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { temporaryDirectory } from './helpers/files';
import { git } from '../src/solver/problem';
import { archiveAgentTeamCommits, importAgentTeamCommit, prepareAgentTeamWorkspace } from '../src/solver/agentTeamWorkspace';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = temporaryDirectory('team-source-isolation-'); roots.push(root);
  const source = path.join(root, 'lead'); fs.mkdirSync(source); git(source, ['init', '--quiet']);
  const commit = (directory: string, text: string) => {
    fs.writeFileSync(path.join(directory, 'proof.lean'), text); git(directory, ['add', 'proof.lean']);
    git(directory, ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '--no-gpg-sign', '--quiet', '-m', text]);
    return git(directory, ['rev-parse', 'HEAD']);
  };
  const seed = commit(source, 'seed');
  const input = (name: string) => ({ sourceWorktree: source, worktree: path.join(root, 'members', name),
    seedCommit: seed, migrationDirectory: path.join(root, 'archive', 'migrations') });
  return { root, source, seed, commit, input };
}

describe('independent team source repositories', () => {
  it('shares only authorized seed ancestry and explicitly transfers a checked archived commit', () => {
    const f = fixture(), siblingOnly = f.commit(f.source, 'unpublished source');
    fs.appendFileSync(path.join(f.source, '.git/info/exclude'), '\n**/.lake/\n');
    const first = f.input('first'), second = f.input('second');
    prepareAgentTeamWorkspace(first); prepareAgentTeamWorkspace(second);
    for (const input of [first, second]) {
      expect(git(input.worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
        .toBe(path.join(input.worktree, '.git'));
      expect(() => git(input.worktree, ['show', `${siblingOnly}:proof.lean`])).toThrow();
      expect(fs.existsSync(path.join(input.worktree, '.git/objects/info/alternates'))).toBe(false);
      expect(git(input.worktree, ['remote'])).toBe('');
      fs.mkdirSync(path.join(input.worktree, 'project/.lake'), { recursive: true });
      fs.writeFileSync(path.join(input.worktree, 'project/.lake/source-constraints.json'), '{}');
      expect(git(input.worktree, ['status', '--porcelain'])).toBe('');
    }
    const delivery = f.commit(first.worktree, 'checked peer result');
    expect(() => git(second.worktree, ['show', `${delivery}:proof.lean`])).toThrow();
    expect(() => git(f.source, ['show', `${delivery}:proof.lean`])).toThrow();
    const archive = path.join(f.root, 'archive', 'sources.git');
    archiveAgentTeamCommits(archive, first.worktree, [delivery]);
    fs.rmSync(first.worktree, { recursive: true });
    importAgentTeamCommit(archive, second.worktree, delivery);
    expect(git(second.worktree, ['show', `${delivery}:proof.lean`])).toBe('checked peer result');
    expect(git(second.worktree, ['rev-parse', 'HEAD'])).toBe(f.seed);
    expect(() => git(second.worktree, ['show', `${siblingOnly}:proof.lean`])).toThrow();
  });

  it('migrates a stopped linked worktree while preserving uncommitted drafts and task files', () => {
    const f = fixture(), input = f.input('legacy'); fs.mkdirSync(path.dirname(input.worktree));
    git(f.source, ['worktree', 'add', '--quiet', '--detach', input.worktree, f.seed]);
    const own = f.commit(input.worktree, 'own checkpoint');
    const peer = f.commit(f.source, 'unrelated peer objects');
    fs.writeFileSync(path.join(input.worktree, 'proof.lean'), 'uncommitted proof draft');
    fs.mkdirSync(path.join(input.worktree, '.agents')); fs.mkdirSync(path.join(input.worktree, '.scratch'));
    fs.writeFileSync(path.join(input.worktree, '.agents/SKILL.md'), 'pinned skill');
    fs.writeFileSync(path.join(input.worktree, '.scratch/research'), 'unfinished research');
    fs.writeFileSync(path.join(input.worktree, 'RESEARCH.md'), 'ongoing assignment');
    prepareAgentTeamWorkspace(input); prepareAgentTeamWorkspace(input);
    expect(git(input.worktree, ['rev-parse', 'HEAD'])).toBe(own);
    expect(fs.readFileSync(path.join(input.worktree, 'proof.lean'), 'utf8')).toBe('uncommitted proof draft');
    expect(fs.readFileSync(path.join(input.worktree, '.agents/SKILL.md'), 'utf8')).toBe('pinned skill');
    expect(fs.readFileSync(path.join(input.worktree, '.scratch/research'), 'utf8')).toBe('unfinished research');
    expect(fs.readFileSync(path.join(input.worktree, 'RESEARCH.md'), 'utf8')).toBe('ongoing assignment');
    expect(() => git(input.worktree, ['show', `${peer}:proof.lean`])).toThrow();
    expect(git(f.source, ['worktree', 'list', '--porcelain'])).not.toContain(input.worktree);
    expect(git(input.worktree, ['diff', '--name-only'])).toBe('proof.lean');
  });
});
