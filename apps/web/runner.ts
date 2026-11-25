import type { WorkerFormalizationAuditInput } from './formalizationAuditTypes';
import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WebConfig } from './config';
import type { WorkerExplanationInput, WorkerExplanationMessage, WorkerInput, WorkerMessage } from './shared';
import { webArtifactMaxBytes, webExplanationPhases, webExplanationReason, webFailureKinds, webFailureReason, webPaperLimits } from './shared';
import { isWebEventDetails } from './moduleTelemetry';
import { explanationCheckpointSchema, maxExplanationMessageBytes } from './explanationCheckpoint';
import { isWebAgentActionBody } from './agentActions';
import { isWebFormalizationActivityBody } from './formalizationActivityValidation';
import type { WebEventDetails } from './shared';
import type { WebCommand, WebCommandResult, WebObservation } from './collaboration';
import type { WebPrecheckOutput, WebPrecheckRunner } from './precheck';
import { candidateTargetQuery, candidateTargetWasChecked } from './candidateTargetCheck';
import { webDeclarationArtifactsSchema } from './declarationArtifacts';
import { ExecutionDeadline } from '../../src/runtime/executionDeadline';
import { allowedKnowledgeFile, validateTheoremKnowledge } from '../../src/solver/theoremKnowledge';
import { MAX_LIBRARY_PACK_BYTES, MAX_LIBRARY_PACK_MODULES, MAX_LIBRARY_MODULE_BYTES, parseLibraryPack } from '../../src/math/libraryPacks';
import { mathConstructionImports } from '../../src/math/mathConstructionSources';
import { formalizationAuditResultSchema } from '../../src/math/formalizationAudit';
import { webFormalizationPhases, webFormalizationReason, type WorkerFormalizationInput,
  type WorkerFormalizationMessage, type WorkerFormalizationAuditMessage } from './formalizationTypes';
import { mathDigest, readMathText } from '../../src/math/mathRuntimeIo';
import { webProofJournalDirectory, webProofJournalFiles } from './proofJournal';
import { webWorkerDisconnectGraceMs, webWorkerHeartbeatMs, webWorkerShutdownMs } from './workerDisconnect';
import { hydrateObservation, maxWorkerObservationBytes, type CompactWebObservation } from './observationSources';

export type WebRunner = {
  readiness(): Promise<{ ready: boolean; message: string; nativeTeam?: boolean; nativeTeamPreferences?: boolean; nativeTeamExpertCards?: boolean }>;
  run(input: WorkerInput, onMessage: (message: WorkerMessage) => void, signal: AbortSignal): Promise<void>;
  command?(id: string, command: WebCommand): Promise<WebCommandResult>;
  /** Compiles a statement on its own, without a model or a workspace; absent when the service cannot. */
  check?: WebPrecheckRunner;
  /** Writes and audits a proof explanation in its own container; absent when the service cannot. */
  explain?(input: WorkerExplanationInput, onMessage: (message: WorkerExplanationMessage) => void, signal: AbortSignal): Promise<void>;
  /** Produces a frozen compiled statement; confirmation belongs to the workbench. */
  formalize?(input: WorkerFormalizationInput, onMessage: (message: WorkerFormalizationMessage) => void, signal: AbortSignal): Promise<void>;
  /** Reviews an already available statement in a separate background container. */
  auditFormalization?(input: WorkerFormalizationAuditInput, onMessage: (message: WorkerFormalizationAuditMessage) => void, signal: AbortSignal): Promise<void>;
  /** Compiles the two files of a saved paper draft in a disposable TeX container. */
  compilePaper?(input: WebPaperCompileInput, signal: AbortSignal): Promise<WebPaperCompileOutput>;
};
export type WebPaperCompileInput = { template: string; main: string };
export type WebPaperCompileOutput = { pdf: Buffer };
export class WebPaperCompileError extends Error {
  constructor(readonly code: string, readonly detail?: string, readonly file?: string, readonly line?: number) {
    super(code);
  }
}
const execute = promisify(execFile);
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
/**
 * The worker image's own code and build state. A statement check needs only Lean and the prebuilt Mathlib, and its
 * `#eval` can read any file it sees and throw the text back as an error the editor shows, so these are covered.
 */
