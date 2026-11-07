import fs from 'node:fs';
import path from 'node:path';
import type { MathAgentOptions, MathAgentSession } from '../../src/runtime/codexSession';
import type { elaborateFormalization } from '../../src/solver/formalizationElaboration';
import { createAgentPathMask, isWebAgentActionBody, sanitizeAgentItem } from './agentActions';
import { webFormalizationActivityLimits as limits, webFormalizationRoles, type WebFormalizationActivityBody, type WebFormalizationRole,
  type WebFormalizationRoleSummary, type WebFormalizationStep } from './formalizationTypes';
import type { WebAgentActionBody, WebAgentLeanCheck } from './shared';

type Item = Record<string, unknown>;
type Elaborate = typeof elaborateFormalization;
type Event = { event: string; round: number; role?: WebFormalizationRole; error?: string };
const object = (value: unknown): Item | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : undefined;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
function clip(value: string, limit: number) {
  return value.length <= limit ? { text: value, clipped: false } : { text: `${value.slice(0, limit - 1)}…`, clipped: true };
}
/** A host error's code: `formalization_role_incomplete:failed:…` reads as its first word. */
const code = (value: string | undefined) => /^[a-z0-9_]{1,100}/u.exec(value ?? '')?.[0];
// `NAME=value` for credentials, whichever way a command printed them (env, a config file, a shell trace).
const secretAssignment = /\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|CAPABILITY|AUTH)[A-Z0-9_]*)(\s*[=:]\s*)("?)[^\s"']{4,}\3/gu;
const bearer = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gu;
const withoutSecrets = (value: string) => value.replace(secretAssignment, '$1$2[REDACTED]').replace(bearer, '$1[REDACTED]');

/**
 * Where a role's session works: `round-02-<id>/compare-reviewer-1` or a retry beside it. The lane id stays the same
 * across retries, so one role reads as one row.
 */
export function formalizationSlot(directory: string, workspace: string) {
  const relative = path.relative(directory, workspace).split(path.sep).join('/');
  const match = /^round-(\d{1,4})-[^/]+\/(?:retry-[^/]+\/)?([A-Za-z0-9_-]{1,60})$/u.exec(relative);
  if (!match) return undefined;
  const round = Number(match[1]), slot = match[2]!;
  const role: WebFormalizationRole | undefined = /^plan(?:-\d+)?$/u.test(slot) ? 'plan' : slot.startsWith('compare') ? 'compare' :
    (webFormalizationRoles as readonly string[]).includes(slot) ? slot as WebFormalizationRole : undefined;
  return role && round > 0 ? { round, slot, role, workerId: `r${round}-${slot}`.slice(0, 64) } : undefined;
}

/** `file:line:col: error: message` as Lean wrote it; columns read from 0 as check-lean reports them. */
export function formalizationLeanFailure(message: string): WebAgentLeanCheck | undefined {
  const detail = message.replace(/^formalization_elaboration_failed:\s*/u, '').replace(/\nElaboration diagnostics:[\s\S]*$/u, '');
  const match = /^([^\n:]+):(\d+):(\d+): (error|warning|info)(?:\([^)\n]*\))?: ([\s\S]+)$/u.exec(detail);
  if (!match || path.basename(match[1]!) !== 'Formalization.lean') return;
  return { passed: false, messages: [{ severity: match[4] as 'error' | 'warning' | 'info', line: Number(match[2]),
    column: Math.max(0, Number(match[3]) - 1), text: clip(match[5]!.trim(), 600).text }] };
}

