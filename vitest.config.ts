import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { tacticBatteryCacheTestDefines } from './tests/helpers/tacticBatteryCache';

const temporaryRoot = process.env.TMPDIR || '/data/lzh/default-storage/tmp';
fs.mkdirSync(temporaryRoot, { recursive: true });
const cacheRoot = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'theoremos-vitest-cache-')));

export default defineConfig({
  define: tacticBatteryCacheTestDefines(path.join(cacheRoot, 'tactic-battery')),
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 15_000,
    provide: { theoremosTestCacheRoot: cacheRoot }, globalSetup: ['./tests/setup/cacheCleanup.ts'] },
});
