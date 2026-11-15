import { projectMathematicsRuntimeEnvironment, resolveMathematicsRuntimeEnvironment } from '../math/mathRuntimeEnvironment';
import { canonicalMathJson, mathDigest, readMathText } from '../math/mathRuntimeIo';
import { MATH_TOOLS_ROOT_ENV, MATH_TOOLS_SHA256_ENV, readMathTools } from '../math/mathTools';
import { readPantographBackend, PANTOGRAPH_DIGEST_ENV } from '../math/pantographSession';
import type { MathRetrievalCorpus } from '../math/mathRetrievalCorpus';

/** Bind the resource bytes that join a solver's environment identity before any model admission. */
export function prepareSolverRuntimeEnvironment(source: NodeJS.ProcessEnv = process.env) {
  let environment = resolveMathematicsRuntimeEnvironment(source);
  const corpusFile = environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS;
  const corpusBytes = corpusFile ? Buffer.from(readMathText(corpusFile), 'utf8') : undefined;
  const corpus = corpusBytes ? JSON.parse(corpusBytes.toString('utf8')) as MathRetrievalCorpus : undefined;
  if (corpusBytes) {
    const digest = mathDigest(corpusBytes);
    if (environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256 &&
        environment.DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256 !== digest) throw new Error('math_corpus_identity_changed');
    environment = { ...environment, DEEPSCIENTIST_MATH_RETRIEVAL_CORPUS_SHA256: digest };
  }
  const mathTools = environment[MATH_TOOLS_ROOT_ENV] ? readMathTools(environment[MATH_TOOLS_ROOT_ENV]!) : undefined;
  if (mathTools) {
    if (environment[MATH_TOOLS_SHA256_ENV] && environment[MATH_TOOLS_SHA256_ENV] !== mathTools.digest)
      throw new Error('math_tools_identity_changed');
    environment = { ...environment, [MATH_TOOLS_SHA256_ENV]: mathTools.digest };
  }
  const proofSearchBackend = readPantographBackend(environment);
  if (proofSearchBackend) environment = { ...environment, [PANTOGRAPH_DIGEST_ENV]: proofSearchBackend.digest };
  const environmentDigest = mathDigest(canonicalMathJson(projectMathematicsRuntimeEnvironment(environment)));
  return { environment, environmentDigest, corpusFile, corpusBytes, corpus, mathTools, proofSearchBackend };
}
