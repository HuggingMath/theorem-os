import { DockerWebRunner } from '../apps/web/runner';
import { WebPrechecker } from '../apps/web/precheck';

/**
 * Opt-in: compiles a few statements with the real worker image (`THEOREMOS_WEB_WORKER_IMAGE`, default
 * theorem-os-worker:local). Starts throwaway containers without network; needs Docker and the built image.
 */
const runner = new DockerWebRunner({ workerImage: process.env.THEOREMOS_WEB_WORKER_IMAGE || 'theorem-os-worker:local' });
const checker = new WebPrechecker(runner.check);
const cases = [
  { name: 'standard ready', environment: 'standard', source: 'theorem a : 1 + 1 = 2 := by sorry\n', status: 'ready' },
  { name: 'standard error', environment: 'standard', source: 'theorem a : True := by\n  exact foo\n', status: 'errors', line: 2 },
  { name: 'standard complete', environment: 'standard', source: 'theorem a : True := trivial\n', status: 'complete' },
  { name: 'standard without Mathlib', environment: 'standard', source: 'import Mathlib\ntheorem a : True := by sorry\n', status: 'errors', line: 1 },
  { name: 'structural', environment: 'standard', source: 'def a := 1\n', status: 'invalid' },
  { name: 'mathlib ready', environment: 'mathlib', source: 'import Mathlib\ntheorem a (x : ℝ) : (x + 1) ^ 2 = x ^ 2 + 2 * x + 1 := by sorry\n', status: 'ready' },
  { name: 'mathlib error', environment: 'mathlib', source: 'import Mathlib\ntheorem a (x : ℝ) : x ≤ |x| := by\n  exact le_abs_self_typo x\n', status: 'errors', line: 3 },
] as const;
let failed = 0;
for (const item of cases) {
  const started = Date.now();
  const result = await checker.check('smoke', { environment: item.environment, source: item.source }, new AbortController().signal);
  const ok = result.status === item.status && (!('line' in item) || result.diagnostics[0]?.line === item.line);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${item.name}: ${result.status} in ${Date.now() - started}ms`,
    JSON.stringify(result.diagnostics.slice(0, 2)).slice(0, 300));
}
const aborted = new AbortController();
const pending = checker.check('smoke-abort', { environment: 'mathlib', source: 'import Mathlib\ntheorem b : (2 : ℝ) ≤ 3 := by sorry\n' }, aborted.signal);
setTimeout(() => aborted.abort(new Error('aborted')), 500);
const abortedOutcome = await pending.then(() => 'resolved', () => 'rejected');
console.log(`${abortedOutcome === 'rejected' ? 'PASS' : 'FAIL'} abort: ${abortedOutcome}`);
if (abortedOutcome !== 'rejected') failed++;
process.exit(failed ? 1 : 0);
