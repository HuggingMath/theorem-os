import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalLibraryJson } from '../../src/math/libraryRelease';
import { mathDigest } from '../../src/math/mathRuntimeIo';
import { getLeanTaskEnvironment } from '../../src/math/leanTaskEnvironment';
import type { LibraryHostConfig } from '../../src/math/libraryHostConfig';

/** Synthetic serialization fixture, never release or kernel evidence. */
export function writeLibraryHostFixture(root: string, tasks: LibraryHostConfig['tasks'], largeModule = false) {
  const source = fileURLToPath(new URL('../fixtures/library-release/', import.meta.url));
  const releaseDirectory = path.join(root, 'release');
  fs.mkdirSync(releaseDirectory, { recursive: true });
  const sourceLakeManifest = path.join(root, 'lake-manifest.json');
  const environment = getLeanTaskEnvironment('openai-math');
  fs.writeFileSync(sourceLakeManifest, environment.files['lake-manifest.json']!);
  const lockDigest = mathDigest(fs.readFileSync(sourceLakeManifest));
  const encode = (value: unknown) => canonicalLibraryJson(value) + '\n';
  for (const name of ['pack.json', 'library.json', 'verification.json', 'declaration-metadata.jsonl', 'search-index-manifest.json']) {
    let bytes = fs.readFileSync(path.join(source, name));
    if (['library.json', 'verification.json', 'search-index-manifest.json'].includes(name)) {
      const data = JSON.parse(bytes.toString()); data.environment.lake_manifest_sha256 = lockDigest;
      if (name === 'verification.json') data.replay.coverage.environment.lake_manifest_sha256 = lockDigest;
      bytes = Buffer.from(encode(data));
    }
    fs.writeFileSync(path.join(releaseDirectory, name), bytes);
  }
  const metadataPath = path.join(releaseDirectory, 'declaration-metadata.jsonl');
  if (largeModule) {
    const read = (name: string) => JSON.parse(fs.readFileSync(path.join(releaseDirectory, name), 'utf8'));
    const write = (name: string, value: unknown) => fs.writeFileSync(path.join(releaseDirectory, name), encode(value));
    const pack = read('pack.json'), library = read('library.json'), verification = read('verification.json');
    const manifest = read('search-index-manifest.json');
    const module = pack.modules.at(-1), record = library.modules.at(-1);
    // E imports only Mathlib, so its installed and original source bytes are identical.
    module.source += '\n-- ' + 'x'.repeat(2 * 1024 * 1024) + '\n';
    record.sha256 = record.source_sha256 = mathDigest(module.source);
    const coverage = verification.replay.coverage;
    coverage.modules.find((item: { module: string }) => item.module === 'TheoremOS.Fixture.E').source_sha256 = record.source_sha256;
    coverage.module_set_sha256 = mathDigest(canonicalLibraryJson(coverage.modules));
    manifest.module_set.sha256 = mathDigest(canonicalLibraryJson(library.modules.map(({ file, module, sha256 }:
      { file: string; module: string; sha256: string }) => ({ file, module, sha256 }))));
    const rows = fs.readFileSync(metadataPath, 'utf8').trimEnd().split('\n').map(line => {
      const item = JSON.parse(line);
      if (item.source.module === 'TheoremOS.Fixture.E') item.source.sha256 = record.source_sha256;
      return encode(item);
    });
    fs.writeFileSync(metadataPath, rows.join(''));
    write('pack.json', pack); write('library.json', library); write('verification.json', verification);
    write('search-index-manifest.json', manifest);
  }
  const verificationDigest = mathDigest(fs.readFileSync(path.join(releaseDirectory, 'verification.json')));
  const declarations = fs.readFileSync(metadataPath, 'utf8').trimEnd().split('\n').map(line => {
    const item = JSON.parse(line);
    for (const ref of item.verification_refs) ref.sha256 = verificationDigest;
    return encode(item);
  });
  fs.writeFileSync(metadataPath, declarations.join(''));
  const manifestPath = path.join(releaseDirectory, 'search-index-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const name of Object.keys(manifest.artifacts)) {
    const bytes = fs.readFileSync(path.join(releaseDirectory, name));
    manifest.artifacts[name] = { bytes: bytes.length, sha256: mathDigest(bytes) };
  }
  fs.writeFileSync(manifestPath, encode(manifest));
  const config: LibraryHostConfig = { schema: 'theorem-os.library-host-config.v1', releaseDirectory, sourceLakeManifest,
    manifestSha256: mathDigest(fs.readFileSync(manifestPath)), tasks };
  const configPath = path.join(root, 'host-config.json');
  fs.writeFileSync(configPath, encode(config));
  return { config, configPath, environment };
}
