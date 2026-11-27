import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueResearchObservation } from '../src/solver/researchObservation';
import { researchPublicationNotes } from '../src/solver/researchPublication';
import { parseMathResponse } from '../src/solver/deliveries';
import { assignmentDeliveryFile, parseCooperationPlan } from '../src/solver/tasks';
import { committedSource } from '../src/solver/problem';
import { readSolverRunState, writeSolverRunState } from '../src/solver/archive';
import { buildResearchContext } from '../src/solver/modules/context';
import { cooperativeResearch } from './helpers/cooperation';
import { leadWorker, localExample, peerWorker, solverState } from './helpers/solver';

const host = vi.hoisted(() => ({ createSession: vi.fn() }));
vi.mock('../src/runtime/codexSession', () => ({ createCodexMathSession: host.createSession }));
const instances: { stop: () => Promise<void>; directory: string }[] = [];
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(root, 'bin/math.ts');
afterEach(async () => {
  for (const item of instances.splice(0)) { await item.stop(); fs.rmSync(item.directory, { recursive: true, force: true }); }
  expect(host.createSession).not.toHaveBeenCalled();
});

async function fixture() {
  const example = localExample('research-observation-'), lead = leadWorker(example.problem, example.workspace), peer = peerWorker(example, 'peer');
  const plan = parseCooperationPlan(example.problem, { tasks: [
    ...example.problem.targets.map((target, index) => ({ ...target, id: `goal_${index}`, kind: 'goal', objective: 'Prove the original target.', status: 'paused' })),
    { id: 'investigate', kind: 'research', objective: 'Check a concrete construction.', ownerId: peer.id },
  ] });
  const state = solverState(example.problem, example.workspace, { runId: 'observation-fixture', phase: 'running',
    cooperation: { canonicalCommit: example.problem.baseCommit, tasks: plan.tasks.map(task => ({ task, status: 'pending', attempts: 0 })),
      groups: plan.groups.map(group => ({ group, turns: 0 })) } });
  const controller = new AbortController();
  const cooperative = cooperativeResearch({ state, workers: [lead, peer], retrievalRoot: example.directory, signal: controller.signal });
  instances.push({ directory: example.directory, stop: async () => { controller.abort(); await cooperative.stop(); } });
  const action = await cooperative.next(peer, { maxTurns: Infinity, remainingMs: Infinity });
  if (action?.kind !== 'task') throw new Error('missing observation assignment');
  expect(action.task.id).toBe('investigate');
  expect(cooperative.started(peer, action)).toBe(true);
  cooperative.activate(peer, action, async () => {}, async () => {});
  await cooperative.pulse(peer.id);
  return { ...example, state, peer, cooperative, action, log: path.join(peer.worktree, assignmentDeliveryFile(action.assignment)) };
}

