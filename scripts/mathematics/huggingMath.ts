#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exportHuggingMathRun, readHuggingMathBundle } from '../../src/math/huggingMathBundle';
import { loginHuggingMath, writeHubSessionProfile } from '../../src/math/huggingMathClient';
import { applyHuggingMathImport, previewHuggingMathImport, readbackHuggingMathImport } from '../../src/math/huggingMathImports';

const help = `Usage: theorem-os hub <export|validate|login|preview|apply|record> [arguments]
  export  --state STATE_JSON --result RESULT_JSON --metadata METADATA_JSON --output NEW_DIRECTORY
          [--declaration ARTIFACT_ID ...]
  validate --bundle BUNDLE_DIRECTORY_OR_ZIP
  login   --url HUB_BASE_URL --username USER --password-env VARIABLE_NAME --profile NEW_PROFILE_JSON
  preview --bundle BUNDLE_DIRECTORY_OR_ZIP --profile PROFILE_JSON [--owner USER] --output NEW_IMPORT_JSON
  apply   --import IMPORT_JSON --profile PROFILE_JSON
  record  --import IMPORT_JSON --profile PROFILE_JSON

Export reads frozen, finished results and committed sources; it never runs Lean or a
model, edits a run, or infers original acceptance from independent helper records.
Metadata requires attribution. Optional title/language/provider/external_id/sources
and per-attachment rights are described in docs/huggingmath.md. Unspecified rights
remain unknown. --declaration selects historical provenance, not additional proofs.
The output contains bundle/ and bundle.zip. validate checks transport identities;
Hub performs its own pinned-format validation at preview.

Login uses the deployed ordinary Django form/session/CSRF flow. The password is read
from the named environment variable, never from a command argument. The 0600 profile
contains session cookies; keep it outside source/worktree/bundle directories.
Preview stages a private import and saves the exact batch, plan and retry key.
Apply creates private drafts, saves the returned mapping, then checks record/file
identities. Re-run apply with the SAME import file after an uncertain network result.
A stale plan needs a new preview; different batches require their own saved keys.
record refreshes saved mapping; before apply it only reads the staging batch.
External success remains source evidence; Hub verification stays not_run. This tool
does not make a canonical decision, publish, or admit a library. /v1 fetch/Pack/
verification services remain draft. No background upload or solver hook is installed.`;

try {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '--help', '-h'].includes(command) || args.includes('--help')) console.log(help);
  else {
    const { values } = parseArgs({ args, options: {
      state: { type: 'string' }, result: { type: 'string' }, metadata: { type: 'string' }, output: { type: 'string' },
      declaration: { type: 'string', multiple: true }, bundle: { type: 'string' },
      url: { type: 'string' }, username: { type: 'string' }, 'password-env': { type: 'string' },
      profile: { type: 'string' }, owner: { type: 'string' }, import: { type: 'string' },
    } });
    const required = (name: keyof typeof values): string => {
      const value = values[name];
      if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
      return value;
    };
    if (command === 'export') {
      const result = exportHuggingMathRun({ stateFile: path.resolve(required('state')), resultFile: path.resolve(required('result')),
        metadataFile: path.resolve(required('metadata')), outputDirectory: path.resolve(required('output')),
        declarationIds: values.declaration });
      console.log(JSON.stringify({ directory: result.directory, zipFile: result.zipFile,
        bundleDigest: result.bundleDigest, warnings: result.warnings }));
    } else if (command === 'validate') {
      const checked = readHuggingMathBundle(path.resolve(required('bundle')));
      console.log(JSON.stringify({ valid: true, bundleDigest: checked.bundleDigest, zipBytes: checked.zip.length }));
    } else if (command === 'login') {
      const output = path.resolve(required('profile'));
      if (fs.existsSync(output)) throw new Error('huggingmath_profile_exists');
      const variable = required('password-env');
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) throw new Error('--password-env must name an environment variable');
      const password = process.env[variable];
      if (!password) throw new Error('huggingmath_password_environment_missing');
      const profile = await loginHuggingMath(required('url'), required('username'), password);
      writeHubSessionProfile(output, profile);
      console.log(JSON.stringify({ profile: output, server: profile.baseUrl, authenticated: true }));
    } else if (command === 'preview') {
      const output = path.resolve(required('output'));
      const journal = await previewHuggingMathImport({ bundleFile: path.resolve(required('bundle')),
        profileFile: path.resolve(required('profile')), owner: values.owner, outputFile: output });
      console.log(JSON.stringify({ importFile: output, batchId: journal.batchId, bundleDigest: journal.bundleDigest,
        planDigest: journal.planDigest, plan: journal.preview.plan }));
    } else if (command === 'apply' || command === 'record') {
      const input = path.resolve(required('import'));
      const profile = path.resolve(required('profile'));
      const journal = command === 'apply' ? await applyHuggingMathImport(input, profile) : await readbackHuggingMathImport(input, profile);
      console.log(JSON.stringify({ importFile: input, batchId: journal.batchId, bundleDigest: journal.bundleDigest,
        ...(journal.result ? { result: journal.result } : { state: 'previewed' }),
        ...(journal.record ? { record: journal.record } : {}) }));
    } else throw new Error(`Unknown hub command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'huggingmath_failed');
  process.exitCode = 1;
}
