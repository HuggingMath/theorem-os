import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { mathGitText } from '../src/math/mathGit';
import { canonicalMathJson, mathDigest } from '../src/math/mathRuntimeIo';
import { inspectAgentTeamResearchArtifact, saveAgentTeamResearchArtifact,
  type AgentTeamResearchArtifactReference, type AgentTeamResearchState } from '../src/solver/agentTeamResearch';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
const git = (root: string, args: string[]) => mathGitText(root, args, { maxBuffer: 1024 * 1024 });
const commit = (root: string, message: string) => {
  git(root, ['add', '--all']);
  git(root, ['-c', 'user.name=Research Fixture', '-c', 'user.email=research@localhost', 'commit',
    '--quiet', '--no-gpg-sign', '-m', message]);
  return git(root, ['rev-parse', 'HEAD']);
};
function fixture(notes?: string | Buffer) {
  const temporaryRoot = process.env.TMPDIR || '/data/lzh/default-storage/tmp';
  fs.mkdirSync(temporaryRoot, { recursive: true });
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'agent-team-research-')));
  directories.push(root);
  const worktree = path.join(root, 'source'), directory = path.join(root, '.host/research');
  fs.mkdirSync(worktree); git(worktree, ['init', '--quiet']);
  fs.writeFileSync(path.join(worktree, 'README.md'), 'Disposable research fixture.\n');
  if (notes !== undefined) fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), notes);
  const initialCommit = commit(worktree, 'Freeze initial notes');
  const state: AgentTeamResearchState = { runId: 'research-fixture', environmentDigest: mathDigest('environment'),
    problem: { receiptDigest: mathDigest('receipt') } };
  const input = { directory, worktree, state, commit: initialCommit, agentId: 'domain_expert', taskId: 'task-1',
    summary: 'A tentative argument and its remaining gaps.', status: 'completed' as const };
  return { root, worktree, directory, state, input };
}
const inspect = (reference: AgentTeamResearchArtifactReference, state: AgentTeamResearchState, offset?: number, limit?: number) =>
  inspectAgentTeamResearchArtifact({ reference, state, offset, limit });
const rewrite = (file: string, value: unknown) => {
  fs.chmodSync(file, 0o600); fs.writeFileSync(file, canonicalMathJson(value));
};

