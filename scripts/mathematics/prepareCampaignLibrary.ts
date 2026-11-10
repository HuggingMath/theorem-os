#!/usr/bin/env bun
import { parseArgs } from 'node:util';
import { prepareCampaignLibraryCatalog, prepareCampaignLibraryContinuation } from '../../src/solver/campaignLibrary';

export async function main(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { phase: { type: 'string' }, workspace: { type: 'string' },
    'release-directory': { type: 'string', multiple: true }, directory: { type: 'string' }, run: { type: 'string' },
    'task-file': { type: 'string' }, catalog: { type: 'string' }, 'catalog-sha256': { type: 'string' } } });
  const required = (name: keyof typeof values): string => {
    const value = values[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
    return value;
  };
  if (values.phase === 'catalog') return prepareCampaignLibraryCatalog({ workspace: required('workspace'),
    releaseDirectories: values['release-directory'] ?? [], directory: required('directory') });
  if (values.phase === 'continue') return prepareCampaignLibraryContinuation({ run: required('run'),
    taskFile: required('task-file'), catalog: { file: required('catalog'), digest: required('catalog-sha256') }, directory: required('directory') });
  throw new Error('--phase must be catalog or continue');
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => {
    console.error(error instanceof Error ? error.message : 'math_campaign_library_preparation_failed'); process.exitCode = 1;
  });
}