export const webPrivateImagePaths = ['/opt/theorem-os', '/opt/runtime-state'] as const;
/** Inspect only a projection emitted by the worker, never accept arbitrary checkpoint objects. */
export function isWebObservation(value: unknown): value is WebObservation {
  if (!object(value) || value.schema !== 'theorem-os.web-observation.v1' ||
      value.evidence !== 'recorded-not-replayed' || value.acceptance !== 'not-assessed' ||
      typeof value.webRunId !== 'string' || typeof value.solverRunId !== 'string' ||
      typeof value.observedAt !== 'string' || !Number.isFinite(Date.parse(value.observedAt)) ||
      !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
      !object(value.inspection) || !object(value.snapshot) ||
      value.snapshot.runId !== value.solverRunId || value.inspection.runId !== value.solverRunId ||
      !/^[a-f0-9]{64}$/u.test(String(value.snapshot.stateDigest)) ||
      !Array.isArray(value.inspection.tasks) || !Array.isArray(value.inspection.workers) ||
      !Array.isArray(value.sources) || !Array.isArray(value.checks) || !Array.isArray(value.guidance) ||
      !object(value.coverage) || value.declarations !== undefined && !webDeclarationArtifactsSchema.safeParse(value.declarations).success) return false;
  const team = value.inspection.nativeTeam;
  if (team !== undefined && (!object(team) || team.schema !== 'theorem-os.web-native-team.v1' || team.runId !== value.solverRunId ||
      team.transport !== undefined && team.transport !== 'native-agent-control' && team.transport !== 'host-tools' ||
      !Array.isArray(team.tasks) || !Array.isArray(team.findings) || !Array.isArray(team.deliveries) || !Array.isArray(team.adoptions))) return false;
  const configuration = value.inspection.configuration;
  if (object(configuration)) {
    if (configuration.agentHarness !== undefined && !z.object({ id: z.enum(['codex', 'claude-code', 'opencode', 'cli']),
      executableDigest: z.string().regex(/^[a-f0-9]{64}$/u), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/u) }).strict().safeParse(configuration.agentHarness).success) return false;
    if (configuration.researchMode !== undefined && configuration.researchMode !== 'legacy' && configuration.researchMode !== 'skill') return false;
    if (configuration.researchMode === 'skill' && !z.object({ name: z.string().min(1), digest: z.string().regex(/^[a-f0-9]{64}$/u),
      loading: z.enum(['native', 'file']) }).strict().safeParse(configuration.researchSkill).success) return false;
  }
  return value.sources.every(source => object(source) && source.scope === 'owned-file' &&
    ['taskId', 'taskVersion', 'commit', 'sourceDigest', 'environmentDigest', 'file', 'source'].every(field => typeof source[field] === 'string') &&
    (source.dependencySources === undefined || Array.isArray(source.dependencySources) &&
      source.dependencySources.every(entry => object(entry) && typeof entry.file === 'string' && typeof entry.source === 'string'))) &&
    value.checks.every(check => object(check) && object(check.record) &&
      ['id', 'taskId', 'taskVersion', 'commit', 'sourceDigest', 'environmentDigest'].every(field => typeof check[field] === 'string'));
}
const libraryRestartSchema = z.object({ previousSolverRunId: z.string().min(1).max(128),
  solverRunId: z.string().min(1).max(128), round: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const workerMessageSchema = z.discriminatedUnion('type', [
  libraryRestartSchema.extend({ type: z.literal('library_restart') }),
  z.object({ type: z.literal('progress'), event: z.string().min(1).max(100), message: z.string().max(2_000),
    details: z.custom<WebEventDetails>(isWebEventDetails).optional() }).strict(),
  z.object({ type: z.literal('error'), message: z.string().min(1).max(2_000),
    failure: z.object({ kind: z.enum(webFailureKinds), reason: z.string().regex(webFailureReason).optional() }).strict().optional() }).strict(),
  z.object({ type: z.literal('artifact'), artifact: z.object({
    source: z.string().min(1).max(webArtifactMaxBytes).refine(value => Buffer.byteLength(value) <= webArtifactMaxBytes),
    workerId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    capturedAt: z.string().datetime(), status: z.literal('candidate'),
  }).strict() }).strict(),
  z.object({ type: z.literal('result'), result: z.object({ status: z.string().min(1).max(100),
    proof: z.string().max(128 * 1024), report: z.record(z.unknown()) }).strict() }).strict(),
]);

type ObservationStream = { runId: string; sources: Map<string, string> };

function readWorkerObservation(observation: unknown, supplied: unknown, stream?: ObservationStream): WebObservation | undefined {
  if (!object(observation) || stream && observation.webRunId !== stream.runId) return;
  if (supplied === undefined) return isWebObservation(observation) ? observation : undefined;
  if (!object(supplied)) return;
  const current = new Map<string, string>();
  let bytes = 0;
  const hydrated = hydrateObservation(observation as CompactWebObservation, digest => {
    const cached = current.get(digest);
    if (cached !== undefined) return cached;
    let source: string | undefined;
    if (Object.hasOwn(supplied, digest)) {
      const text = supplied[digest];
      if (typeof text !== 'string' || mathDigest(text) !== digest) throw new Error('web_observation_invalid_source_blob');
      source = text;
    } else source = stream?.sources.get(digest);
    if (source !== undefined) {
      bytes += Buffer.byteLength(source);
      if (bytes > maxWorkerObservationBytes) throw new Error('web_observation_too_large');
      current.set(digest, source);
    }
    return source;
  });
  if (!isWebObservation(hydrated)) return;
  if (stream) stream.sources = current;
  return hydrated;
}

export function parseWorkerMessage(line: string, stream?: ObservationStream): WorkerMessage | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (object(value) && value.type === 'observation') {
      if (Object.keys(value).length !== (Object.hasOwn(value, 'sourceBlobs') ? 3 : 2)) return;
      const observation = readWorkerObservation(value.observation, value.sourceBlobs, stream);
      if (observation) return { type: 'observation', observation };
      return;
    }
    if (object(value) && value.type === 'catalog' && Object.keys(value).length === 2)
      return { type: 'catalog', catalog: validateTheoremKnowledge(value.catalog) };
    if (object(value) && value.type === 'action')
      return Object.keys(value).length === 2 && isWebAgentActionBody(value.action) ? { type: 'action', action: value.action } : undefined;
    const message = workerMessageSchema.safeParse(value);
    return message.success ? message.data as WorkerMessage : undefined;
  } catch { return undefined; }
}

