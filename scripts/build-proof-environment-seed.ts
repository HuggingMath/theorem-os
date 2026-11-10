#!/usr/bin/env bun
import path from 'node:path';
import { buildMathProofEnvironmentSeed } from '../src/math/mathProofEnvironmentSeed';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: bun scripts/build-proof-environment-seed.ts --project DIRECTORY --packages DIRECTORY --out DIRECTORY [--sources-only]');
} else {
  const value = (name: string) => {
    const index = args.indexOf(name), value = args[index + 1];
    if (index < 0 || !value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    return path.resolve(value);
  };
  const output = value('--out');
  const seed = await buildMathProofEnvironmentSeed(value('--project'), value('--packages'), output,
    { ...(args.includes('--sources-only') ? { contents: 'sources' as const } : {}),
      onProgress: phase => console.error(`[proof-environment-seed] ${phase}`) });
  console.log(JSON.stringify({ manifest: path.join(output, 'manifest.json'), imageBytes: seed.imageBytes,
    imageSha256: seed.imageSha256, stats: seed.metadata.stats }));
}
