import fs from 'node:fs';
import path from 'node:path';
import { LAKE_CONFIGURATION_FILES, mathLocalModuleBuildOrder } from '../../src/math/mathConstructionSources';
import { mathDigest } from '../../src/math/mathRuntimeIo';

/** Advisory metadata fixture only; the host verifier must still independently check the proof. */
export function captureLeanCompletion(project: string, requestedFiles = ['Submission.lean']) {
  const configuration = LAKE_CONFIGURATION_FILES.map(file => ({ file,
    digest: fs.existsSync(path.join(project, file)) ? mathDigest(fs.readFileSync(path.join(project, file))) : null }));
  const sourceFiles = mathLocalModuleBuildOrder(project, requestedFiles).map(({ file }) =>
    ({ file, digest: mathDigest(fs.readFileSync(path.join(project, file))) }));
  const diagnostic = { schema: 'theoremos.lean-diagnostics-latest.v1', authority: 'advisory-lean-process',
    exitCode: 0, timedOut: false, aborted: false, requestedFiles, sourceFiles, configuration,
    sourceDigest: mathDigest(JSON.stringify([
      configuration.map(item => item.digest ?? ''), sourceFiles.map(item => [item.file, item.digest]),
    ])), environmentDigest: mathDigest('offline-lean-completion-fixture'),
  };
  fs.mkdirSync(path.join(project, '.lake'), { recursive: true });
  fs.writeFileSync(path.join(project, '.lake/lean-diagnostics-latest.json'), JSON.stringify(diagnostic));
  return diagnostic;
}
