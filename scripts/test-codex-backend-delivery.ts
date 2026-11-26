import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, type ServerResponse } from 'node:http';
import { buildSync } from 'esbuild';
import { bootstrapLeanTask } from '../src/math/leanTask';
import { mathBuildFile, mathBuildSource, MATH_BUILD_INPUTS, MATH_RUNTIME_BUNDLES } from '../src/math/mathBuildManifest';
import { canonicalMathJson, mathDigest, writeMathJsonDurable } from '../src/math/mathRuntimeIo';
import { readMathAgentSkill } from '../src/runtime/agentSkills';
import { confirmHarnessProcessStopped, type HarnessProcessIdentity } from '../src/runtime/harnessProcess';
import { admitResponsesRequest } from '../src/runtime/formalizationRelay';
import { prepareSub2apiProfile, SUB2API_PROVIDER } from '../src/runtime/sub2api';
import type { SolverRunState } from '../src/solver/archive';
import { readAgentTeamProofDelivery } from '../src/solver/agentTeamProof';
import { buildAgentTeamContributions } from '../src/solver/agentTeamContributions';
import { evaluateSolverProof } from '../src/solver/evaluation';
import { directSolverModules } from '../src/solver/modules';
import { git, readSolverProblem } from '../src/solver/problem';
import { runResearchWorkers } from '../src/solver/research';
import { prepareResearchSkill, researchSkillIdentity } from '../src/solver/researchSkill';

type Json = Record<string, any>;

