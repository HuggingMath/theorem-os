import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import mathlibResource from '../../resources/mathlib/environment.json';
import mathlib48Resource from '../../resources/mathlib/environment-4.8.json';
import openaiMathResource from '../../resources/openai-math/environment.json';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { LOCAL_EXAMPLE_TOOLCHAIN } from './localExample';

export type LeanTaskEnvironment = 'standard' | 'mathlib' | 'mathlib-4.8' | 'openai-math';
export type LeanTaskEnvironmentConfig = Readonly<{
  id: LeanTaskEnvironment;
  toolchain: string;
  files: Readonly<Record<string, string>>;
  dependencyDigest: string;
  mathlibRevision?: string;
  /** Older Lake releases place dependency oleans directly under build/lib. */
  packageLibraryDirectory?: '.lake/build/lib';
}>;

const standardFiles = Object.freeze({
  'lean-toolchain': `${LOCAL_EXAMPLE_TOOLCHAIN}\n`,
  'lakefile.toml': 'name = "theorem_os_problem"\nversion = "0.1.0"\n\n[[lean_lib]]\nname = "Submission"\n',
  'lake-manifest.json': JSON.stringify({ version: '1.1.0', packagesDir: '.lake/packages', packages: [],
    name: 'theorem_os_problem', lakeDir: '.lake' }) + '\n',
});

function configuration(id: LeanTaskEnvironment, toolchain: string, files: Readonly<Record<string, string>>,
  mathlibRevision?: string, packageLibraryDirectory?: '.lake/build/lib'): LeanTaskEnvironmentConfig {
  return Object.freeze({ id, toolchain, files,
    ...(mathlibRevision ? { mathlibRevision } : {}),
    ...(packageLibraryDirectory ? { packageLibraryDirectory } : {}),
    dependencyDigest: mathDigest(canonicalMathJson({ schema: 'theorem-os.lean-task-environment.v1', id, toolchain, files,
      ...(mathlibRevision ? { mathlibRevision } : {}),
      ...(packageLibraryDirectory ? { packageLibraryDirectory } : {}) })) });
}

const standard = configuration('standard', LOCAL_EXAMPLE_TOOLCHAIN, standardFiles);
const gitRevision = z.string().regex(/^[0-9a-f]{40}$/u);
const packageSchema = z.object({
  url: z.string().url().startsWith('https://github.com/'), type: z.literal('git'), subDir: z.null(),
  scope: z.string().min(1).optional(), rev: gitRevision, name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u),
  manifestFile: z.literal('lake-manifest.json'), inputRev: z.string().min(1), inherited: z.boolean(),
  configFile: z.enum(['lakefile.toml', 'lakefile.lean']),
}).strict();
const pinnedResource = <Id extends 'mathlib' | 'openai-math', Toolchain extends string>(id: Id, toolchain: Toolchain) => z.object({
  schema: z.literal('theorem-os.lean-task-mathlib.v1'), id: z.literal(id),
  toolchain: z.literal(toolchain), mathlibRevision: gitRevision,
  lakefile: z.string().min(1), manifest: z.object({
    version: z.literal('1.2.0'), packagesDir: z.literal('.lake/packages'),
    packages: z.array(packageSchema.extend({ scope: z.string().min(1) }).strict()).min(1),
    name: z.literal('theorem_os_problem'), lakeDir: z.literal('.lake'), fixedToolchain: z.literal(true),
  }).strict(),
}).strict();
const resource = pinnedResource('mathlib', LOCAL_EXAMPLE_TOOLCHAIN).parse(mathlibResource);
// The OpenAI math comparator challenges pin their own Lean release and Mathlib revision.
const resourceOpenaiMath = pinnedResource('openai-math', 'leanprover/lean4:v4.34.1').parse(openaiMathResource);
const resource48 = z.object({
  schema: z.literal('theorem-os.lean-task-mathlib.v1'), id: z.literal('mathlib-4.8'),
  toolchain: z.literal('leanprover/lean4:v4.8.0'),
  mathlibRevision: z.literal('b5eba595428809e96f3ed113bc7ba776c5f801ac'),
  lakefile: z.string().min(1), manifest: z.object({
    version: z.literal(7), packagesDir: z.literal('.lake/packages'),
    packages: z.array(packageSchema.omit({ scope: true }).strict()).min(1),
    name: z.literal('theorem_os_problem'), lakeDir: z.literal('.lake'),
  }).strict(),
}).strict().parse(mathlib48Resource);

function mathlibConfiguration(selected: typeof resource | typeof resource48 | typeof resourceOpenaiMath): LeanTaskEnvironmentConfig {
  const rootPackage = selected.manifest.packages.find(item => item.name === 'mathlib');
  const lakefile = parseToml(selected.lakefile);
  const requirements = lakefile.require as { name?: unknown; git?: unknown; rev?: unknown }[] | undefined;
  if (!rootPackage || rootPackage.rev !== selected.mathlibRevision || rootPackage.inputRev !== selected.mathlibRevision ||
      rootPackage.url !== 'https://github.com/leanprover-community/mathlib4.git' || rootPackage.inherited ||
      rootPackage.configFile !== 'lakefile.lean' || requirements?.length !== 1 || requirements[0]?.name !== 'mathlib' ||
      requirements[0]?.git !== rootPackage.url || requirements[0]?.rev !== selected.mathlibRevision ||
      new Set(selected.manifest.packages.map(item => item.name)).size !== selected.manifest.packages.length ||
      selected.manifest.packages.some(item => item.name !== 'mathlib' && !item.inherited))
    throw new Error('lean_task_mathlib_resource_invalid');
  return configuration(selected.id, selected.toolchain, Object.freeze({
    'lean-toolchain': `${selected.toolchain}\n`,
    'lakefile.toml': selected.lakefile,
    'lake-manifest.json': JSON.stringify(selected.manifest, null, 2) + '\n',
  }), selected.mathlibRevision, selected.id === 'mathlib-4.8' ? '.lake/build/lib' : undefined);
}
const mathlib = mathlibConfiguration(resource), mathlib48 = mathlibConfiguration(resource48);
const openaiMath = mathlibConfiguration(resourceOpenaiMath);
if (openaiMath.mathlibRevision !== 'd13f23b723b8a846827a245b89c10fc7d3f11612')
  throw new Error('openai_math_revision_changed');

/** Dependency choices are supplied by this runtime, never by task source or a caller URL. */
export function getLeanTaskEnvironment(id: LeanTaskEnvironment = 'standard'): LeanTaskEnvironmentConfig {
  if (id === 'standard') return standard;
  if (id === 'mathlib') return mathlib;
  if (id === 'mathlib-4.8') return mathlib48;
  if (id === 'openai-math') return openaiMath;
  throw new Error('lean_task_environment_unavailable');
}
