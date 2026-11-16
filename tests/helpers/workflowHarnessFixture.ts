import fs from 'node:fs';
import path from 'node:path';
import { mathDigest } from '../../src/math/mathRuntimeIo';

/** Preparation only: the frozen executable is never launched or given credentials. */
export function workflowHarnessFixture(base: string, id: 'claude-code' | 'opencode' | 'cli', sealed = true) {
  const profile = path.join(base, id + '-profile'), executable = path.join(base, id + '-offline');
  fs.mkdirSync(profile); fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  if (id === 'claude-code') fs.writeFileSync(path.join(profile, 'settings.json'), '{}');
  if (id === 'opencode') fs.writeFileSync(path.join(profile, 'opencode.json'), JSON.stringify({ provider: { fixture: {
    npm: '@ai-sdk/openai-compatible', models: { model: { variants: { high: {}, max: {} } } },
  } } }));
  if (id === 'cli') fs.writeFileSync(path.join(profile, 'cli.json'), JSON.stringify({
    schema: 'theorem-os.cli-harness.v1', executable, args: ['--model', '{model}', '--effort', '{effort}'],
    efforts: ['high', 'max'], ...(sealed ? { sealedRole: {
      provider: { wireApi: 'responses', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnvironment: 'FIXTURE_API_KEY' },
      client: { baseUrlEnvironment: 'FIXTURE_RELAY_URL', apiKeyEnvironment: 'FIXTURE_RELAY_KEY' },
    } } : {}),
  }));
  return { flags: ['--harness', id, '--model', id === 'opencode' ? 'fixture/model' : 'fixture',
    '--harness-profile', profile, '--harness-executable', executable],
    binding: { id, profile, executable, executableDigest: mathDigest(fs.readFileSync(executable)) } };
}