// Freeze a disposable runtime exactly as the ordinary dispatch gate expects.
// The production runtime and independent Lean checker remain unmocked.
function freezeRuntime(repository: string, runtime: string) {
  fs.mkdirSync(runtime);
  for (const relative of [...MATH_BUILD_INPUTS, 'src', 'scripts', 'bin', 'resources', 'skills']) {
    const destination = path.join(runtime, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(path.join(repository, relative), destination, { recursive: true });
  }
  const bundleRoot = path.join(runtime, 'out/main');
  buildSync({ entryPoints: Object.fromEntries(['runMathProof', 'searchLean', 'checkLean', 'proofSearch']
    .map((name, index) => [MATH_RUNTIME_BUNDLES[index].replace(/\.js$/u, ''),
      path.join(runtime, 'scripts/mathematics', name + '.ts')])),
    outdir: bundleRoot, bundle: true, platform: 'node', format: 'cjs',
    nodePaths: [path.join(repository, 'node_modules')], loader: { '.py': 'text', '.lean': 'text' }, logLevel: 'silent' });
  const manifest = path.join(runtime, 'build-manifest.json'), now = new Date().toISOString();
  writeMathJsonDurable(manifest, { schema: 'deepscientist.math.build-manifest.v1', buildId: crypto.randomUUID(),
    startedAt: now, finishedAt: now, source: mathBuildSource(runtime), bundleRoot,
    bundles: MATH_RUNTIME_BUNDLES.map(name => mathBuildFile(path.join(bundleRoot, name))) });
  fs.chmodSync(manifest, 0o400);
  return manifest;
}

/** Offline provider, real Codex process, production team runtime and real Lean acceptance. */
export async function verifyNativeProofDelivery(input: { repository: string; executable: string; output: string; signal: AbortSignal }) {
  const temporaryRoot = process.env.TMPDIR ?? '/data/lzh/default-storage/tmp';
  fs.mkdirSync(temporaryRoot, { recursive: true }); fs.mkdirSync(input.output, { recursive: true });
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(temporaryRoot, 'native-proof-delivery-')));
  const requests: Json[] = [], events: Json[] = [], processes = new Map<string, HarnessProcessIdentity>();
  const result: Json = { status: 'running', paidModelCalls: 0 };
  const controller = new AbortController();
  const signal = AbortSignal.any([input.signal, controller.signal]);
  const originalFetch = globalThis.fetch;
  const leadProcesses: HarnessProcessIdentity[] = [];
  let state: SolverRunState | undefined, sequence = 0;
  const quote = (value: string) => "'" + value.replace(/'/gu, "'\\''") + "'";
  const call = (id: string, name: string, args: Json, namespace?: string) => ({
    type: 'function_call', id, call_id: id, ...(namespace ? { namespace } : {}), name,
    arguments: JSON.stringify(args), status: 'completed',
  });
  const message = (text: string) => ({ type: 'message', id: 'msg_proof_' + ++sequence, role: 'assistant',
    status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
  const until = async (predicate: () => boolean, response: ServerResponse) => {
    while (!predicate()) {
      signal.throwIfAborted();
      if (response.destroyed) return false;
      const failed = state?.agentTeam?.workers.find(worker => worker.tasks.some(task => task.status === 'failed'));
      if (failed) throw new Error('native-proof-member-failed:' + JSON.stringify(failed.tasks));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return true;
  };
  // A proof placeholder on its own unindented line is legal Lean source.
  const originalTarget = 'theorem original (n : Nat) : n + 0 = n ∧ True :=\nsorry\n';
  const consumerDraft = 'namespace NativeProof\n' + originalTarget.replace(':=\nsorry',
    ':= by\n  constructor\n  · exact helper n\n  · sorry') + 'end NativeProof\n';
  const sourceWithHelper = 'namespace NativeProof\n' +
    'theorem helper (n : Nat) : n + 0 = n := by rfl\n' +
    'theorem side (n : Nat) : n = n := by rfl\n' +
    originalTarget + 'end NativeProof\n';
  const finding = 'NativeProof.helper is saved in my owned file; the original target remains unfinished.';
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, '/v1/responses');
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      admitResponsesRequest(body, 'deepseek-flash', 'high'); requests.push(body);
      const text = body.input.filter((item: Json) => ['message', 'agent_message'].includes(item.type))
        .flatMap((item: Json) => item.content ?? []).map((part: Json) => part.text ?? part.encrypted_content ?? '').join('\n');
      const receipts = new Set(body.input.filter((item: Json) => item.type === 'function_call_output').map((item: Json) => item.call_id));
      const childRequest = text.includes('Current native task instructions');
      const declarations = [...(body.tools ?? []), ...body.input.filter((item: Json) => item.type === 'additional_tools')
        .flatMap((item: Json) => item.tools)].flatMap((tool: Json) => tool.type === 'namespace' ? tool.tools : [tool]);
      const host = declarations.find((tool: Json) => tool.name === 'theoremos_team');
      if (!childRequest) assert.doesNotMatch(host.description, /\bD\d{3}\b/u,
        'The shared Lead tool must not preselect a domain expert for unrelated assignments.');
      assert.deepEqual([...host.parameters.properties.operation.enum].sort(), (childRequest
        ? ['yield', 'history', 'inspect', 'inspect-research', 'submit']
        : ['finish', 'history', 'inspect', 'inspect-research', 'adopt']).sort(), 'Native host operations must stay limited to proof delivery and inspection.');
      assert.equal(body.tool_choice, 'auto', 'The host must not impose a collaboration decision.');
      if (!childRequest && JSON.stringify(body.input).includes(finding)) result.nativeFindingReceived = true;
      let items: Json[];
      if (childRequest) {
        assert.deepEqual(state!.agentTeam!.workers[0]!.tasks[0]!.profileEvidence?.loaded, ['prover']);
        assert.match(text, /### Lean Prover/u, 'The corrected specialty must reach the actual writer request.');
        for (const contradictoryHint of ['All agents share the same directory',
          'There are 4 available concurrency slots', 'You can spawn sub-agents to handle subtasks'])
          assert.equal(text.includes(contradictoryHint), false, 'Host role context must replace generic multi-agent hints.');
        result.childContextsChecked = (result.childContextsChecked ?? 0) + 1;
        if (!receipts.has('proof_child_write')) items = [call('proof_child_write', 'exec_command', { login: false,
          cmd: 'test -s .agents/skills/theoremos-research/SKILL.md && cat .agents/skills/theoremos-research/SKILL.md >/dev/null && printf %s ' + quote(sourceWithHelper) +
            ' > generated/problem/Submission.lean && printf %s ' + quote('One independent helper is ready for the Lead.\n') + ' > RESEARCH.md' })];
        else if (!receipts.has('proof_child_finding')) items = [call('proof_child_finding', 'send_message', {
          target: '/root', message: finding }, 'collaboration')];
        else if (!receipts.has('proof_child_submit')) {
          // Exercise the ordering from the real run: Lead writes the consumer while the member still owns the helper.
          if (!await until(() => fs.readFileSync(path.join(state!.worktree, 'generated/problem/Submission.lean'), 'utf8') === consumerDraft, response)) return;
          result.consumerDraftBeforeSubmit = true;
          items = [call('proof_child_submit', 'theoremos_team', {
            operation: 'submit', summary: 'Independent identity helper for the Lead.',
            declarations: [{ file: 'Submission.lean', name: 'NativeProof.helper', type: '∀ n : Nat, n + 0 = n' },
              { file: 'Submission.lean', name: 'NativeProof.side', type: '∀ n : Nat, n = n' }] })];
        }
        else items = [message('Helper submitted; release writing for independent checking.')];
      } else if (!receipts.has('proof_opening_read')) items = [call('proof_opening_read', 'exec_command', {
        login: false, cmd: 'cat generated/problem/Submission.lean' })];
      else if (!receipts.has('proof_bad_profile')) items = [call('proof_bad_profile', 'spawn_agent', {
        task_name: 'proof_writer', fork_turns: 'none', message: 'Profiles: prover (Lean prover, Mathlib).\nProve the helper.' }, 'collaboration')];
      else if (!receipts.has('proof_spawn')) {
        const rejection = body.input.find((item: Json) => item.type === 'function_call_output' && item.call_id === 'proof_bad_profile');
        assert.match(JSON.stringify(rejection.output), /math_team_profile_unresolved.*Profiles: prover/u,
          'The Lead must receive the rejected selection and the correction through the native tool.');
        assert.equal(state!.agentTeam!.workers.length, 0, 'A rejected dispatch must not occupy a team slot.');
        result.rejectedDispatchFeedback = rejection.output;
        items = [call('proof_spawn', 'spawn_agent', {
          task_name: 'proof_writer', fork_turns: 'none', message: 'Profiles: prover\nProve an independent NativeProof.helper (n : Nat) : n + 0 = n in your owned file. Lead consumes it in NativeProof.original. Report the first useful result and submit the helper; leave the original target unfinished.' }, 'collaboration')];
      }
      else if (!receipts.has('proof_draft')) items = [call('proof_draft', 'exec_command', { login: false,
        cmd: 'printf %s ' + quote(consumerDraft) + ' > generated/problem/Submission.lean && printf %s ' +
          quote('The first conjunct calls the agreed helper. Lead owns the remaining conjunct.\n') + ' > RESEARCH.md' })];
      else if (!receipts.has('proof_wait')) items = [call('proof_wait', 'wait_agent', { timeout_ms: 10000 }, 'collaboration')];
      else if (!receipts.has('proof_history')) {
        if (!await until(() => Boolean(state?.agentTeam?.deliveries.length), response)) return;
        items = [call('proof_history', 'theoremos_team', { operation: 'history' })];
      } else if (!receipts.has('proof_inspect')) items = [call('proof_inspect', 'theoremos_team', {
        operation: 'inspect', deliveryId: state!.agentTeam!.deliveries[0].id })];
      else if (!receipts.has('proof_adopt')) items = [call('proof_adopt', 'theoremos_team', {
        operation: 'adopt', deliveryId: state!.agentTeam!.deliveries[0].id })];
      else if (!receipts.has('proof_consume')) {
        assert.equal(state!.agentTeam!.adoptions[0].status, 'completed', 'Lead must resume only after host adoption');
        const adoptedEvent = state!.agentTeam!.events.find(event => event.kind === 'adopted')!;
        const adoptedMail = state!.agentTeam!.nativeControl!.mailbox.find(mail => mail.author === '/morpheus' &&
          mail.message?.kind === 'plaintext' &&
          mail.message.text === 'Mathematical host update (advisory):\n' + canonicalMathJson(adoptedEvent))!;
        assert.ok(adoptedMail, 'The host adoption event must enter the native mailbox.');
        assert.equal(adoptedMail.author, '/morpheus');
        assert.equal(adoptedMail.status, 'accepted', 'The resumed native Lead must receive its host adoption event.');
        result.adoptedHostMessage = { author: adoptedMail.author, status: adoptedMail.status,
          kind: adoptedEvent.kind, deliveryId: adoptedEvent.deliveryId };
        const adopted = fs.readFileSync(path.join(state!.worktree, 'generated/problem/Submission.lean'), 'utf8');
        assert.match(adopted, /theorem helper/u);
        assert.ok(adopted.includes(consumerDraft.slice('namespace NativeProof\n'.length)), 'Adoption must preserve the consumer proof drafted before submission.');
        items = [call('proof_consume', 'exec_command', { login: false,
          cmd: 'printf %s ' + quote(adopted.replace('  · sorry\n', '  · trivial\n')) +
            ' > generated/problem/Submission.lean && printf %s ' + quote('The original consumes the host-checked child helper.\n') + ' > RESEARCH.md' })];
      } else if (!receipts.has('proof_finish')) items = [call('proof_finish', 'theoremos_team', {
        operation: 'finish', summary: 'Original theorem saved using the adopted helper; ready for independent host acceptance.' })];
      else items = [message('Original proof is saved.')];
      const base = { id: 'resp_proof_' + ++sequence, object: 'response', created_at: 1,
        model: 'deepseek-flash', status: 'in_progress', output: [] };
      const emit = (value: Json) => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n');
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
      emit({ type: 'response.created', response: base });
      for (const [output_index, item] of items.entries()) {
        emit({ type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress',
          ...(item.type === 'function_call' ? { arguments: '' } : { content: [] }) } });
        if (item.type === 'function_call') {
          emit({ type: 'response.function_call_arguments.delta', item_id: item.id, output_index, delta: item.arguments });
          emit({ type: 'response.function_call_arguments.done', item_id: item.id, output_index, arguments: item.arguments });
        } else {
          emit({ type: 'response.output_text.delta', item_id: item.id, output_index, content_index: 0, delta: item.content[0].text });
          emit({ type: 'response.output_text.done', item_id: item.id, output_index, content_index: 0, text: item.content[0].text });
        }
        emit({ type: 'response.output_item.done', output_index, item });
      }
      emit({ type: 'response.completed', response: { ...base, status: 'completed', output: items,
        usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
      response.end();
    } catch (error) {
      result.providerFailure ??= String(error);
      if (!response.headersSent) response.writeHead(500);
      response.end('Offline proof fixture failed.');
      controller.abort(error);
    }
  });
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    // Keep the production sub2api profile and request gate. Only its upstream
    // network destination is replaced; no request can reach a real provider.
    const endpoint = `http://127.0.0.1:${(server.address() as any).port}/v1/responses`;
    globalThis.fetch = (async (resource, options) => {
      const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url;
      assert.equal(url, SUB2API_PROVIDER.baseUrl + '/responses', 'Only the fixed production relay endpoint may be requested.');
      result.relayRequests = (result.relayRequests ?? 0) + 1;
      return originalFetch(endpoint, options);
    }) as typeof fetch;
    const runtime = path.join(directory, 'runtime'), buildFile = freezeRuntime(input.repository, runtime);
    const receipt = bootstrapLeanTask(path.join(directory, 'primary'), { task: 'Prove the frozen original using one checked child helper.',
      source: 'namespace NativeProof\n' + originalTarget + 'end NativeProof\n' });
    const problem = readSolverProblem(receipt.workspaceRoot, receipt.activeProblemPath), worktree = path.join(directory, 'lead');
    git(receipt.workspaceRoot, ['worktree', 'add', '--quiet', '--detach', worktree, problem.baseCommit]);
    const identity = researchSkillIdentity(readMathAgentSkill(path.join(runtime, 'skills/theoremos-research/SKILL.md')));
    const skill = prepareResearchSkill(runtime, worktree, identity, problem);
    state = { schema: 'deepscientist.math.solver.v1', runId: 'offline-native-proof-delivery', phase: 'prepared', problem,
      worktree, model: 'deepseek-flash', effort: 'high', turns: 0, taskDigest: mathDigest('proof-fixture'), buildDigest: 'fixture',
      environmentDigest: mathDigest('native-proof-delivery'), evaluatorDigest: 'fixture', researchMode: 'skill',
      researchSkillWorkflow: 'full', researchSkill: identity, researchDelegation: { mode: 'team', maxAgents: 2 },
      agentTeam: { schema: 'theorem-os.agent-team.v1', transport: 'native-agent-control', workers: [],
        events: [], deliveries: [], adoptions: [], operations: [] } };
    const profile = path.join(directory, 'profile'); prepareSub2apiProfile(profile, state.model, state.effort);
    const toolchain = path.join(os.homedir(), '.elan/toolchains/leanprover--lean4---v4.33.0');
    assert.ok(fs.existsSync(path.join(toolchain, 'bin/lean')), 'Native delivery acceptance requires Lean 4.33.0.');
    const environment = { PATH: `${toolchain}/bin:${path.dirname(process.execPath)}:/usr/bin:/bin`,
      ELAN_HOME: path.join(os.homedir(), '.elan'), LEAN_PATH: '', LEAN_SYSROOT: '', NO_PROXY: '127.0.0.1,localhost',
      SUB2API_WESTLAKE_API_KEY: 'synthetic-offline-key', DEEPSCIENTIST_MATH_SANDBOX_BACKEND: 'bwrap',
      DEEPSCIENTIST_MATH_ENV_FILE: path.join(directory, 'missing.env') };
    const winner = await runResearchWorkers({ state, root: runtime, buildFile,
      taskText: 'Prove NativeProof.original by consuming one independently checked child declaration.',
      executable: input.executable, profile, modules: { ...directSolverModules, M1: { ...directSolverModules.M1,
        open: async options => {
          const session = await directSolverModules.M1.open(options);
          if (options.workspace === worktree && session.processIdentity) {
            const previous = leadProcesses.at(-1);
            if (previous) assert.equal(confirmHarnessProcessStopped(previous).status, 'stopped', 'Previous Lead writer must stop before reopening.');
            leadProcesses.push(session.processIdentity);
          }
          return session;
        } } }, signal, deadline: Infinity,
      maxTurns: Infinity, maxTurnMs: Infinity, maxTotalTokens: 0,
      workers: [{ id: 'solver', role: 'lead', worktree, ownedFiles: problem.ownedFiles }],
      access: new Map([['solver', { environment, researchSkill: skill, retrievalRoot: path.join(worktree, problem.projectRelative) }]]),
      save: () => {
        for (const current of [state!.writerProcess, ...(state!.agentTeam?.workers.map(worker => worker.writerProcess) ?? [])])
          if (current) processes.set(current.pid + ':' + current.startTime, current);
        writeMathJsonDurable(path.join(input.output, 'state.json'), state);
      }, emit: (event, details) => { events.push({ event, ...details }); } });
    assert.equal(result.providerFailure, undefined);
    assert.ok(result.childContextsChecked > 0);
    assert.equal(result.relayRequests, requests.length, 'Every upstream fixture request must cross the production relay.');
    const accounting = [state, ...state.agentTeam!.workers].map(record => record.requestUsageAccounting!);
    for (const record of accounting) {
      assert.ok(record, 'Each native writer must report production request accounting.');
      assert.equal(record.incomplete, false); assert.equal(record.pendingRequests, 0);
      assert.equal(record.reportedRequests, record.startedRequests);
    }
    assert.equal(accounting.reduce((total, record) => total + record.reportedRequests, 0), requests.length);
    assert.equal(winner?.check.passed, true, 'The original must pass independent production M2 checking.');
    assert.equal(winner.check.verification.status, 'kernel_verified');
    assert.deepEqual(winner.check.verification.results.map(item => item.theoremName), ['NativeProof.original']);
    assert.equal(state.agentTeam!.deliveries.length, 1);
    const reference = state.agentTeam!.deliveries[0], delivery = readAgentTeamProofDelivery(reference.path, state);
    assert.equal(delivery.artifacts[0].proof.verification.status, 'kernel_verified');
    assert.equal(delivery.declarations[0].name, 'NativeProof.helper');
    assert.equal(state.agentTeam!.adoptions[0].status, 'completed');
    assert.equal(result.nativeFindingReceived, true, 'The child finding must reach the Lead through the native mailbox.');
    assert.equal(state.agentTeam!.coordination, undefined, 'Native dispatch must not write an adapter coordination journal.');
    assert.deepEqual(events.filter(event => event.event.startsWith('team_coordination') || event.event === 'team_research_observed'), [],
      'Native collaboration must not create host coordination checkpoints.');
    assert.ok(leadProcesses.length >= 2, 'Adoption must stop the first writer and resume its saved native thread.');
    assert.equal(result.consumerDraftBeforeSubmit, true);
    fs.copyFileSync(path.join(worktree, 'generated/problem/Submission.lean'), path.join(input.output, 'Submission.lean'));
    writeMathJsonDurable(path.join(input.output, 'delivery.json'), delivery);
    writeMathJsonDurable(path.join(input.output, 'original-check.json'), winner.check);
    assert.ok(state.agentTeam!.leadExposures?.some(exposure => exposure.kind === 'inspected' && exposure.deliveryId === reference.id));
    assert.ok(state.agentTeam!.leadExposures?.some(exposure => exposure.kind === 'adopted' && exposure.deliveryId === reference.id));
    assert.equal(git(receipt.workspaceRoot, ['rev-parse', 'HEAD']), problem.baseCommit, 'Research must not publish into the original workspace.');
    const evaluation = await evaluateSolverProof(problem, winner.check, environment, signal,
      { timeoutMs: Infinity, teamContributions: true });
    assert.equal(evaluation.status, 'passed');
    const contributions = buildAgentTeamContributions(state, evaluation);
    assert.ok(contributions);
    assert.deepEqual(contributions.advisoryMessages.map(item => ({ from: item.from, to: item.to, text: item.text })),
      [{ from: '/root/proof_writer', to: '/root', text: finding }],
      'Only member messages should be reported here; the host delivery notice is separate.');
    for (const [name, relation] of [['NativeProof.helper', 'direct'], ['NativeProof.side', 'not-referenced']]) {
      const declaration = contributions.declarations.find(item => item.deliveryId === reference.id && item.name === name);
      assert.ok(declaration?.targets.some(target => target.name === 'NativeProof.original' && target.relation === relation),
        'Expected ' + relation + ' evidence for ' + name);
    }
    writeMathJsonDurable(path.join(input.output, 'final-contributions.json'), contributions);
    result.status = 'passed'; result.requests = requests.length;
    result.usageComplete = state.tokenBudget?.usageComplete;
    result.deliveryId = reference.id; result.adoption = state.agentTeam!.adoptions[0];
    result.leadWriterProcesses = leadProcesses;
    result.originalCheck = { passed: winner.check.passed, status: winner.check.verification.status,
      commit: winner.check.commit, declarations: winner.check.verification.results.map(item => item.theoremName) };
    result.checks = ['production-relay', 'minimal-native-host-operations', 'native-role-context', 'pinned-skill-read',
      'native-spawn', 'native-source-write', 'native-finding-message', 'native-wait', 'submit', 'writer-stop', 'adopted-host-mail',
      'independent-helper-check', 'inspect', 'adopt', 'native-source-consumption', 'independent-original-check',
      'final-s3-check', 'final-uses-one-of-two-adopted-declarations'];
    return result;
  } catch (error) {
    result.status = 'failed'; result.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
    result.processes = [...processes.values()].map(identity => ({ ...identity, stop: confirmHarnessProcessStopped(identity) }));
    if (result.processes.some((process: Json) => process.stop.status !== 'stopped')) result.status = 'failed';
    writeMathJsonDurable(path.join(input.output, 'verification.json'), result);
    writeMathJsonDurable(path.join(input.output, 'trace.json'), { requests, events });
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
    assert.equal(result.processes.some((process: Json) => process.stop.status !== 'stopped'), false, 'All native writers must stop.');
  }
}
