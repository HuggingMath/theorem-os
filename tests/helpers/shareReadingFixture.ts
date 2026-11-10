import { mathDigest } from '../../src/math/mathRuntimeIo';
import { loadWebSample } from '../../apps/web/sample';
import { explanationDocument } from '../../apps/web/explanation';
import { webExplanationEvidence } from './webExplanationFixture';
import type { WebRun } from '../../apps/web/shared';

// Disposable recorded data for reader tests. It does not run a model or Lean.
export const readingProof = 'def duplicate (n : Nat) := n + n\n\ntheorem duplicate_eq (n : Nat) : duplicate n = n + n := by\n  rfl\n\ntheorem reading_target (n : Nat) : duplicate n = n + n := by\n  rw [duplicate_eq]\n';
export const readingCommit = '8'.repeat(40), readingEnvironment = '7'.repeat(64);
export function readingRun(id = '11111111-2222-4333-8444-555555555555'): WebRun {
  const sample = loadWebSample()!, run = structuredClone(sample.run), observation = structuredClone(sample.observations.at(-1)!);
  run.id = id; run.title = '展开定义，连接到目标'; run.task = '证明对任意自然数 $n$，$\\operatorname{duplicate}(n)=n+n$。';
  run.source = readingProof.replace('rw [duplicate_eq]', 'sorry'); run.environment = 'standard';
  run.result = { status: 'evaluated_passed', proof: readingProof, report: { usage: { totalTokens: 1200 },
    evaluator: { status: 'passed', method: 'host-lean-kernel-all-targets', verification: { sourceDigest: mathDigest(readingProof),
      verification: { results: [{ theoremName: 'reading_target', status: 'kernel_verified', sorryCount: 0, admitCount: 0 }] } } } } };
  const task = observation.inspection.tasks[0]!;
  observation.webRunId = id; observation.inspection.problem = { ...observation.inspection.problem, statement: run.task,
    assumptions: ['$n \\in \\mathbb{N}$'], formalStatement: run.source, targets: [{ proofPath: 'Submission.lean', theoremName: 'reading_target' }] };
  observation.inspection.tasks = ['normalization', 'conclusion'].map((id, index) => ({ ...task, id, version: mathDigest(id),
    kind: index ? 'goal' : 'lemma', objective: index ? '将展开式接回原题' : '展开 duplicate 的定义',
    theorem: index ? 'reading_target' : 'duplicate_eq', type: '∀ n : Nat, duplicate n = n + n',
    informalStatement: '对自然数 $n$，$\\operatorname{duplicate}(n)=n+n$。',
    informalProof: index ? '在目标中用前一步的等式替换 $\\operatorname{duplicate}(n)$，右侧与目标一致。' : '按定义 $\\operatorname{duplicate}(n)=n+n$，因此等式由自反性成立。',
    premises: ['$n \\in \\mathbb{N}$'], plannedDependencies: index ? ['normalization'] : [],
    feedback: 'PRIVATE-DIAGNOSTIC /home/private', finding: undefined,
    proof: { status: 'verified', commit: readingCommit, sourceDigest: mathDigest(readingProof), receiptIds: [`receipt-${id}`],
      conditions: index ? [{ taskId: 'normalization', taskDigest: mathDigest('normalization') }] : [] } }));
  observation.sources = observation.inspection.tasks.map(task => ({ taskId: task.id, taskVersion: task.version, commit: readingCommit,
    sourceDigest: mathDigest(readingProof), environmentDigest: readingEnvironment, file: 'Submission.lean', source: readingProof, scope: 'owned-file' }));
  observation.checks = observation.inspection.tasks.map(task => ({ id: `receipt-${task.id}`, taskId: task.id, taskVersion: task.version,
    commit: readingCommit, sourceDigest: mathDigest(readingProof), environmentDigest: readingEnvironment, record: { private: 'PRIVATE-CHECK-LOG' } }));
  observation.plan = { schema: 'fixture', baseVersion: 'fixture-plan', tasks: observation.inspection.tasks.map(task => ({ id: task.id,
    kind: task.kind, objective: task.objective, dependsOn: task.plannedDependencies, revision: 1 })),
    proofRoutes: [{ id: 'reading-route', targetTaskId: 'conclusion', prerequisiteTaskIds: ['normalization'], closingTaskId: 'conclusion' }] };
  run.observation = observation; return run;
}

export function readingEvidence(language: 'zh' | 'en' = 'zh') {
  return webExplanationEvidence({ proof: readingProof, target: 'reading_target', language, units: [
    { name: 'duplicate', kind: 'definition', snippet: 'def duplicate (n : Nat) := n + n', statement: language === 'zh' ? '定义 $\\operatorname{duplicate}(n)=n+n$。' : 'Define $\\operatorname{duplicate}(n)=n+n$.' },
    { name: 'duplicate_eq', kind: 'theorem', uses: ['duplicate'], snippet: 'theorem duplicate_eq (n : Nat) : duplicate n = n + n := by\n  rfl',
      steps: [['rfl']], texts: [language === 'zh' ? '展开定义后，两边都是 $n+n$，因此由等式自反性得到结论。' : 'Unfolding the definition makes both sides $n+n$, so reflexivity proves the equality.'],
      goals: [{ snippet: 'rfl', before: ['n : Nat\n⊢ duplicate n = n + n'], after: [] }] },
    { name: 'reading_target', kind: 'theorem', uses: ['duplicate', 'duplicate_eq'], snippet: 'theorem reading_target (n : Nat) : duplicate n = n + n := by\n  rw [duplicate_eq]',
      steps: [['rw [duplicate_eq]']], texts: [language === 'zh' ? '用前一步 $\\operatorname{duplicate}(n)=n+n$ 改写目标，得到两侧相同的等式，目标随即关闭。' : 'Rewrite with the previous equality $\\operatorname{duplicate}(n)=n+n$. The two sides match and the goal closes.'],
      goals: [{ snippet: 'rw [duplicate_eq]', before: ['n : Nat\n⊢ duplicate n = n + n'], after: [] }] },
  ] });
}
export const readingDocument = (language: 'zh' | 'en' = 'zh') => explanationDocument(readingEvidence(language), readingProof);
