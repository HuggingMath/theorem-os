// Deterministic cooperative work products for the real host. No checkpoint writes or model calls.
import fs from 'node:fs';
import path from 'node:path';

export const cooperativeEditId = 'web-cooperative-edit';
export const cooperativeGuidanceMarker = 'WEB_COOPERATIVE_PROVE_FIRST';
export const cooperativeReviewMarker = 'WEB_COOPERATIVE_RELEASE_REVIEW';

function workContract(message) {
  for (const line of message.split('\n')) {
    if (!line.startsWith('{"schema":"theorem-os.work-contract.v1"')) continue;
    try { return JSON.parse(line); } catch { /* Other context lines are not assignments. */ }
  }
}

export function createCooperativeFixture({ workspace, source, message, instructions, complete }) {
  const contract = workContract(message);
  if (!contract) return;
  const coordination = () => JSON.parse(fs.readFileSync(path.join(workspace, 'COOPERATION.json'), 'utf8'));
  const edited = () => coordination().edits.some(edit => edit.id === cooperativeEditId && edit.status === 'applied');
  const notes = value => fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), JSON.stringify(value) + '\n');
  let pending;
  let receivedGuidance;
  const finishProof = () => {
    const taskId = contract.input.taskId;
    const original = fs.readFileSync(source, 'utf8');
    const before = taskId === 'goal_1' ? 'n + 0 = n := by sorry' : '0 + n = n := by sorry';
    const after = taskId === 'goal_1' ? 'n + 0 = n := by rfl' : '0 + n = n := by exact Nat.zero_add n';
    if (!['goal_1', 'goal_2'].includes(taskId) || !original.includes(before)) throw new Error('web_fixture_wrong_cooperative_target');
    fs.writeFileSync(source, original.replace(before, after));
    notes({ summary: `Offline exact proof for ${taskId}.`, fixture: { task: contract.input,
      guidanceReceived: receivedGuidance ?? null, editedPlanObserved: edited(), independentModelCall: false } });
    const file = instructions.match(/append JSON to (DELIVERIES-[a-f0-9]{64}\.jsonl)/u)?.[1];
    if (!file) throw new Error('web_fixture_missing_proof_delivery_protocol');
    fs.appendFileSync(path.join(workspace, file), JSON.stringify({ kind: 'ready', summary: `Saved ${taskId} for independent host checking.` }) + '\n');
    complete();
  };
  const finishReview = () => {
    notes({ commit: contract.input.seedCommit, verdict: 'accepted',
      summary: 'Offline independent reviewer inspected the fixed two-target candidate; only host Lean/S3 checks can accept it.' });
    complete();
  };
  if (contract.stage === 'route-planning') {
    const revised = edited();
    const tasks = [
      { id: 'goal_1', kind: 'goal', objective: 'Prove Tutorial.add_zero by definitional equality.',
        theoremName: 'Tutorial.add_zero', proofPath: 'Submission.lean', dependsOn: [], revision: revised ? 1 : 0,
        ownerId: 'engineer', status: 'active' },
      { id: 'goal_2', kind: 'goal', objective: 'Prove Tutorial.zero_add using Nat.zero_add.',
        theoremName: 'Tutorial.zero_add', proofPath: 'Submission.lean', dependsOn: revised ? ['goal_1'] : [],
        revision: revised ? 1 : 0, ownerId: 'engineer', status: revised ? 'active' : 'paused' },
    ];
    const plan = { tasks, summary: 'Use the direct standard-library proofs; the second target waits for the human plan revision.' };
    fs.writeFileSync(path.join(workspace, 'RESEARCH.md'), 'Direct fixed-target proof route.\n\n```math-plan\n' + JSON.stringify(plan) + '\n```\n');
    if (coordination().peers.length) { complete(); }
    else {
      const file = instructions.match(/append one complete JSON line to (DELIVERIES-[a-f0-9]{64}\.jsonl)/u)?.[1];
      const envelope = instructions.match(/Use (\{"kind":"plan","baseVersion":"[^"]+",(?:"dispatchNonce":"[^"]+",)?)/u)?.[1];
      if (!file || !envelope) throw new Error('web_fixture_missing_plan_delivery_protocol');
      const binding = JSON.parse(envelope.replace(/,$/u, '}'));
      fs.appendFileSync(path.join(workspace, file), JSON.stringify({ ...binding, ...plan }) + '\n');
      // Keep Lead active while the Engineer receives human guidance on its own turn.
    }
  } else if (contract.stage === 'formal-proof') {
    if (contract.input.taskId !== 'goal_1' || edited()) pending = setTimeout(finishProof, 50);
  } else if (contract.stage !== 'candidate-review') {
    throw new Error('web_fixture_unexpected_cooperative_stage');
  }
  return {
    steer(text) {
      if (contract.stage === 'formal-proof' && text.includes(cooperativeGuidanceMarker)) {
        receivedGuidance = text;
        clearTimeout(pending); pending = setTimeout(finishProof, 100);
      } else if (contract.stage === 'candidate-review' && text.includes(cooperativeReviewMarker)) {
        clearTimeout(pending); pending = setTimeout(finishReview, 100);
      }
    },
    cancel() { clearTimeout(pending); },
  };
}
