import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';
import type { SolverRunState } from '../../src/solver/archive';
import { DECLARATION_ARTIFACTS_FILE, readDeclarationArtifacts } from '../../src/solver/declarationArtifacts';
import type { WebDeclarationArtifacts } from './collaboration';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), commit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);
const evidence = { evidence: z.literal('recorded-not-replayed'), acceptance: z.literal('not-assessed'), requiresFreshCheck: z.literal(true) };
export const webDeclarationArtifactsSchema = z.discriminatedUnion('status', [
  z.object({ ...evidence, status: z.literal('absent') }).strict(),
  z.object({ ...evidence, status: z.literal('unknown'), reason: z.string().min(1).max(200) }).strict(),
  z.object({ ...evidence, status: z.literal('recorded'), digest: hash, omitted: z.number().int().nonnegative(),
    declarations: z.array(z.object({ id: hash, file: z.string().min(1).max(1000), name: z.string().min(1).max(1000),
      type: z.string().min(1).max(24000), elaboratedType: z.string().max(24000).optional(),
      premises: z.array(z.string().max(8000)).max(128), sourceCommit: commit, checkedCommit: commit,
      environmentDigest: hash, receiptIds: z.array(z.string().min(1).max(1000)).max(128) }).strict()).max(128) }).strict(),
]);

/** Read the host sidecar and publish provenance without exposing host paths or granting acceptance. */
export function projectWebDeclarationArtifacts(stateFile: string, state: SolverRunState): WebDeclarationArtifacts {
  const file = path.join(path.dirname(stateFile), DECLARATION_ARTIFACTS_FILE);
  const recorded = { evidence: 'recorded-not-replayed', acceptance: 'not-assessed', requiresFreshCheck: true } as const;
  if (!fs.existsSync(file)) return { ...recorded, status: 'absent' };
  try {
    const digest = mathDigest(readMathText(file, 32 * 1024 * 1024));
    const artifacts = readDeclarationArtifacts(path.dirname(stateFile), state);
    if (mathDigest(readMathText(file, 32 * 1024 * 1024)) !== digest) throw new Error('changed');
    const declarations: Extract<WebDeclarationArtifacts, { status: 'recorded' }>['declarations'] = [];
    let usedBytes = 0;
    for (const artifact of artifacts.slice(0, 128)) {
      const declaration = {
        id: artifact.id, file: artifact.declaration.file, name: artifact.declaration.name, type: artifact.declaration.type,
        elaboratedType: artifact.proof.verification.results[0]?.elaboratedDeclarationType,
        premises: [...(artifact.declaration.premises ?? [])], sourceCommit: artifact.proof.commit,
        checkedCommit: artifact.proof.verification.targetCommit, environmentDigest: artifact.environmentDigest,
        receiptIds: artifact.proof.verification.results.map(receipt => receipt.receiptId),
      };
      const bytes = Buffer.byteLength(JSON.stringify(declaration));
      // Share the bridge's 15 MiB envelope with inspection, immutable sources and other check records.
      if (usedBytes + bytes > 4 * 1024 * 1024) break;
      declarations.push(declaration); usedBytes += bytes;
    }
    return webDeclarationArtifactsSchema.parse({ ...recorded, status: 'recorded', digest,
      omitted: artifacts.length - declarations.length, declarations }) as WebDeclarationArtifacts;
  } catch { return { ...recorded, status: 'unknown', reason: 'web_declaration_artifacts_unavailable' }; }
}