describe('Fixed advisory agent-team research artifacts', () => {
  it('preserves the exact fixed-commit notes through later edits and commits', () => {
    const notes = '\uFEFF# 数学研究\r\nA tentative lemma 🙂\n\n';
    const { input, state, worktree } = fixture(notes);
    fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'Later committed notes.\n');
    commit(worktree, 'Replace the current notes');
    fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'Mutable notes are never the delivery.\n');
    const reference = saveAgentTeamResearchArtifact(input);
    expect(saveAgentTeamResearchArtifact(input)).toEqual(reference);
    const result = inspect(reference, state);
    expect(result).toEqual({ id: reference.id, agentId: input.agentId, taskId: input.taskId, commit: input.commit,
      summary: input.summary, status: 'completed', advisory: true, originalProblemAcceptance: 'not-assessed',
      notes: { file: 'RESEARCH.md', sha256: mathDigest(Buffer.from(notes)), bytes: Buffer.byteLength(notes), text: notes,
        offset: 0, truncated: false, totalCharacters: Array.from(notes).length } });
    expect(fs.statSync(reference.path).mode & 0o777).toBe(0o400);
    const record = JSON.parse(fs.readFileSync(reference.path, 'utf8'));
    const { id, ...payload } = record;
    expect(id).toBe(mathDigest(canonicalMathJson(payload)));
    fs.rmSync(worktree, { recursive: true });
    expect(inspect(reference, state)).toEqual(result);
  });

  it('retains complete long UTF-8 notes and reconstructs them with capped pages', () => {
    const notes = '研究🙂 line\n'.repeat(6000) + 'Complete ending.\n';
    const { input, state } = fixture(notes), reference = saveAgentTeamResearchArtifact(input);
    const stored = JSON.parse(fs.readFileSync(reference.path, 'utf8'));
    expect(stored.notes.text).toBe(notes);
    let offset = 0, reconstructed = '', pages = 0;
    for (;;) {
      const page = inspect(reference, state, offset, pages === 0 ? 1_000_000 : undefined).notes!;
      expect(page.sha256).toBe(mathDigest(notes));
      expect(page.bytes).toBe(Buffer.byteLength(notes));
      expect(page.totalCharacters).toBe(Array.from(notes).length);
      expect(Array.from(page.text).length).toBeLessThanOrEqual(16000);
      expect(page.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
      reconstructed += page.text; pages++;
      if (page.nextOffset === undefined) { expect(page.truncated).toBe(false); break; }
      expect(page.truncated).toBe(true); expect(page.nextOffset).toBe(offset + 16000); offset = page.nextOffset;
    }
    expect(pages).toBeGreaterThan(2); expect(reconstructed).toBe(notes);
    expect(inspect(reference, state, 1, 3).notes?.text).toBe(Array.from(notes).slice(1, 4).join(''));
  });

  it('keeps the summary when committed notes are absent, including mutable notes', () => {
    const { input, state, worktree } = fixture();
    fs.writeFileSync(path.join(worktree, 'RESEARCH.md'), 'An uncommitted result.\n');
    const reference = saveAgentTeamResearchArtifact({ ...input, status: 'interrupted' });
    expect(inspect(reference, state)).toMatchObject({ summary: input.summary, status: 'interrupted', notes: null,
      advisory: true, originalProblemAcceptance: 'not-assessed' });
  });

  it('distinguishes an empty committed note from a missing note', () => {
    const { input, state } = fixture(''), reference = saveAgentTeamResearchArtifact(input);
    expect(inspect(reference, state).notes).toEqual({ file: 'RESEARCH.md', sha256: mathDigest(''), bytes: 0,
      text: '', offset: 0, truncated: false, totalCharacters: 0 });
  });

  it('always snapshots worktree-root notes rather than project-local notes', () => {
    const { input, state, worktree } = fixture('Root research.\n');
    const project = path.join(worktree, 'project'); fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'RESEARCH.md'), 'Project notes are unrelated.\n');
    const fixedCommit = commit(worktree, 'Add project-local notes');
    const reference = saveAgentTeamResearchArtifact({ ...input, worktree: project, commit: fixedCommit });
    expect(inspect(reference, state).notes?.text).toBe('Root research.\n');
  });

  it.each(['runId', 'environmentDigest', 'receiptDigest'] as const)('rejects a changed %s binding', key => {
    const { input, state } = fixture('Frozen notes.\n'), reference = saveAgentTeamResearchArtifact(input);
    const changed = { ...state, problem: { ...state.problem } };
    if (key === 'receiptDigest') changed.problem.receiptDigest = mathDigest('different-receipt');
    else changed[key] = key === 'runId' ? 'different-run' : mathDigest('different-environment');
    expect(() => inspect(reference, changed)).toThrow('math_agent_team_research_identity_changed');
  });

  it('rejects modified content and the notes hash even after re-addressing the record', () => {
    const { input, state } = fixture('Frozen notes.\n'), reference = saveAgentTeamResearchArtifact(input);
    const record = JSON.parse(fs.readFileSync(reference.path, 'utf8'));
    record.summary = 'A changed summary.'; rewrite(reference.path, record);
    expect(() => inspect(reference, state)).toThrow('math_agent_team_research_artifact_changed');
    record.notes.text = 'Changed frozen notes.';
    const { id: _id, ...payload } = record;
    record.id = mathDigest(canonicalMathJson(payload));
    const forged = { ...reference, id: record.id, path: path.join(path.dirname(reference.path), `${record.id}.json`) };
    fs.writeFileSync(forged.path, canonicalMathJson(record));
    expect(() => inspect(forged, state)).toThrow('math_agent_team_research_artifact_changed');
    record.notes.sha256 = mathDigest(record.notes.text); record.notes.bytes++;
    const { id: _newId, ...changedPayload } = record;
    record.id = mathDigest(canonicalMathJson(changedPayload));
    const badSize = { ...reference, id: record.id, path: path.join(path.dirname(reference.path), `${record.id}.json`) };
    fs.writeFileSync(badSize.path, canonicalMathJson(record));
    expect(() => inspect(badSize, state)).toThrow('math_agent_team_research_artifact_changed');
  });

  it.each(['id', 'agentId', 'taskId', 'commit'] as const)('rejects a changed reference %s', key => {
    const { input, state } = fixture('Frozen notes.\n'), reference = saveAgentTeamResearchArtifact(input);
    const changed = { ...reference, [key]: key === 'id' ? mathDigest('another-id') : key === 'commit' ? 'a'.repeat(40) : 'other' };
    expect(() => inspect(changed, state)).toThrow('math_agent_team_research_reference_changed');
  });

  it('rejects an abbreviated hash, missing commit, and Git blob passed as a commit', () => {
    const { input, worktree } = fixture('Frozen notes.\n');
    expect(() => saveAgentTeamResearchArtifact({ ...input, commit: input.commit.slice(0, 12) })).toThrow();
    expect(() => saveAgentTeamResearchArtifact({ ...input, commit: '0'.repeat(40) }))
      .toThrow('math_agent_team_research_source_unavailable');
    const blob = git(worktree, ['rev-parse', `${input.commit}:RESEARCH.md`]);
    expect(() => saveAgentTeamResearchArtifact({ ...input, commit: blob })).toThrow('math_agent_team_research_commit_invalid');
  });

  it('rejects invalid UTF-8 and a committed symlink in place of notes', () => {
    const { input, worktree } = fixture(Buffer.from([0xff]));
    expect(() => saveAgentTeamResearchArtifact(input)).toThrow('math_agent_team_research_notes_invalid_utf8');
    fs.rmSync(path.join(worktree, 'RESEARCH.md')); fs.symlinkSync('README.md', path.join(worktree, 'RESEARCH.md'));
    const symlinkCommit = commit(worktree, 'Notes must be a regular blob');
    expect(() => saveAgentTeamResearchArtifact({ ...input, commit: symlinkCommit }))
      .toThrow('math_agent_team_research_notes_not_regular_file');
  });

  it('rejects invalid page bounds and evidence inside the mutable source worktree', () => {
    const { input, state, worktree } = fixture('Frozen notes.\n'), reference = saveAgentTeamResearchArtifact(input);
    expect(() => inspect(reference, state, -1)).toThrow();
    expect(() => inspect(reference, state, 0.5)).toThrow();
    expect(() => inspect(reference, state, 0, 0)).toThrow();
    expect(() => inspect(reference, state, 0, Infinity)).toThrow();
    expect(inspect(reference, state, 1000).notes).toMatchObject({ text: '', offset: 1000, truncated: false });
    expect(() => saveAgentTeamResearchArtifact({ ...input, directory: path.join(worktree, '.research-artifacts') }))
      .toThrow('math_agent_team_research_evidence_inside_source_workspace');
  });
});
