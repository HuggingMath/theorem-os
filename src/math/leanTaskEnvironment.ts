import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';
import mathlibResource from '../../resources/mathlib/environment.json';
import mathlib48Resource from '../../resources/mathlib/environment-4.8.json';
import openaiMathResource from '../../resources/openai-math/environment.json';
import cartierSupportResource from '../../resources/openai-cartier-support/environment.json';
import characterSupportResource from '../../resources/openai-character-support/environment.json';
import { canonicalMathJson, mathDigest } from './mathRuntimeIo';
import { LOCAL_EXAMPLE_TOOLCHAIN } from './localExample';

export type LeanTaskEnvironment = 'standard' | 'mathlib' | 'mathlib-4.8' | 'openai-math' | 'openai-math-cartier-reviewed-v1' | 'openai-math-character-reviewed-v1';
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

// This runtime-owned environment exposes only the independently reviewed Cartier
// import closure; callers cannot supply files, package paths or source URLs.
const cartierSupportPaths = [
  "OAI/AlgebraicGeometry/CartierSections/ChartCompletion.lean",
  "OAI/AlgebraicGeometry/CartierSections/ChartRetraction.lean",
  "OAI/AlgebraicGeometry/CartierSections/ClosedCharts.lean",
  "OAI/AlgebraicGeometry/CartierSections/ConeTopology.lean",
  "OAI/AlgebraicGeometry/CartierSections/ExpansionValuation.lean",
  "OAI/AlgebraicGeometry/CartierSections/FieldRetraction.lean",
  "OAI/AlgebraicGeometry/CartierSections/FieldTopology.lean",
  "OAI/AlgebraicGeometry/CartierSections/FormalValuation.lean",
  "OAI/AlgebraicGeometry/CartierSections/FractionValuation.lean",
  "OAI/AlgebraicGeometry/CartierSections/InfinitesimalCharts.lean",
  "OAI/AlgebraicGeometry/CartierSections/PolynomialValuation.lean",
  "OAI/AlgebraicGeometry/CartierSections/Weights.lean"
] as const;
function reviewedCartierEnvironment(): LeanTaskEnvironmentConfig {
  const resource = z.object({
    schema: z.literal('theorem-os.openai-cartier-support.v1'),
    upstreamCommit: z.literal('1581d4cbdd69a0faf34b2089614fe2a814316a6a'),
    files: z.array(z.object({ path: z.enum(cartierSupportPaths),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u), source: z.string().min(1),
    }).strict()).length(cartierSupportPaths.length),
  }).strict().parse(cartierSupportResource);
  if (new Set(resource.files.map(file => file.path)).size !== cartierSupportPaths.length ||
      resource.files.some(file => mathDigest(file.source) !== file.sha256))
    throw new Error('openai_cartier_support_resource_invalid');
  const files = Object.freeze({ ...openaiMath.files,
    'lakefile.toml': openaiMath.files['lakefile.toml'] +
      '\n[[lean_lib]]\nname = "OAI"\nroots = ["OAI.AlgebraicGeometry.CartierSections.FieldTopology", "OAI.AlgebraicGeometry.CartierSections.FieldRetraction"]\nglobs = ["OAI.+"]\n',
    ...Object.fromEntries(resource.files.map(file => [file.path, file.source])),
  });
  return configuration('openai-math-cartier-reviewed-v1', openaiMath.toolchain, files, openaiMath.mathlibRevision);
}
const openaiCartier = reviewedCartierEnvironment();


// The closed public import closure excludes the publisher's solution module.
const characterSupportPaths = [
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/AtomicFrames.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/AtomicGallery.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/BoundaryEnumeration.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/BoundarySurgery.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/DoubledStrips.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/FreshGallery.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/GraftCircuits.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/GraftValues.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/Grafting.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/MarkedDiagram.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/PortSurgery.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/RefinedDiagram.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/StripFacets.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Cutting/StripForest.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BandCut.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BandCutTopology.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BandCycles.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BandIncidence.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BoundaryBands.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BoundaryCycles.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BoundaryFrames.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/BoundaryReordering.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/ComplementaryPatches.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/CornerGauge.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/CutCircleIndex.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/DiskGauge.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/FlagGalleries.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/Flags.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/GeneratorGauge.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/Incidence.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/MatrixExpressions.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/MatrixPresentation.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/PatchCycles.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/PortPatches.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/RoutedFamilies.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/SplitFlags.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/SurfacePresentation.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/SurfaceSurgery.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/VertexFrames.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Foundation/VertexGauge.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/AtomicFlags.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/BandBases.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/BandGauges.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/CutFrames.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/Endpoints.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/GradeMaps.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/Graded.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/MarkedFrames.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/Mirror.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Frames/NamedSeams.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/BoundaryWords.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/CutWords.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/Handles.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/InverseSolution.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/MarkedSurface.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/ProducedDiagram.lean",
  "OAI/AlgebraicGeometry/CharacterVarieties/Seams/ProducedEquations.lean"
] as const;
function reviewedCharacterEnvironment(): LeanTaskEnvironmentConfig {
  const resource = z.object({
    schema: z.literal('theorem-os.openai-character-support.v1'),
    upstreamCommit: z.literal('1581d4cbdd69a0faf34b2089614fe2a814316a6a'),
    files: z.array(z.object({ path: z.enum(characterSupportPaths),
      sha256: z.string().regex(/^[a-f0-9]{64}$/u), source: z.string().min(1),
    }).strict()).length(characterSupportPaths.length),
  }).strict().parse(characterSupportResource);
  if (new Set(resource.files.map(file => file.path)).size !== characterSupportPaths.length ||
      resource.files.some(file => mathDigest(file.source) !== file.sha256))
    throw new Error('openai_character_support_resource_invalid');
  const files = Object.freeze({ ...openaiMath.files,
    'lakefile.toml': openaiMath.files['lakefile.toml'] +
      '\n[[lean_lib]]\nname = "OAI"\nroots = ["OAI.AlgebraicGeometry.CharacterVarieties.Seams.ProducedEquations"]\nglobs = ["OAI.+"]\n',
    ...Object.fromEntries(resource.files.map(file => [file.path, file.source])),
  });
  return configuration('openai-math-character-reviewed-v1', openaiMath.toolchain, files, openaiMath.mathlibRevision);
}
const openaiCharacter = reviewedCharacterEnvironment();

/** Dependency choices are supplied by this runtime, never by task source or a caller URL. */
export function getLeanTaskEnvironment(id: LeanTaskEnvironment = 'standard'): LeanTaskEnvironmentConfig {
  if (id === 'standard') return standard;
  if (id === 'mathlib') return mathlib;
  if (id === 'mathlib-4.8') return mathlib48;
  if (id === 'openai-math') return openaiMath;
  if (id === 'openai-math-cartier-reviewed-v1') return openaiCartier;
  if (id === 'openai-math-character-reviewed-v1') return openaiCharacter;
  throw new Error('lean_task_environment_unavailable');
}