/** Docker can copy a volume from a stopped container. Read before removing the worker. */
async function readProofJournal(container: string, webRunId: string, signal: AbortSignal): Promise<WorkerMessage[]> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'theoremos-proof-journal-'));
  const journal = path.join(directory, 'journal');
  try {
    await execute('docker', ['cp', `${container}:${webProofJournalDirectory}`, journal],
      { signal, timeout: 15_000, maxBuffer: 8_192 });
    const events: WorkerMessage[] = [];
    for (const file of webProofJournalFiles) {
      try {
        const packet: unknown = JSON.parse(readMathText(path.join(journal, file), 16 * 1024 * 1024 + 4096));
        if (!object(packet) || packet.webRunId !== webRunId || !Array.isArray(packet.messages)) continue;
        for (const raw of packet.messages) {
          const message = parseWorkerMessage(JSON.stringify(raw), { runId: webRunId, sources: new Map() });
          if (message) events.push(message);
        }
      } catch { /* Missing or interrupted checkpoint writes do not invalidate an available terminal receipt. */ }
    }
    return events;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const count = z.number().int().nonnegative().max(1e12);
const explanationMessageSchema = z.union([
  z.object({ type: z.literal('progress'), progress: z.object({ phase: z.enum(webExplanationPhases), batches: count.optional(),
    approvedBatches: count.optional(), round: count.optional(), tokens: count.optional(), modelRequestFailures: count.optional() }).strict() }).strict(),
  // The server re-derives every check from the evidence; here it only has to be an object.
  z.object({ type: z.literal('result'), status: z.literal('approved'), evidence: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('result'), status: z.enum(['exhausted', 'error']), reason: z.string().regex(webExplanationReason),
    checkpoint: explanationCheckpointSchema.optional() }).strict(),
]);
export function parseExplanationMessage(line: string): WorkerExplanationMessage | undefined {
  try {
    const message = explanationMessageSchema.safeParse(JSON.parse(line));
    return message.success ? message.data as WorkerExplanationMessage : undefined;
  } catch { return undefined; }
}

const formalizationMessageSchema = z.union([
  z.object({ type: z.literal('compiled'), candidate: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('progress'), progress: z.object({ phase: z.enum(webFormalizationPhases),
    round: count.optional(), tokens: count.optional() }).strict() }).strict(),
  z.object({ type: z.literal('activity'), activity: z.custom(isWebFormalizationActivityBody) }).strict(),
  z.object({ type: z.literal('result'), status: z.literal('approved'), evidence: z.record(z.unknown()) }).strict(),
  z.object({ type: z.literal('result'), status: z.enum(['exhausted', 'error']), reason: z.string().regex(webFormalizationReason) }).strict(),
  z.object({ type: z.literal('audit-progress'), tokens: count }).strict(),
  z.object({ type: z.literal('audit-result'), result: formalizationAuditResultSchema }).strict(),
  z.object({ type: z.literal('audit-error'), reason: z.string().regex(webFormalizationReason) }).strict(),
]);
export function parseFormalizationMessage(line: string): WorkerFormalizationMessage | WorkerFormalizationAuditMessage | undefined {
  try {
    const message = formalizationMessageSchema.safeParse(JSON.parse(line));
    return message.success ? message.data as WorkerFormalizationMessage | WorkerFormalizationAuditMessage : undefined;
  } catch { return undefined; }
}

export class DockerWebRunner implements WebRunner {
  private cached?: { at: number; result: Awaited<ReturnType<WebRunner['readiness']>>; workerControl: boolean };
  private active = new Set<string>();
  constructor(private readonly config: Pick<WebConfig, 'workerImage'> & Partial<Pick<WebConfig, 'texImage'>>) {}

  /**
   * Compile only the saved template and body. The TeX image is separate from the Lean worker and the container has no
   * network, no shell escape, a read-only image and bounded writable tmpfs mounts.
   */
  compilePaper: WebRunner['compilePaper'] = async ({ template, main }, signal) => {
    signal.throwIfAborted();
    if (Buffer.byteLength(template) + Buffer.byteLength(main) > webPaperLimits.maxSourceBytes)
      throw new WebPaperCompileError('paper_pdf_source_too_large');
    const image = this.config.texImage || 'theorem-os-tex:local';
    const name = `theoremos-paper-${crypto.randomUUID()}`;
    const script = [
      'set -eu',
      "python3 -c 'import json,pathlib,sys; p=json.load(sys.stdin); pathlib.Path(\"/work/template.tex\").write_text(p[\"template\"],encoding=\"utf-8\"); pathlib.Path(\"/work/main.tex\").write_text(p[\"main\"],encoding=\"utf-8\")'",
      'if latexmk -pdfxe -xelatex -no-shell-escape -interaction=nonstopmode -halt-on-error -file-line-error -outdir=/work /work/template.tex >/work/latexmk.log 2>&1; then',
      "python3 -c 'import base64,json,pathlib; p=pathlib.Path(\"/work/template.pdf\"); print(json.dumps({\"ok\":True,\"pdf\":base64.b64encode(p.read_bytes()).decode(\"ascii\")}))'",
      'else',
      "python3 -c 'import json,pathlib; p=pathlib.Path(\"/work/latexmk.log\"); print(json.dumps({\"ok\":False,\"log\":p.read_text(encoding=\"utf-8\",errors=\"replace\")[-65536:]}))'",
      'fi',
    ].join('\n');
    const remove = () => execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name, '--network=none', '--log-driver=none',
        '--read-only', '--user', '10001:10001', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=2', '--memory=1g', '--memory-swap=1g',
        '--pids-limit=128', '--ulimit', 'nofile=1024:1024', '--env', 'HOME=/tmp',
        '--tmpfs', '/work:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=268435456,mode=1777', '--entrypoint', 'sh', image, '-c', script],
        { timeout: 30_000, maxBuffer: 8_192 });
    } catch { await remove(); throw new WebPaperCompileError('paper_pdf_container_failed'); }
    try {
      signal.throwIfAborted();
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let text = '', settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { child.kill('SIGKILL'); reject(error); } else resolve(text);
        };
        const abort = () => finish(new WebPaperCompileError('paper_pdf_cancelled'));
        const timer = setTimeout(() => finish(new WebPaperCompileError('paper_pdf_timeout')), webPaperLimits.maxRunSeconds * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          text += chunk;
          if (Buffer.byteLength(text) > webPaperLimits.maxPdfBytes * 2) finish(new WebPaperCompileError('paper_pdf_output_too_large'));
        });
        child.stdin.on('error', () => {});
        child.once('error', () => finish(new WebPaperCompileError('paper_pdf_container_failed')));
        child.once('close', code => finish(code ? new WebPaperCompileError('paper_pdf_compile_failed') : undefined));
        child.stdin.end(JSON.stringify({ template, main }));
      });
      let packet: unknown;
      try { packet = JSON.parse(output.trim()); } catch { throw new WebPaperCompileError('paper_pdf_invalid_output'); }
      if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new WebPaperCompileError('paper_pdf_invalid_output');
      const result = packet as { ok?: unknown; pdf?: unknown; log?: unknown };
      if (result.ok !== true || typeof result.pdf !== 'string') {
        const log = typeof result.log === 'string' ? result.log.slice(-webPaperLimits.maxLogBytes).replaceAll('\r', '') : undefined;
        const match = log?.match(/(?:^|\n)([^\n:]{1,256}):(\d+):/u);
        const detail = log?.match(/(?:^|\n)(?:!\s*|(?:LaTeX|Package)[^\n]*Error:\s*)([^\n]{1,240})/u)?.[1]?.trim();
        throw new WebPaperCompileError('paper_pdf_compile_failed', detail, match?.[1], match ? Number(match[2]) : undefined);
      }
      let pdf: Buffer;
      try { pdf = Buffer.from(result.pdf, 'base64'); } catch { throw new WebPaperCompileError('paper_pdf_invalid_output'); }
      if (!pdf.length || pdf.length > webPaperLimits.maxPdfBytes || pdf.subarray(0, 5).toString() !== '%PDF-')
        throw new WebPaperCompileError('paper_pdf_missing_output');
      return { pdf };
    } finally { await remove(); }
  };

  async command(id: string, command: WebCommand): Promise<WebCommandResult> {
    if (!this.active.has(id)) throw new Error('运行环境尚未就绪或已结束。');
    return new Promise((resolve, reject) => {
      const child = spawn('docker', ['exec', '--interactive', `theoremos-web-${id}`,
        'bun', 'apps/web/worker-command.ts', '--observation-source-refs'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let output = '', settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) { child.kill('SIGKILL'); reject(error); return; }
        try {
          const value: unknown = JSON.parse(output);
          if (!object(value) || typeof value.id !== 'string' || typeof value.status !== 'string') throw new Error();
          const { observation, sourceBlobs, libraryRestart: transition, ...receipt } = value;
          const observed = observation === undefined ? undefined
            : readWorkerObservation(observation, sourceBlobs, { runId: id, sources: new Map() });
          if (observation !== undefined && !observed) throw new Error();
          const libraryRestart = transition === undefined ? undefined : libraryRestartSchema.parse(transition);
          if (libraryRestart && (command.type !== 'capture' || observed?.solverRunId !== libraryRestart.solverRunId)) throw new Error();
          if (receipt.catalog) validateTheoremKnowledge(receipt.catalog);
          resolve({ ...receipt, ...(observed ? { observation: observed } : {}),
            ...(libraryRestart ? { libraryRestart } : {}) } as WebCommandResult);
        } catch { reject(new Error('运行环境未返回有效命令回执。')); }
      };
      const timer = setTimeout(() => finish(new Error('命令回执超时，请先查询当前回执再重试。')), 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        output += chunk;
        if (Buffer.byteLength(output) > 32 * 1024 * 1024) finish(new Error('命令回执超出传输限制。'));
      });
      child.once('error', () => finish(new Error('无法向运行环境投递命令。')));
      child.once('close', code => finish(code ? new Error('运行环境拒绝了命令。') : undefined));
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(command) + '\n');
    });
  }

  /**
   * Compiles the statement as one file in a throwaway container: no network, no workspace, read-only image, a few
   * seconds of CPU. The source travels over stdin. Mathlib checks read the image's prebuilt packages directly.
   */
  check: WebPrecheckRunner = async ({ environment, source, libraryPack, sourceFile = 'Submission.lean', dependencySources = [], candidateTarget }, signal) => {
    signal.throwIfAborted();
    const name = `theoremos-check-${crypto.randomUUID()}`;
    const mathlib = environment === 'mathlib';
    const memory = mathlib ? '6g' : '2g';
    // A pack is validated before any of its paths reach the container. Compile dependencies first,
    // then the submitted source, under the same pinned environment as an ordinary statement check.
    const pack = libraryPack && parseLibraryPack(libraryPack);
    if (pack?.requires?.length) throw new Error('math_library_pack_external_requirements_unavailable');
    const packed = (pack?.modules ?? []) as { file: string; source: string }[];
    const validFile = (file: string) => file.length <= 512 && allowedKnowledgeFile(file) && file.endsWith('.lean') && file !== 'lakefile.lean';
    if (!validFile(sourceFile)) throw new Error('web_check_source_path_invalid');
    const modules = new Map<string, { file: string; source: string }>();
    let bytes = 0;
    for (const item of [...packed, ...dependencySources]) {
      if (!validFile(item.file) || item.file === sourceFile) throw new Error('web_check_dependency_path_invalid');
      const name = item.file.slice(0, -5).replaceAll('/', '.'), previous = modules.get(name);
      if (previous) {
        if (previous.source !== item.source) throw new Error('web_check_dependency_conflict');
        continue;
      }
      bytes += Buffer.byteLength(item.source);
      if (modules.size >= MAX_LIBRARY_PACK_MODULES || Buffer.byteLength(item.source) > MAX_LIBRARY_MODULE_BYTES || bytes > MAX_LIBRARY_PACK_BYTES)
        throw new Error('web_check_dependencies_too_large');
      if (item.source.includes('\0') || Buffer.from(item.source).toString('utf8') !== item.source) throw new Error('web_check_dependency_source_invalid');
      modules.set(name, item);
    }
    const ordered: { file: string; source: string }[] = [], visited = new Set<string>(), visiting = new Set<string>();
    const visit = (name: string) => {
      if (visited.has(name)) return;
      if (visiting.has(name) || name === sourceFile.slice(0, -5).replaceAll('/', '.')) throw new Error('web_check_dependency_cycle');
      const item = modules.get(name);
      if (!item) return;
      visiting.add(name);
      for (const dependency of mathConstructionImports(item.source)) visit(dependency);
      visiting.delete(name); visited.add(name); ordered.push(item);
    };
    // Published packs are checked in full. Mutable owned files are only compiled when this candidate imports them.
    for (const item of packed) visit(item.file.slice(0, -5).replaceAll('/', '.'));
    for (const name of mathConstructionImports(source)) visit(name);
    const marker = candidateTarget && `THEOREMOS_CANDIDATE_TARGET_${crypto.randomBytes(16).toString('hex')}`;
    const query = candidateTarget && candidateTargetQuery(sourceFile.slice(0, -5).replaceAll('/', '.'), source, candidateTarget, marker!);
    const queryFile = query && `TheoremOSCandidateCheck${crypto.randomBytes(16).toString('hex')}.lean`;
    const withFiles = Boolean(pack || dependencySources.length || sourceFile !== 'Submission.lean' || candidateTarget);
    const compilePack = `const fs=require("node:fs"); const p=JSON.parse(await Bun.stdin.text());
      process.chdir("/tmp");
      for(const m of p.modules){fs.mkdirSync(require("node:path").dirname(m.file),{recursive:true});fs.writeFileSync(m.file,m.source);
        const r=Bun.spawnSync(["lean","--json","-o",m.file.slice(0,-5)+".olean",m.file],{stdout:"inherit",stderr:"inherit"});if(r.exitCode!==0)process.exit(r.exitCode??1);}
      fs.mkdirSync(require("node:path").dirname(p.sourceFile),{recursive:true});fs.writeFileSync(p.sourceFile,p.source);
      const args=["lean","--json",...(p.query?["-o",p.sourceFile.slice(0,-5)+".olean"]:[]),p.sourceFile];
      const checked=Bun.spawnSync(args,{stdout:"inherit",stderr:"inherit"});if(checked.exitCode!==0)process.exit(checked.exitCode??1);
      if(p.query){fs.writeFileSync(p.queryFile,p.query);
        process.exit(Bun.spawnSync(["lean","--json",p.queryFile],{stdout:"inherit",stderr:"inherit"}).exitCode??1);}`;
    const pathSetup = mathlib
      ? 'LP=/opt/theoremos-library/.lake/build/lib/lean; for d in /opt/theoremos-mathlib/.lake/packages/*/.lake/build/lib/lean; do LP="$LP:$d"; done; LEAN_PATH="$LP" '
      : '';
    const script = withFiles
      ? (mathlib ? pathSetup.replace('LEAN_PATH="$LP" ', 'export LEAN_PATH="/tmp:$LP"; ') : 'export LEAN_PATH=/tmp; ')
        + "exec bun -e '" + compilePack + "'"
      : 'cat > /tmp/Submission.lean && ' + pathSetup + 'exec lean --json /tmp/Submission.lean';
    const remove = () => execute('docker', ['rm', '--force', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name, '--network=none', '--log-driver=none',
        '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`,
        '--pids-limit=128', '--ulimit', 'nofile=1024:1024', '--tmpfs', `/tmp:rw,noexec,nosuid,nodev,size=${withFiles ? 134217728 : 16777216},mode=1777`,
        ...webPrivateImagePaths.flatMap(hidden => ['--tmpfs', `${hidden}:ro,noexec,nosuid,nodev,size=4096,mode=0555`]),
        '--entrypoint', 'sh', this.config.workerImage, '-c', script], { timeout: 30_000, maxBuffer: 8_192 });
    } catch (error) { await remove(); throw error; }
    try {
      signal.throwIfAborted();
      return await new Promise<WebPrecheckOutput>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let output = '', timedOut = false, settled = false;
        const finish = (result?: WebPrecheckOutput, error?: unknown) => {
          if (settled) return;
          settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (result) resolve(result); else reject(error);
        };
        const abort = () => { child.kill('SIGKILL'); finish(undefined, signal.reason); };
        const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, (mathlib ? 90 : 30) * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          output += chunk;
          // `#eval` can print without bound; what came before the limit still describes the statement.
          if (output.length > 1024 * 1024) child.kill('SIGKILL');
        });
        child.stdin.on('error', () => {});
        child.once('error', error => finish(undefined, error));
        child.once('close', code => finish({ output, exitCode: code, timedOut,
          ...(candidateTarget && code === 0 && !timedOut && candidateTargetWasChecked(output, marker!) ? { checkedTarget: candidateTarget.name } : {}) }));
        child.stdin.end(withFiles ? JSON.stringify({ source, sourceFile, modules: ordered, ...(query ? { query, queryFile } : {}) }) : source);
      });
    } finally { await remove(); }
  };

  async readiness() {
    if (this.cached && Date.now() - this.cached.at < 10_000) return this.cached.result;
    const metadata = await execute('docker', ['image', 'inspect', '--format', '{{index .Config.Labels "org.theoremos.native-agent-control"}}|{{index .Config.Labels "org.theoremos.team-profile-preferences"}}|{{index .Config.Labels "org.theoremos.team-expert-cards"}}|{{index .Config.Labels "org.theoremos.worker-control"}}',
      this.config.workerImage], { timeout: 5_000, maxBuffer: 4096 }).catch(() => undefined);
    const ready = Boolean(metadata);
    const [team, preferences, expertCards, workerControl] = metadata?.stdout.trim().split('|') ?? [];
    const result = { ready, nativeTeam: team === 'v1', nativeTeamPreferences: team === 'v1' && preferences === 'v1',
      nativeTeamExpertCards: team === 'v1' && expertCards === 'v1',
      message: ready ? '运行环境就绪' : '运行镜像尚未就绪，请先构建 theorem-os-worker 镜像。' };
    this.cached = { at: Date.now(), result, workerControl: workerControl === 'v1' };
    return result;
  }

  async run(input: WorkerInput, onMessage: (message: WorkerMessage) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = `theoremos-web-${input.id}`;
    const environment = input.input.environment ?? 'standard';
    const mathlib = environment === 'mathlib';
    const memory = mathlib ? '8g' : '4g';
    const workerControl = this.cached?.workerControl === true;
    let cleanup: Promise<void> | undefined;
    const remove = () => cleanup ??= execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 })
      .then(() => {}, () => { cleanup = undefined; });
    const args = ['create', '--interactive', '--pull=never', '--name', name,
      '--add-host=host.docker.internal:host-gateway',
      '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
      '--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined',
      '--security-opt=systempaths=unconfined',
      '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`, '--pids-limit=256',
      '--tmpfs', '/work:rw,nosuid,nodev,size=536870912,uid=10001,gid=10001,mode=0700',
      '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
      '--ulimit', 'nofile=1024:1024',
      '--mount', `type=volume,destination=${webProofJournalDirectory}`,
      '--env', `THEOREMOS_WORKER_JOURNAL=${webProofJournalDirectory}`,
      ...(workerControl ? ['--env', 'THEOREMOS_WORKER_CONTROL=1'] : []),
      ...(mathlib ? ['--device=/dev/fuse:/dev/fuse:rw', '--mount', 'type=volume,destination=/var/tmp']
        : ['--tmpfs', '/var/tmp:rw,nosuid,nodev,size=536870912,uid=10001,gid=10001,mode=0700']),
      this.config.workerImage, environment];
    // Create first so cancellation always has a known container to remove.
    try {
      await execute('docker', args, { timeout: 30_000, maxBuffer: 8_192 });
    } catch {
      await remove();
      throw new Error('无法创建隔离运行环境，请检查 Docker 与 worker 镜像。');
    }
    if (signal.aborted) {
      await remove();
      signal.throwIfAborted();
    }
    try { await new Promise<void>((resolve, reject) => {
      const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
      this.active.add(input.id);
      let buffer = '', finished = false, receivedResult = false;
      let workerError: Error | undefined;
      let observedSequence = 0, libraryRound = 0, artifactAt = '';
      const observationStream = { runId: input.id, sources: new Map<string, string>() };
      let recovery: AbortController | undefined;
      let stopping: Promise<void> | undefined;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      const stop = () => stopping ??= (async () => {
        clearInterval(heartbeat);
        recovery?.abort();
        // Capture the actual saved checkpoint and source evidence before deleting the container.
        try {
          const captured = await this.command(input.id, { type: 'capture' });
          if (captured.libraryRestart) forward({ type: 'library_restart', ...captured.libraryRestart });
          if (captured.observation) forward({ type: 'observation', observation: captured.observation });
          if (captured.catalog) forward({ type: 'catalog', catalog: captured.catalog });
        } catch { /* A run cancelled during bootstrap may not have a checkpoint yet. */ }
        await remove();
        child.kill('SIGKILL');
      })();
      const abort = () => { void stop(); };
      const watchdog = new ExecutionDeadline(input.input.maxRunSeconds === 0 ? Number.POSITIVE_INFINITY
        : (input.input.maxRunSeconds + (mathlib ? 600 : 0) + 240) * 1_000, abort);
      signal.addEventListener('abort', abort, { once: true });
      const finish = async (error?: Error) => {
        if (finished) return;
        finished = true; clearInterval(heartbeat); watchdog.stop(); signal.removeEventListener('abort', abort);
        if (error || signal.aborted) await stop();
        await stopping;
        if (error) reject(error); else resolve();
      };
      const forward = (message: WorkerMessage) => {
        if (input.input.planApproval && message.type === 'progress') {
          if (message.event === 'plan_approval_wait_started') watchdog.setWaiting(true);
          else if (message.event === 'plan_approval_wait_ended') watchdog.setWaiting(false);
        }
        if (message.type === 'result') receivedResult = true;
        if (message.type === 'error') workerError = new Error(message.message);
        if (message.type === 'library_restart') {
          if (message.round <= libraryRound) return;
          libraryRound = message.round;
        }
        if (message.type === 'observation') {
          if (message.observation.webRunId !== input.id || message.observation.sequence <= observedSequence) return;
          observedSequence = message.observation.sequence;
        }
        if (message.type === 'artifact') {
          if (message.artifact.capturedAt <= artifactAt) return;
          artifactAt = message.artifact.capturedAt;
        }
        onMessage(message);
      };
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) { void finish(new Error('运行输出超出限制。')); return; }
        for (;;) {
          const newline = buffer.indexOf('\n');
          if (newline < 0) break;
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          const message = parseWorkerMessage(line, observationStream);
          if (message) forward(message);
        }
      });
      child.stdin.on('error', () => {});
      child.once('error', () => { void finish(new Error('无法启动隔离运行环境。')); });
      child.once('close', () => {
        clearInterval(heartbeat);
        if (finished) return;
        if (signal.aborted || receivedResult) { void finish(); return; }
        if (workerError) { void finish(workerError); return; }
        const missingResult = new Error('运行环境已退出，未返回验收结果。');
        if (stopping) { void finish(missingResult); return; }
        recovery = new AbortController();
        const recoverySignal = recovery.signal;
        void (async () => {
          try {
            // Losing Docker's attach process says nothing about the solver's lifetime.
            await execute('docker', ['wait', name], { signal: recoverySignal, maxBuffer: 8_192,
              timeout: webWorkerDisconnectGraceMs + webWorkerShutdownMs + 10_000 });
            for (const message of await readProofJournal(name, input.id, recoverySignal)) {
              if (signal.aborted || stopping) break;
              forward(message);
            }
            await finish(signal.aborted || receivedResult ? undefined : workerError ?? missingResult);
          } catch { await finish(signal.aborted ? undefined : missingResult); }
        })();
      });
      // Credentials travel over the private input pipe, never Docker args, env or logs.
      const request = JSON.stringify({ ...input, observationSourceRefs: true }) + '\n';
      if (workerControl) {
        child.stdin.write(request);
        heartbeat = setInterval(() => {
          if (child.stdin.writable && !child.stdin.writableNeedDrain) child.stdin.write('\n');
        }, webWorkerHeartbeatMs);
      } else child.stdin.end(request);
      if (signal.aborted) abort();
    }); } finally {
      this.active.delete(input.id);
      await remove();
    }
  }

  /**
   * One container per explanation, built like a run: the proof and key travel over stdin, model calls go to the host
   * gateway, and the disk volume holds the pinned environment while roles compile. Errors are reason codes only.
   */
  async explain(input: WorkerExplanationInput, onMessage: (message: WorkerExplanationMessage) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = `theoremos-explain-${input.id}`, mathlib = input.environment === 'mathlib';
    const memory = mathlib ? '12g' : '4g';
    const remove = () => execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name,
        '--add-host=host.docker.internal:host-gateway',
        '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined', '--security-opt=systempaths=unconfined',
        '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`, '--pids-limit=512',
        '--tmpfs', '/work:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
        '--ulimit', 'nofile=4096:4096', '--mount', 'type=volume,destination=/var/tmp',
        ...(mathlib ? ['--device=/dev/fuse:/dev/fuse:rw'] : []),
        this.config.workerImage, input.environment, 'explain'], { timeout: 30_000, maxBuffer: 8_192 });
    } catch { await remove(); throw new Error('explanation_container_failed'); }
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let buffer = '', finished = false, received = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { child.kill('SIGKILL'); reject(error); } else resolve();
        };
        const abort = () => finish(new Error('explanation_cancelled'));
        const timer = input.maxRunSeconds === 0 ? undefined
          : setTimeout(() => finish(new Error('explanation_timeout')), (input.maxRunSeconds + (mathlib ? 1_200 : 600)) * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          if (finished) return;
          buffer += chunk;
          for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const line = buffer.slice(0, newline);
            if (Buffer.byteLength(line) > maxExplanationMessageBytes) return finish(new Error('explanation_output_too_large'));
            const message = parseExplanationMessage(line);
            buffer = buffer.slice(newline + 1);
            if (message?.type === 'result') received = true;
            if (message && !finished) onMessage(message);
          }
          if (buffer.length > maxExplanationMessageBytes) finish(new Error('explanation_output_too_large'));
        });
        child.stdin.on('error', () => {});
        child.once('error', () => finish(new Error('explanation_container_failed')));
        child.once('close', () => finish(received ? undefined : new Error('explanation_worker_exited')));
        // Credentials travel over the private input pipe, never Docker args, env or logs.
        child.stdin.end(JSON.stringify(input) + '\n');
      });
    } finally { await remove(); }
  }

  /** Foreground generation and background review have separate container lifetimes. */
  async formalize(input: WorkerFormalizationInput, onMessage: (message: WorkerFormalizationMessage) => void, signal: AbortSignal): Promise<void> {
    return this.formalizationContainer(input, message => {
      if (message.type === 'progress' || message.type === 'activity' || message.type === 'result') onMessage(message);
    }, signal);
  }
  async auditFormalization(input: WorkerFormalizationAuditInput, onMessage: (message: WorkerFormalizationAuditMessage) => void, signal: AbortSignal): Promise<void> {
    return this.formalizationContainer(input, message => {
      if (message.type === 'audit-progress' || message.type === 'audit-result' || message.type === 'audit-error') onMessage(message);
    }, signal);
  }
  private async formalizationContainer(input: WorkerFormalizationInput | WorkerFormalizationAuditInput,
    onMessage: (message: WorkerFormalizationMessage | WorkerFormalizationAuditMessage) => void, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const name = `theoremos-formalize-${'operation' in input ? 'audit-' : ''}${input.id}`, mathlib = input.environment === 'mathlib';
    const memory = mathlib ? '12g' : '4g';
    const remove = () => execute('docker', ['rm', '--force', '--volumes', name], { timeout: 15_000 }).then(() => {}, () => {});
    try {
      await execute('docker', ['create', '--interactive', '--pull=never', '--name', name,
        '--add-host=host.docker.internal:host-gateway',
        '--log-driver=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
        '--security-opt=seccomp=unconfined', '--security-opt=apparmor=unconfined', '--security-opt=systempaths=unconfined',
        '--cpus=2', `--memory=${memory}`, `--memory-swap=${memory}`, '--pids-limit=512',
        '--tmpfs', '/work:rw,nosuid,nodev,size=67108864,uid=10001,gid=10001,mode=0700',
        '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=134217728,mode=1777',
        '--ulimit', 'nofile=4096:4096', '--mount', 'type=volume,destination=/var/tmp',
        ...(mathlib ? ['--device=/dev/fuse:/dev/fuse:rw'] : []),
        this.config.workerImage, input.environment, 'formalize'], { timeout: 30_000, maxBuffer: 8_192 });
    } catch { await remove(); throw new Error('formalization_container_failed'); }
    try {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const child = spawn('docker', ['start', '--attach', '--interactive', name], { stdio: ['pipe', 'pipe', 'ignore'] });
        let buffer = '', finished = false, received = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
          if (error) { child.kill('SIGKILL'); reject(error); } else resolve();
        };
        const abort = () => finish(new Error('formalization_cancelled'));
        const timer = input.maxRunSeconds === 0 ? undefined
          : setTimeout(() => finish(new Error('formalization_timeout')), (input.maxRunSeconds + (mathlib ? 1_200 : 600)) * 1_000);
        signal.addEventListener('abort', abort, { once: true });
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          buffer += chunk;
          for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
            const message = parseFormalizationMessage(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            if ('operation' in input ? message?.type === 'audit-result' || message?.type === 'audit-error'
              : message?.type === 'result') received = true;
            if (message && !finished) onMessage(message);
          }
          if (buffer.length > 32 * 1024 * 1024) finish(new Error('formalization_output_too_large'));
        });
        child.stdin.on('error', () => {});
        child.once('error', () => finish(new Error('formalization_container_failed')));
        child.once('close', () => finish(received ? undefined : new Error('formalization_worker_exited')));
        // Credentials travel over the private input pipe, never Docker args, env or logs.
        child.stdin.end(JSON.stringify(input) + '\n');
      });
    } finally { await remove(); }
  }
}
