import type { WebAgentLeanCheck, WebLeanMessage } from '../../apps/web/shared';
import { mathDigest } from '../../src/math/mathRuntimeIo';

/** A synthetic check bound to the source version the browser should display. */
export function webCheckedLeanFixture(source: string, passed: boolean, diagnostics: WebLeanMessage[] = []): WebAgentLeanCheck {
  const file = 'Submission.lean', digest = mathDigest(source);
  const sourceDigest = mathDigest(JSON.stringify({ [file]: digest })), environmentDigest = mathDigest('fixture environment');
  const messages = diagnostics.map(message => ({ file, ...message }));
  const artifact = mathDigest(JSON.stringify({ sourceDigest, environmentDigest, passed, messages }));
  return { passed, classification: passed ? 'success' : 'lean', sourceDigest, environmentDigest, messages,
    artifacts: [{ path: '.lake/diagnostic-artifacts/' + artifact + '.json', digest: artifact, sourceDigest, environmentDigest }],
    checkedSource: { file, digest, text: source, artifact } };
}
