import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';

test('campaign reference discovery replays saved cards and academic feeds without network', () => {
  const result = spawnSync(process.env.THEOREMOS_TEST_PYTHON ?? '/usr/bin/python3',
    ['-B', '-m', 'unittest', 'discover', '-s', 'tests', '-p', 'campaign_reference*_test.py', '-v'],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
