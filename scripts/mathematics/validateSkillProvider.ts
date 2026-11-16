#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createCodexMathSession, type MathAgentSession } from '../../src/runtime/codexSession';
import type { ModelRequestGate, ModelRequestReceipt } from '../../src/runtime/modelRequest';
import { readMathAgentSkill } from '../../src/runtime/codexSkills';
import { mathDigest, writeMathJsonDurable } from '../../src/math/mathRuntimeIo';
import { prepareResearchSkill, researchSkillIdentity } from '../../src/solver/researchSkill';

type Json = Record<string, unknown>;
type CommandObservation = { loading: string; phase: string; turnId?: string; id?: unknown;
  command: unknown; status?: unknown; exitCode?: unknown; output: string };

/** Explicit, bounded capability acceptance. This is never imported by the solver or ordinary tests. */
export async function validateSkillProvider(args: string[]) {
  const { values } = parseArgs({ args, options: {
    directory: { type: 'string' }, profile: { type: 'string' }, codex: { type: 'string', default: 'codex' },
    model: { type: 'string', default: 'deepseek-flash' }, effort: { type: 'string', default: 'high' },
    loading: { type: 'string', default: 'both' }, 'max-requests': { type: 'string', default: '12' },
    'max-total-tokens': { type: 'string', default: '60000' }, 'turn-timeout-seconds': { type: 'string', default: '300' },
    'request-token-reserve': { type: 'string', default: '12000' },
    compact: { type: 'boolean', default: false }, help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('Usage: bun scripts/mathematics/validateSkillProvider.ts --directory NEW_PRIVATE_DIR --profile EXISTING_PROFILE [--codex BIN] [--model MODEL --effort EFFORT] [--loading native|file|both] [--compact] [--max-requests 12 --max-total-tokens 60000 --request-token-reserve 12000 --turn-timeout-seconds 300]\nRuns real provider requests only when explicitly invoked. Never reads or copies credentials. Separate native/file research workspaces and actual tool readbacks are retained with usage and stopping evidence. Admission reserves the larger of the configured estimate and largest observed request; provider consumption is known after settlement, so this is not a hard cap on in-flight tokens.');
    return 0;
  }
  if (!values.directory || !values.profile || !['native', 'file', 'both'].includes(values.loading!))
    throw new Error('skill_provider_validation_arguments_invalid');
  const maxRequests = Number(values['max-requests']), maxTokens = Number(values['max-total-tokens']);
  const requestTokenReserve = Number(values['request-token-reserve']);
  const timeoutMs = Number(values['turn-timeout-seconds']) * 1000;
  if (![maxRequests, maxTokens, requestTokenReserve, timeoutMs].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error('skill_provider_validation_limits_invalid');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const directory = path.resolve(values.directory);
  if (fs.existsSync(directory)) throw new Error('skill_provider_validation_directory_exists');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const profile = fs.realpathSync(values.profile);
  const commands: CommandObservation[] = [], usage: { request: number; loading?: string; phase?: string;
    requestId?: string; receipt: ModelRequestReceipt }[] = [];
  const nativeUsage: Json[] = [], results: Json[] = [];
  const runtimeFiles = ['src/runtime/codexSession.ts', 'src/runtime/codexSkills.ts', 'src/solver/researchSkill.ts'];
  const runtimeIdentity = Object.fromEntries(runtimeFiles.map(file => [file, mathDigest(fs.readFileSync(path.join(root, file)))]));
  let requests = 0, knownTokens = 0, usageIncomplete = false, largestObservedRequestTokens = 0, reservedTokens = 0;
  let active: { loading?: string; phase?: string } = {};
  const gate: ModelRequestGate = identity => {
    if (usageIncomplete) return { allowed: false, reason: 'math_model_usage_unavailable' };
    const reservation = Math.max(requestTokenReserve, largestObservedRequestTokens);
    if (requests >= maxRequests || maxTokens - knownTokens - reservedTokens < reservation)
      return { allowed: false, reason: 'math_total_token_limit' };
    const request = ++requests;
    reservedTokens += reservation;
    const scope = { ...active, ...(identity?.requestId ? { requestId: identity.requestId } : {}) };
    save();
    let settled = false;
    return { allowed: true, settle: receipt => {
      if (settled) return;
      settled = true; reservedTokens -= reservation;
      usage.push({ request, ...scope, receipt });
      knownTokens += receipt.usage?.totalTokens ?? 0;
      largestObservedRequestTokens = Math.max(largestObservedRequestTokens, receipt.usage?.totalTokens ?? 0);
      if (!receipt.complete || !receipt.usage) usageIncomplete = true;
      save();
    } };
  };
  const save = () => writeMathJsonDurable(path.join(directory, 'report.json'), {
    checkedAt: new Date().toISOString(), runtimeIdentity,
    runtimeFilesStillCurrent: runtimeFiles.every(file => runtimeIdentity[file] === mathDigest(fs.readFileSync(path.join(root, file)))),
    provider: { profile, model: values.model, effort: values.effort },
    limits: { maxRequests, maxTotalTokens: maxTokens, requestTokenReserve, turnTimeoutMs: timeoutMs,
      enforcement: 'observed-request-admission-with-reserve', inFlightTokensHardCapped: false },
    accounting: { requests, knownTokens, reservedTokens, remainingTokens: maxTokens - knownTokens,
      largestObservedRequestTokens, overrunTokens: Math.max(0, knownTokens - maxTokens),
      usageIncomplete, usage, nativeUsageIsObservational: true, nativeUsage },
    originalProblemAcceptance: 'not-assessed', actualToolEvidence: commands, results,
    passed: !usageIncomplete && reservedTokens === 0 &&
      results.length === (values.loading === 'both' ? 2 : 1) && results.every(result => result.passed === true),
  });
  for (const loading of values.loading === 'both' ? ['native', 'file'] as const : [values.loading as 'native' | 'file']) {
    const workspace = path.join(directory, loading, 'workspace'); fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const source = readMathAgentSkill(path.join(root, 'skills/theoremos-research/SKILL.md'), loading);
    const skill = prepareResearchSkill(root, workspace, researchSkillIdentity(source));
    const reference = path.join(path.dirname(skill.path), 'references/continuation.md');
    const skillHash = mathDigest(fs.readFileSync(skill.path)), referenceBytes = fs.readFileSync(reference, 'utf8');
    const referenceHash = mathDigest(referenceBytes), tag = crypto.randomUUID();
    let session: MathAgentSession | undefined, threadId: string | undefined, phase = 'initial';
    const result: Json = { loading, skillDigest: skill.digest, workspace, passed: false };
    const output = (name: string) => path.join(workspace, '.scratch', name + '.json');
    const readbackCommand = (name: string, previous: boolean) => `/usr/bin/python3 - <<'PY'\n`
      + 'import hashlib,json,re\nfrom pathlib import Path\n'
      + `skill=Path(${JSON.stringify(skill.path)}).read_bytes()\n`
      + `reference=Path(${JSON.stringify(reference)}).read_bytes()\n`
      + 'value={"skillName":re.search(r"(?m)^name:\\s*(.+)$",skill.decode()).group(1),'
      + '"skillSha256":hashlib.sha256(skill).hexdigest(),"referenceSha256":hashlib.sha256(reference).hexdigest(),'
      + '"referenceQuote":next(line for line in reference.decode().splitlines() if len(line)>=40 and not line.startswith("#"))}\n'
      + (previous ? `value["previousTag"]=json.loads(Path(${JSON.stringify(output('initial'))}).read_text())["tag"]\n`
        : `value["tag"]=${JSON.stringify(tag)}\n`)
      + `Path(${JSON.stringify(output(name))}).write_text(json.dumps(value,ensure_ascii=False)+"\\n")\n`
      + 'print(json.dumps(value,ensure_ascii=False))\nPY';
    const verify = (name: string, requirePrevious: boolean) => {
      const value = JSON.parse(fs.readFileSync(output(name), 'utf8')) as Json;
      if (value.skillName !== skill.name || value.skillSha256 !== skillHash || value.referenceSha256 !== referenceHash ||
          typeof value.referenceQuote !== 'string' || value.referenceQuote.length < 40 || !referenceBytes.includes(value.referenceQuote) ||
          (requirePrevious ? value.previousTag !== tag : value.tag !== tag))
        throw new Error('skill_provider_validation_readback_invalid:' + name);
      const own = commands.filter(item => item.loading === loading && item.phase === phase && item.exitCode === 0);
      const commandText = own.map(item => JSON.stringify(item.command)).join('\n');
      if (!commandText.includes('SKILL.md') || !commandText.includes('continuation.md') ||
          requirePrevious && !commandText.includes('initial.json'))
        throw new Error('skill_provider_validation_missing_actual_read_tool:' + name);
      return value;
    };
    const create = () => createCodexMathSession({ executable: values.codex!, profile, workspace,
      model: values.model!, effort: values.effort!, skills: [skill], ...(threadId ? { threadId } : {}),
      turnTimeoutMs: timeoutMs, requestGate: gate, hiddenRoots: [profile,
        path.join(process.env.HOME || '/home/lzh', '.codex/auth.json'),
        path.join(process.env.HOME || '/home/lzh', '.codex/config.toml')],
      instructions: 'This is a bounded capability acceptance in a disposable workspace. Read the specified frozen skill and continuation reference with actual shell tools. Do not research a mathematics problem, access any other directory, use the network or delegate. Keep tool calls brief. Use exec_command with login:false and omit justification and sandbox_permissions. After writing the requested JSON, stop.',
      onUsage: observed => { nativeUsage.push({ loading, phase, observed }); save(); },
      onItem: (event, item, context) => {
        if (event !== 'completed' || item.type !== 'commandExecution') return;
        commands.push({ loading, phase, turnId: context?.turnId, id: item.id, command: item.command,
          status: item.status, exitCode: item.exitCode,
          output: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput.slice(0, 12_000) : '' });
        save();
      } });
    try {
      active = { loading, phase };
      session = await create(); threadId = session.threadId; result.threadId = threadId;
      const first = 'Run this single shell command with exec_command and login:false, then return a short completion. '
        + 'The command reads the frozen skill and reference, computes their actual hashes and writes a disposable capability receipt. '
        + 'Do not invoke other tools.\n' + readbackCommand('initial', false);
      if (await session.run(first, crypto.randomUUID(), workspace, () => {}) !== 'completed')
        throw new Error('skill_provider_validation_initial_turn_failed:' + session.lastError);
      result.initial = verify('initial', false);
      result.initialStop = await session.stopForFreeze?.(); session = undefined;
      if ((result.initialStop as Json | undefined)?.status !== 'stopped') throw new Error('skill_provider_validation_stop_unconfirmed');
      phase = 'resumed'; active = { loading, phase }; session = await create();
      if (session.threadId !== threadId) throw new Error('skill_provider_validation_resume_thread_changed');
      if (values.compact) {
        if (!session.compact) throw new Error('skill_provider_validation_compaction_unsupported');
        active = { loading, phase: 'compaction' };
        await session.compact(); result.compactionCompleted = true;
      }
      active = { loading, phase };
      const second = 'Continue the same saved thread after reopening the native process. '
        + 'Run this single shell command with exec_command and login:false to reread the skill, reference and prior receipt. '
        + 'Do not invoke other tools; return a short completion after it succeeds.\n' + readbackCommand('resumed', true);
      if (await session.run(second, crypto.randomUUID(), workspace, () => {}) !== 'completed')
        throw new Error('skill_provider_validation_resumed_turn_failed:' + session.lastError);
      result.resumed = verify('resumed', true);
      result.resumedStop = await session.stopForFreeze?.(); session = undefined;
      if ((result.resumedStop as Json | undefined)?.status !== 'stopped') throw new Error('skill_provider_validation_stop_unconfirmed');
      result.passed = true;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
    } finally {
      await session?.close(); results.push(result); save();
    }
    if (usageIncomplete || requests >= maxRequests || knownTokens >= maxTokens) break;
  }
  save();
  const passed = !usageIncomplete && reservedTokens === 0 &&
    results.length === (values.loading === 'both' ? 2 : 1) && results.every(result => result.passed === true);
  console.log(JSON.stringify({ report: path.join(directory, 'report.json'), passed, requests, knownTokens, usageIncomplete }));
  return passed ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await validateSkillProvider(process.argv.slice(2));