/** What a role's OUTPUT.json says, cut to what its reader checks; undefined when it wrote nothing readable. */
export function formalizationRoleSummary(role: WebFormalizationRole, output: unknown, mask: (value: string) => string):
  WebFormalizationRoleSummary | undefined {
  const value = object(output);
  if (!value) return;
  const shown = (text: unknown, limit: number = limits.summaryItem) => typeof text === 'string' && text.trim() ? clip(mask(text).trim(), limit).text : undefined;
  const sections: WebFormalizationRoleSummary['sections'] = [];
  const section = (kind: WebFormalizationRoleSummary['sections'][number]['kind'], entries: unknown, read: (entry: unknown) => string | undefined) => {
    const all = (Array.isArray(entries) ? entries : []).map(read).filter((entry): entry is string => !!entry);
    if (all.length) sections.push({ kind, items: all.slice(0, limits.summaryItems),
      ...(all.length > limits.summaryItems ? { omitted: all.length - limits.summaryItems } : {}) });
  };
  const field = (name: string) => (entry: unknown) => shown(object(entry)?.[name]);
  const verdict = ['approved', 'changes_requested', 'unknown'].includes(value.verdict as string) ? value.verdict as WebFormalizationRoleSummary['verdict'] : undefined;
  let text: string | undefined;
  if (role === 'plan') {
    section('conclusions', value.conclusions, field('mathematics'));
    section('assumptions', value.assumptions, field('mathematics'));
    section('definitions', value.definitions, field('mathematics'));
    section('unresolved', value.unresolved, field('description'));
  } else if (role === 'generate') {
    section('targets', value.coverage, entry => {
      const item = object(entry), names = Array.isArray(item?.targetNames) ? item.targetNames.filter(name => typeof name === 'string') : [];
      const original = shown(item?.originalText, 300);
      return original && names.length ? clip(`${names.join(', ')} ← ${original}`, limits.summaryItem).text : undefined;
    });
    section('assumptions', value.assumptions, shown);
    text = shown(value.assumptionsExplanation, limits.summaryText);
  } else if (role === 'backtranslate') {
    text = shown(value.mathematics, limits.summaryText);
    section('targets', value.targets, entry => {
      const item = object(entry), name = string(item?.name), mathematics = shown(item?.mathematics);
      return name && mathematics ? clip(`${name}: ${mathematics}`, limits.summaryItem).text : undefined;
    });
    section('assumptions', value.assumptions, shown);
    section('definitions', value.definitions, shown);
  } else {
    text = shown(value.summary, limits.summaryText);
    // A structured review names its discrepancies as correspondences; the older review lists issues.
    const correspondences = Array.isArray(value.correspondences) ? value.correspondences : undefined;
    section('issues', correspondences ? correspondences.filter(entry => ['mismatch', 'unresolved'].includes(object(entry)?.relation as string)) : value.issues,
      entry => {
        const item = object(entry);
        if (!item) return shown(entry);
        const explanation = shown(item.explanation, 400), fragment = shown(item.candidateFragment, 160);
        return explanation ? clip(fragment ? `${fragment}: ${explanation}` : explanation, limits.summaryItem).text : undefined;
      });
  }
  if (!text && !sections.length && !verdict) return;
  const taskKind = role === 'plan' && ['prove', 'decision', 'construction'].includes(value.taskKind as string) ? value.taskKind as string : undefined;
  return { ...(verdict ? { verdict } : {}), ...(taskKind ? { taskKind } : {}), ...(text ? { text } : {}), sections };
}

// The role protocol (ROLE.md, OUTPUT.schema.json) is TheoremOS's own; an Agent that prints it shows nothing of it.
const protocolFile = /\b(?:ROLE\.md|OUTPUT\.schema\.json)\b/u;
const listingOnly = /^\s*(?:ls|stat|wc|test|file)\b[^|;&]*$/u;
function protocolLines(instructions: string, schema: string | undefined) {
  const lines = new Set(instructions.split('\n').map(line => line.trim()).filter(line => line.length >= 40));
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    const entry = object(value);
    if (!entry) return;
    for (const [key, field] of Object.entries(entry)) {
      if (['description', '$comment', 'title'].includes(key) && typeof field === 'string')
        for (const line of field.split('\n')) if (line.trim().length >= 40) lines.add(line.trim());
      walk(field);
    }
  };
  try { if (schema) walk(JSON.parse(schema)); } catch { /* An unreadable schema has no lines to hide. */ }
  return [...lines];
}
function withoutProtocol(action: WebAgentActionBody, lines: readonly string[]): WebAgentActionBody {
  const quoted = (value: string | undefined) => !!value && lines.some(line => value.includes(line));
  const hide = (value: string) => lines.reduce((text, line) => text.includes(line) ? text.replaceAll(line, '…') : text, value);
  if (action.kind === 'command' && (quoted(action.output) || (action.command && protocolFile.test(action.command) && !listingOnly.test(action.command)))) {
    const { output: _output, outputClipped: _clipped, lean: _lean, found: _found, ...rest } = action;
    return { ...rest, withheld: true };
  }
  return { ...action, ...(action.text ? { text: hide(action.text) } : {}),
    ...(action.changes ? { changes: action.changes.map(change => change.diff ? { ...change, diff: hide(change.diff) } : change) } : {}) };
}
const readText = (file: string, limit: number) => {
  try { const stat = fs.statSync(file); return stat.isFile() && stat.size <= limit ? fs.readFileSync(file, 'utf8') : undefined; } catch { return; }
};
const readJson = (file: string) => { try { return JSON.parse(readText(file, 2_000_000) ?? '') as unknown; } catch { return; } };

