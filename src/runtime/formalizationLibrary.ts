import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { getLeanTaskEnvironment, type LeanTaskEnvironment } from '../math/leanTaskEnvironment';
import { canonicalMathJson, mathDigest, readMathFile, readMathText } from '../math/mathRuntimeIo';
import { assertMathCanonicalPath } from '../math/paths';
import { readLibraryCatalog } from '../solver/libraryCatalog';

export type FormalizationLibraryAccess = Readonly<{ file: string; digest: string }>;
export const FORMALIZATION_LIBRARY_ROOT = '/opt/theoremos-library' as const;
const buildDirectory = '.lake/build/lib/lean';
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const buildReceiptSchema = z.object({
  schema: z.literal('theorem-os.web-library-build.v1'), toolchain: z.string(),
  mathlibRevision: z.string().optional(), environmentDigest: hash, catalogDigest: hash,
  library: z.object({ id: z.string(), revision: z.string(), catalogDigest: hash, environmentDigest: hash }).strict(),
  catalog: z.object({ file: z.literal('release/catalog.json'), sha256: hash }).strict(),
  modules: z.array(z.object({ file: z.string(), sourceDigest: hash, oleanDigest: hash }).strict()),
}).strict();

/** Validate the installed release before any of its bytes enter a formalization role. */
export function readFormalizationLibraryRelease(access: FormalizationLibraryAccess, environment: LeanTaskEnvironment) {
  if (!hash.safeParse(access.digest).success || !path.isAbsolute(access.file))
    throw new Error('formalization_library_access_invalid');
  const file = path.resolve(access.file);
  assertMathCanonicalPath(file);
  if (path.basename(file) !== 'catalog.json' || path.basename(path.dirname(file)) !== 'release')
    throw new Error('formalization_library_installation_invalid');
  const root = path.dirname(path.dirname(file)), config = getLeanTaskEnvironment(environment);
  const catalog = readLibraryCatalog(file, access.digest);
  if (catalog.environment !== environment || catalog.toolchain !== config.toolchain ||
      catalog.identity.environmentDigest !== config.dependencyDigest)
    throw new Error('formalization_library_environment_changed');
  const receiptFile = path.join(root, 'build-receipt.json');
  assertMathCanonicalPath(receiptFile);
  const receiptText = readMathText(receiptFile, 2_000_000), receipt = buildReceiptSchema.parse(JSON.parse(receiptText));
  if (receipt.toolchain !== config.toolchain || receipt.mathlibRevision !== config.mathlibRevision ||
      receipt.environmentDigest !== config.dependencyDigest || receipt.catalogDigest !== access.digest ||
      receipt.catalog.sha256 !== access.digest || canonicalMathJson(receipt.library) !== canonicalMathJson(catalog.identity) ||
      receipt.modules.length !== catalog.moduleCount || new Set(receipt.modules.map(module => module.file)).size !== catalog.moduleCount)
    throw new Error('formalization_library_build_changed');
  const records = new Map(receipt.modules.map(module => [module.file, module]));
  const files: { file: string; bytes: Buffer }[] = [
    { file: 'release/catalog.json', bytes: readMathFile(file, 128 * 1024 * 1024).bytes },
    { file: 'build-receipt.json', bytes: Buffer.from(receiptText) },
  ];
  if (mathDigest(files[0].bytes) !== access.digest) throw new Error('formalization_library_catalog_changed');
  for (const name of Object.keys(config.files)) {
    const installed = path.join(root, name); assertMathCanonicalPath(installed);
    const bytes = readMathFile(installed, 2_000_000).bytes;
    if (!bytes.equals(Buffer.from(config.files[name]))) throw new Error('formalization_library_configuration_changed');
    files.push({ file: name, bytes });
  }
  const modules = catalog.moduleFiles.map(file => {
    const module = catalog.readModule(file), sourceDigest = mathDigest(module.source), record = records.get(file);
    if (!record || record.sourceDigest !== sourceDigest) throw new Error('formalization_library_source_changed');
    const sourceFile = path.join(root, file); assertMathCanonicalPath(sourceFile);
    const source = readMathFile(sourceFile).bytes;
    if (mathDigest(source) !== sourceDigest) throw new Error('formalization_library_source_changed');
    const output = path.join(buildDirectory, file.replace(/\.lean$/u, '.olean'));
    const outputFile = path.join(root, output); assertMathCanonicalPath(outputFile);
    const olean = readMathFile(outputFile).bytes;
    if (mathDigest(olean) !== record.oleanDigest) throw new Error('formalization_library_olean_changed');
    files.push({ file, bytes: source }, { file: output, bytes: olean },
      { file: `release/objects/${sourceDigest}.lean`, bytes: source });
    return { file, digest: sourceDigest, import: file.slice(0, -'.lean'.length).replaceAll('/', '.') };
  });
  return { root, catalog, modules, files, buildDirectory, buildReceiptSha256: mathDigest(receiptText) };
}

/** Publish only checked files in an independent snapshot; unlisted host files never enter the role. */
export function snapshotFormalizationLibrary(directory: string, release: ReturnType<typeof readFormalizationLibraryRelease>): void {
  assertMathCanonicalPath(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  for (const { file, bytes } of release.files) {
    const destination = path.join(directory, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes, { flag: 'wx', mode: 0o400 });
  }
}