describe('immediate advisory observation publication', () => {
  it('executes the complete help and generated-context file example through the real CLI', async () => {
    const f = await fixture();
    const helpResult = spawnSync('bun', [cli, 'research-observe', '--help'],
      { cwd: f.peer.worktree, encoding: 'utf8', timeout: 10_000 });
    expect(helpResult.status, helpResult.stderr).toBe(0);
    const help = JSON.parse(helpResult.stdout);
    expect(help.usage).toContain('--finding FILE');
    const context = buildResearchContext(f.problem, f.state, { root, worktree: f.peer.worktree,
      environment: {}, taskText: 'Investigate the synthetic construction.', retrievalRoot: f.directory, assignment: f.action });
    expect(context.instructions).toContain('Use research-observe from .scratch/theoremos-help.md');
    expect(context.toolHelp?.text).toContain('research-observe --worktree');


    const commands = path.join(f.directory, 'commands');
    fs.mkdirSync(commands);
    fs.writeFileSync(path.join(commands, 'theorem-os'),
      "#!/bin/sh\nexec bun '" + cli.replace(/'/gu, "'\\''") + "' \"$@\"\n", { mode: 0o700 });
    const probe = path.join(f.peer.worktree, '.scratch', 'probe.lean');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    const code = 'lemma cli_probe : True := by trivial';
    fs.writeFileSync(probe, code);
    const published = spawnSync('sh', ['-c', help.example + ' --probe .scratch/probe.lean --snapshot-sources'],
      { cwd: f.peer.worktree, env: { ...process.env, PATH: commands + path.delimiter + process.env.PATH },
        encoding: 'utf8', timeout: 10_000 });
    expect(published.status, published.stderr).toBe(0);
    const result = JSON.parse(published.stdout);
    expect(result).toMatchObject({ status: 'queued', authority: 'advisory-unverified', retainedProbes: 1, snapshotSources: true });
    expect(result.receipt).toContain('queued is not host acceptance');
    const event = JSON.parse(fs.readFileSync(f.log, 'utf8').trim());
    expect(event.finding).toMatchObject({ conclusion: 'inconclusive', remainingObligations: ['Establish the missing bound.'] });
    expect(event.probes).toEqual([{ source: '.scratch/probe.lean', code }]);
    expect(Object.keys(event.sources)).toEqual(f.problem.ownedFiles);
    fs.rmSync(probe);
    await f.cooperative.pulse(f.peer.id);
    expect(f.state.cooperation!.deliveries!.filter(record => record.submissionId === result.submissionId))
      .toEqual([expect.objectContaining({ kind: 'research', status: 'conditional', artifacts: expect.objectContaining({ scope: 'advisory-unverified' }) })]);
    expect(f.state.cooperation!.tasks.some(node => node.proof || node.integratedCheck)).toBe(false);
  });

  it('returns actionable CLI diagnostics without appending for inline JSON, bad paths or invalid files', async () => {
    const f = await fixture(), before = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '';
    fs.writeFileSync(path.join(f.peer.worktree, 'invalid.json'), '```json\n{}\n```');
    fs.writeFileSync(path.join(f.peer.worktree, 'wrong-field.json'), JSON.stringify({ summary: 'A missing bound.', remainingObligations: 'bound' }));
    const cases = [
      ['{"summary":"Inline JSON is not a file."}', 'math_observation_finding_file_required', '--finding', 'Save the finding'],
      ['absent.json', 'math_observation_finding_file_unreadable', '--finding', 'existing regular file'],
      ['invalid.json', 'math_observation_finding_json_invalid', '--finding', 'without Markdown fences'],
      ['wrong-field.json', 'math_delivery_invalid', 'remainingObligations', 'array'],
    ];
    for (const [file, code, field, message] of cases) {
      const result = spawnSync('bun', [cli, 'research-observe', '--worktree', f.peer.worktree, '--finding', file!],
        { cwd: f.peer.worktree, encoding: 'utf8', timeout: 10_000 });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toMatchObject({ status: 'rejected', code, recovery: 'correct-and-resubmit',
        issues: [expect.objectContaining({ path: field, message: expect.stringContaining(message!) })] });
      expect(fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '').toBe(before);
    }
    fs.writeFileSync(path.join(f.peer.worktree, 'wrong-field.json'), JSON.stringify({ summary: 'A missing bound.', remainingObligations: ['bound'] }));
    const corrected = spawnSync('bun', [cli, 'research-observe', '--worktree', f.peer.worktree, '--finding', 'wrong-field.json'],
      { cwd: f.peer.worktree, encoding: 'utf8', timeout: 10_000 });
    expect(corrected.status, corrected.stderr).toBe(0);
    expect(JSON.parse(corrected.stdout).status).toBe('queued');
    expect(fs.readFileSync(f.log, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('retains a deleted scratch probe through actual host intake and checkpoint reload without accepting a proof', async () => {
    const f = await fixture(), probe = path.join(f.peer.worktree, '.scratch', 'probe.lean');
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    const code = 'namespace ObservationProbe\nlemma identity (n : Nat) : n = n := by rfl\nend ObservationProbe';
    fs.writeFileSync(probe, code);
    const result = queueResearchObservation({ worktree: f.peer.worktree, finding: {
      summary: 'The identity check is retained; the original construction remains open.',
      leanChecks: [{ status: 'passed', path: 'RESEARCH.md', declarations: ['ObservationProbe.identity'] }],
    }, probes: [probe] });
    expect(result).toMatchObject({ status: 'queued', authority: 'advisory-unverified', retainedProbes: 1 });
    fs.rmSync(probe);
    await f.cooperative.pulse(f.peer.id);
    const records = f.state.cooperation!.deliveries!.filter(record => record.submissionId === result.submissionId);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ kind: 'research', status: 'advisory', taskId: 'investigate',
      artifacts: { scope: 'advisory-unverified', artifacts: [{ kind: 'notes-lean', declarations: [{ name: 'ObservationProbe.identity' }] }] } });
    expect(committedSource(f.peer.worktree, records[0]!.commit!, 'RESEARCH.md')).toContain(code);
    expect(f.state.cooperation!.tasks.some(node => node.proof || node.integratedCheck)).toBe(false);
    const checkpoint = path.join(f.directory, 'state.json');
    writeSolverRunState(checkpoint, f.state);
    expect(readSolverRunState(checkpoint).cooperation!.deliveries!.find(record => record.id === records[0]!.id)?.artifacts)
      .toEqual(records[0]!.artifacts);
  });

  it('reports an invalid field before appending and permits a corrected submission', async () => {
    const f = await fixture(), before = fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '';
    expect(() => queueResearchObservation({ worktree: f.peer.worktree,
      finding: { summary: 'One missing premise.', remainingObligations: 'the bound' } }))
      .toThrow('math_delivery_invalid');
    expect(fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8') : '').toBe(before);
    queueResearchObservation({ worktree: f.peer.worktree,
      finding: { summary: 'One missing premise.', remainingObligations: ['the bound'] } });
    await f.cooperative.pulse(f.peer.id);
    expect(f.state.cooperation!.deliveries!.at(-1)?.remainingObligations).toEqual(['the bound']);
  });

  it('uses the existing host identity to deduplicate a repeated observation', async () => {
    const f = await fixture(), input = { worktree: f.peer.worktree, finding: { summary: 'A scoped negative search.' } };
    const first = queueResearchObservation(input), second = queueResearchObservation(input);
    expect(second.submissionId).toBe(first.submissionId);
    await f.cooperative.pulse(f.peer.id);
    expect(f.state.cooperation!.deliveries!.filter(record => record.submissionId === first.submissionId)).toHaveLength(1);
  });

  it('freezes explicit source bytes at publication before the writer changes them', async () => {
    const f = await fixture(), file = path.join(f.peer.worktree, f.problem.projectRelative, f.problem.ownedFiles.find(file => file.endsWith('.lean'))!);
    const saved = fs.readFileSync(file, 'utf8');
    queueResearchObservation({ worktree: f.peer.worktree, finding: { summary: 'This observation concerns the current saved sources.' }, snapshotSources: true });
    const event = JSON.parse(fs.readFileSync(f.log, 'utf8').trim());
    fs.writeFileSync(file, saved + '\n-- later edit\n');
    expect(Object.values(event.sources)).toContain(saved);
    expect(Object.values(event.sources)).not.toContain(saved + '\n-- later edit\n');
  });

  it('keeps a single parseable result with probe artifacts and rejects ambiguous fences', () => {
    const finding = { taskId: 'a', taskDigest: 'd', conclusion: 'inconclusive' as const, summary: 'Partial check.' };
    const notes = researchPublicationNotes(finding, [{ source: 'probe.lean', code: 'lemma p : True := by trivial' }]);
    expect(parseMathResponse(notes, 'math-result')).toEqual(finding);
    expect(() => researchPublicationNotes(finding, [{ source: 'probe.lean', code: '```math-result\n{}\n```' }]))
      .toThrow('math_research_delivery_invalid');
  });
});