/**
 * What a web formalization did, step by step, for its owner: each role's session actions and what it handed in, each
 * Lean compilation and its error, the host's feedback between rounds. Paths read relative to the role's workspace,
 * host directories as "…", the key and credentials as [REDACTED]; the role protocol is withheld.
 */
export function createFormalizationActivity(context: { scratch: string; directory: string; root: string; apiKey: string;
  send: (activity: WebFormalizationActivityBody) => void;
  /** Exact strings never shown, such as the provider's address. */ redact?: readonly string[] }) {
  const scratch = path.resolve(context.scratch), redact = [context.apiKey, ...(context.redact ?? [])].filter(value => value.length >= 8);
  // The role sandbox mounts its workspace at /workspace; /profile holds its relay configuration.
  const sandboxHidden = ['/profile', '/run/model.sock', '/opt/formalization', '/opt/codex'];
  const pathMask = createAgentPathMask({ workerId: 'formalization', worktree: '/workspace', hidden: [...sandboxHidden, path.resolve(context.root)] });
  // Host errors quote the scratch run directory; it reads as "…" without withholding what quotes it.
  const plain = (value: string) => withoutSecrets(redact.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value)
    .replaceAll(path.resolve(context.directory), '…').replaceAll(scratch, '…'));
  const masked = (value: string) => pathMask(plain(value)).text;
  const emit = (step: WebFormalizationStep) => { try { context.send({ type: 'step', step }); } catch { /* Observation never changes the run. */ } };
  let round = 1, sessions = 0, lastRevision: string | undefined;
  const plansShown = new Set<string>();
  const deep = <T>(value: T): T => typeof value === 'string' ? plain(value) as T : Array.isArray(value) ? value.map(deep) as T :
    object(value) ? Object.fromEntries(Object.entries(value as Item).map(([key, field]) => [key, deep(field)])) as T : value;

  const openSession = (inner: (options: MathAgentOptions) => Promise<MathAgentSession>) => async (options: MathAgentOptions) => {
    const slot = formalizationSlot(context.directory, options.workspace);
    if (!slot) return inner(options);
    const session = ++sessions;
    round = Math.max(round, slot.round);
    const attempt = /^plan-(\d+)$/u.exec(slot.slot);
    // A second plan follows the host's rejection of the first, which plan-failure-N.json records.
    if (attempt && Number(attempt[1]) > 1 && !plansShown.has(`${slot.round}-${attempt[1]}`)) {
      plansShown.add(`${slot.round}-${attempt[1]}`);
      const roundDirectory = path.join(context.directory, path.relative(context.directory, options.workspace).split(path.sep)[0]!);
      const error = string(object(readJson(path.join(roundDirectory, `plan-failure-${Number(attempt[1]) - 1}.json`)))?.error);
      if (error) { const text = clip(masked(error), limits.feedback);
        emit({ round: slot.round, step: 'revision', stage: 'plan', text: text.text, ...(text.clipped ? { textClipped: true } : {}) }); }
    }
    const lines = protocolLines(options.instructions, readText(path.join(options.workspace, 'OUTPUT.schema.json'), 1_000_000));
    const lane = { round: slot.round, step: 'role' as const, workerId: slot.workerId, role: slot.role, slot: slot.slot };
    let settled = false;
    const finish = (state: 'finished' | 'failed', extra: { summary?: WebFormalizationRoleSummary; reason?: string } = {}) => {
      if (settled) return;
      settled = true; emit({ ...lane, state, ...extra });
    };
    emit({ ...lane, state: 'started' });
    const onItem = (phase: 'started' | 'completed', item: Item) => {
      options.onItem?.(phase, item);
      const action = sanitizeAgentItem(phase, deep({ ...item, id: typeof item.id === 'string' ? `${session}:${item.id}` : item.id }),
        { workerId: slot.workerId, worktree: '/workspace', hidden: sandboxHidden });
      const shown = action && withoutProtocol(action, lines);
      if (shown && isWebAgentActionBody(shown)) try { context.send({ type: 'action', action: shown }); } catch { /* As above. */ }
    };
    let opened: MathAgentSession;
    try { opened = await inner({ ...options, onItem }); }
    catch (cause) { finish('failed', { reason: code(cause instanceof Error ? cause.message : undefined) ?? 'formalization_failed' }); throw cause; }
    const run = opened.run;
    opened.run = async (...args) => {
      try {
        const status = await run(...args);
        if (status === 'completed' || status === 'submitted') {
          const summary = formalizationRoleSummary(slot.role, readJson(path.join(options.workspace, 'OUTPUT.json')), masked);
          finish('finished', summary ? { summary } : {});
        } else finish('failed', { reason: code(`formalization_role_${status}`) ?? 'formalization_failed' });
        return status;
      } catch (cause) { finish('failed', { reason: code(cause instanceof Error ? cause.message : undefined) ?? 'formalization_failed' }); throw cause; }
    };
    const close = opened.close;
    opened.close = async () => { try { await close(); } finally { finish('failed', { reason: 'formalization_role_interrupted' }); } };
    return opened;
  };

  const elaborate = (inner: Elaborate): Elaborate => async (directory, source, environment, options) => {
    const shown = clip(source, limits.source), at = round;
    emit({ round: at, step: 'compile', state: 'started', source: shown.text, ...(shown.clipped ? { sourceClipped: true } : {}) });
    try {
      const result = await inner(directory, source, environment, options);
      emit({ round: at, step: 'compile', state: 'passed', targets: result.targets.slice(0, limits.targets).map(target => clip(target.name, 200).text) });
      return result;
    } catch (cause) {
      if (!options.signal?.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause);
        const lean = formalizationLeanFailure(message);
        emit({ round: at, step: 'compile', state: 'failed', ...(lean ? { lean } :
          /timeout/u.test(code(message) ?? '') ? { lean: { passed: false, timedOut: true, messages: [] } } :
            { text: clip(masked(message.replace(/\nElaboration diagnostics:[\s\S]*$/u, '')), limits.summaryText).text }) });
      }
      throw cause;
    }
  };

  const onEvent = (event: Event) => {
    if (event.round > 0) round = Math.max(round, event.round);
    if (event.event === 'formalization_revision_requested' && event.error) {
      const text = clip(masked(event.error.replace(/\nElaboration diagnostics:[^\n]*/gu, '')), limits.feedback);
      lastRevision = event.error;
      emit({ round: event.round, step: 'revision', stage: 'round', text: text.text, ...(text.clipped ? { textClipped: true } : {}) });
    } else if (event.event === 'formalization_approved') emit({ round: event.round, step: 'approved' });
  };

  /** The run ended without a statement: the stop code, and the host's last words unless the last revision already said them. */
  const stopped = (reason: string, error: string | undefined) => {
    const detail = error && error !== lastRevision && !/^[a-z0-9_]+$/u.test(error) ?
      clip(masked(error.replace(/\nElaboration diagnostics:[^\n]*/gu, '')), limits.feedback) : undefined;
    emit({ round, step: 'stopped', reason, ...(detail ? { text: detail.text, ...(detail.clipped ? { textClipped: true } : {}) } : {}) });
  };
  return { openSession, elaborate, onEvent, stopped };
}
