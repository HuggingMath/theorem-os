import path from 'node:path';
import { webAgentActionKinds, webAgentActionLimits as limits, type WebAgentActionBody, type WebAgentActionIntent, type WebAgentFileChange,
  type WebAgentLeanCheck, type WebAgentLeanSearch, type WebAgentLibraryAction, type WebAgentLibraryDeclaration } from './shared';

type Item = Record<string, unknown>;
export type AgentActionContext = {
  workerId: string;
  /** The Agent's own workspace; its paths read relative to it ("./generated/problem"). */ worktree: string;
  /** Host directories: the application, its build state, the run directory with the other Agents' worktrees. Never shown. */
  hidden: readonly string[];
  /** The Agent commands' file; `bun '<tool>' check-lean` reads `math check-lean`. */ tool?: string;
  apiKey?: string;
};

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
// A directory name continues with these, so `worktree` never matches the start of `worktree-2`.
const notName = '(?![A-Za-z0-9._-])';
const ansi = /\u001b\[[0-9;?]*[ -/]*[@-~]/gu;
const lockLine = /^\{"event":"lean_lock_(?:waiting|acquired)"[^\n]*\}\n?/gmu;
const string = (value: unknown) => typeof value === 'string' ? value : undefined;
const object = (value: unknown): Item | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Item : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

function clip(value: string, limit: number) {
  if (value.length <= limit) return { text: value, clipped: false };
  return { text: limit > 0 ? `${value.slice(0, limit - 1)}…` : '', clipped: true };
}
/** The start and the end of a long output; the middle is what a reader skips. */
function clipOutput(value: string) {
  if (value.length <= limits.output) return { text: value, clipped: false };
  return { text: `${value.slice(0, limits.outputHead)}\n…\n${value.slice(value.length - (limits.output - limits.outputHead - 3))}`, clipped: true };
}
/** `bash -lc '…'` as the command inside it. */
export function unwrapShell(command: string) {
  const wrapped = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/u.exec(command.trim());
  if (!wrapped) return command.trim();
  return wrapped[1] === "'" ? wrapped[2]!.replaceAll(`'\\''`, `'`) : wrapped[2]!.replace(/\\(["\\$`])/gu, '$1');
}

/** Replaces the Agent's workspace with "." and every host directory with "…"; `hidden` says whether one appeared. */
export function createAgentPathMask(context: AgentActionContext) {
  const rules: RegExp[] = [];
  const tool = context.tool ? new RegExp(String.raw`\bbun\s+'?${escape(path.resolve(context.tool))}'?`, 'gu') : undefined;
  const own = new RegExp(escape(path.resolve(context.worktree)) + notName, 'gu');
  for (const root of [...new Set(context.hidden.map(item => path.resolve(item)))].sort((a, b) => b.length - a.length))
    rules.push(new RegExp(escape(root) + notName + "(?:/[^\\s'\"`;|&)\\]}]*)?", 'gu'));
  return (value: string) => {
    let text = context.apiKey && context.apiKey.length >= 8 ? value.replaceAll(context.apiKey, '[REDACTED]') : value;
    if (tool) text = text.replace(tool, 'math');
    text = text.replace(own, '.');
    let hidden = false;
    for (const rule of rules) text = text.replace(rule, () => { hidden = true; return '…'; });
    return { text, hidden };
  };
}

const statuses: Record<string, WebAgentActionBody['status']> = { inProgress: 'running', completed: 'done', failed: 'failed', declined: 'declined' };
// Streaming items start empty; only those that run for a while are worth a "running" row.
const startedKinds = new Set(['commandExecution', 'webSearch', 'mcpToolCall', 'dynamicToolCall', 'reasoning']);

/** The last JSON object a command printed; the Agent's tools end with their result on one line. */
function lastJson(output: string): Item | undefined {
  const line = output.trimEnd().split('\n').reverse().find(value => value.startsWith('{'));
  try { return line ? object(JSON.parse(line)) : undefined; } catch { return; }
}
function leanCheck(result: Item, mask: (value: string) => string): WebAgentLeanCheck | undefined {
  if (typeof result.timedOut !== 'boolean' || !Array.isArray(result.messages)) return;
  const all = result.messages.flatMap((value): WebAgentLeanCheck['messages'] => {
    const message = object(value), severity = string(message?.severity), text = string(message?.message);
    if (!message || !text || (severity !== 'error' && severity !== 'warning' && severity !== 'info')) return [];
    const file = string(message.file), line = count(message.line), column = count(message.column);
    return [{ severity, ...(file ? { file: clip(mask(file), 1_000).text } : {}), ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}), text: clip(mask(text).trim(), limits.leanMessage).text }];
  });
  // Errors first: a reader wants what blocks the proof before its warnings.
  const ordered = [...all.filter(message => message.severity === 'error'), ...all.filter(message => message.severity !== 'error')];
  const messages = ordered.slice(0, limits.leanMessages);
  const omitted = all.length - messages.length + (count(result.omittedMessages) ?? 0);
  return { passed: result.exitCode === 0 && !result.timedOut, ...(result.timedOut ? { timedOut: true } : {}), messages,
    ...(omitted ? { omittedMessages: omitted } : {}) };
}
function leanSearch(result: Item, mask: (value: string) => string): WebAgentLeanSearch | undefined {
  const queries = Array.isArray(result.queries) ? result.queries : string(result.query) !== undefined ? [result] : undefined;
  if (!queries) return;
  const found = queries.slice(0, limits.queries).flatMap(value => {
    const entry = object(value), query = string(entry?.query);
    if (!entry || query === undefined || !Array.isArray(entry.results)) return [];
    const names = entry.results.flatMap(match => {
      const name = string(object(match)?.qualifiedName) ?? string(object(match)?.name);
      return name ? [clip(name, limits.name).text] : [];
    }).slice(0, limits.names);
    return [{ query: clip(mask(query), limits.query).text, total: count(entry.totalMatches) ?? entry.results.length, names }];
  });
  return found.length ? found : undefined;
}
function libraryAction(result: Item, command: string, mask: (value: string) => string): WebAgentLibraryAction | undefined {
  const operation = /\blibrary\s+(search|get|request)\b/u.exec(command)?.[1];
  const schema = operation === 'search' ? 'theorem-os.library-search.v1' : operation === 'get' ? 'theorem-os.library-source.v1'
    : operation === 'request' ? 'theorem-os.library-request-result.v1' : undefined;
  const identity = object(result.library), id = string(identity?.id), revision = string(identity?.revision), catalogDigest = string(identity?.catalogDigest);
  if (!schema || result.schema !== schema || !id || !revision || !catalogDigest || !/^[a-f0-9]{64}$/u.test(catalogDigest)) return;
  const library = { id: clip(mask(id), limits.name).text, revision: clip(mask(revision), limits.name).text, catalogDigest };
  const declaration = (value: unknown): WebAgentLibraryDeclaration | undefined => {
    const entry = object(value), name = string(entry?.name), installation = entry?.installation;
    if (!name || installation !== 'installed-frozen' && installation !== 'not-installed') return;
    return { name: clip(mask(name), limits.name).text, installation };
  };
  const declarations = (value: unknown) => {
    if (!Array.isArray(value)) return;
    const entries = value.map(declaration);
    if (entries.some(entry => !entry)) return;
    return { entries: (entries as WebAgentLibraryDeclaration[]).slice(0, limits.names), omitted: Math.max(0, entries.length - limits.names) };
  };
  if (operation === 'search') {
    const query = string(result.query), goal = string(result.goal), hits = declarations(result.hits), references = declarations(result.namedReferences);
    if (query === undefined || !hits || !references) return;
    return { library, operation, query: clip(mask(query), limits.query).text, ...(goal ? { goal: clip(mask(goal), limits.query).text } : {}),
      hits: hits.entries, namedReferences: references.entries, ...(hits.omitted ? { omittedHits: hits.omitted } : {}),
      ...(references.omitted ? { omittedReferences: references.omitted } : {}) };
  }
  if (operation === 'get') {
    const source = object(result.source), offset = count(source?.offset), nextOffset = source?.nextOffset, complete = source?.complete;
    const entry = declaration({ ...object(result.declaration), installation: result.installation });
    if (!entry || offset === undefined || typeof complete !== 'boolean' ||
      (complete ? nextOffset !== null : count(nextOffset) === undefined || (nextOffset as number) <= offset)) return;
    return { library, operation, declaration: entry, source: { offset, nextOffset: nextOffset as number | null, complete } };
  }
  if (operation === 'request') {
    const entries = declarations(result.declarations), status = result.status;
    if (!entries?.entries.length || status !== 'queued' && status !== 'already-installed') return;
    return { library, operation, status, declarations: entries.entries, ...(entries.omitted ? { omittedDeclarations: entries.omitted } : {}) };
  }
}

/**
 * One Codex thread item as the run's owner may see it, or undefined for items that are the host's own words
 * (its prompts and context) or that carry nothing to show.
 */
export function sanitizeAgentItem(phase: 'started' | 'completed', item: Item, context: AgentActionContext): WebAgentActionBody | undefined {
  const type = string(item.type), itemId = string(item.id);
  if (!type || !itemId || itemId.length > 200 || (phase === 'started' && !startedKinds.has(type))) return;
  const mask = createAgentPathMask(context), shown = (value: string) => mask(value.replace(ansi, '')).text;
  const base = { workerId: context.workerId, itemId, phase };
  const status = (fallback: WebAgentActionBody['status']) => statuses[string(item.status) ?? ''] ?? (phase === 'started' ? 'running' : fallback);
  const text = (value: string | undefined, kind: WebAgentActionBody['kind'], fallback: WebAgentActionBody['status'] = 'done'): WebAgentActionBody => {
    const clipped = clip(shown(value ?? '').trim(), limits.text);
    return { ...base, kind, status: phase === 'started' ? 'running' : fallback, ...(clipped.text ? { text: clipped.text } : {}), ...(clipped.clipped ? { textClipped: true } : {}) };
  };
  switch (type) {
    case 'commandExecution': {
      const raw = unwrapShell(string(item.command) ?? '');
      const command = mask(raw.replace(ansi, '')), cwd = string(item.cwd);
      const outsideCwd = cwd !== undefined && path.relative(path.resolve(context.worktree), path.resolve(cwd)).startsWith('..');
      const rawOutput = (string(item.aggregatedOutput) ?? '').replace(ansi, '').replace(lockLine, '');
      const output = mask(rawOutput);
      // Completed mathematics tools read as bounded reports, their JSON only the carrier. The fields shown are masked;
      // ignored source text, origins and Lean package directories never enter the structured report.
      const result = !command.hidden && !outsideCwd && phase === 'completed' ? lastJson(output.text) : undefined;
      const masked = (value: string) => mask(value).text;
      const library = result ? libraryAction(result, command.text, masked) : undefined;
      const lean = result && !library && /\bcheck-lean\b/u.test(command.text) ? leanCheck(result, masked) : undefined;
      const found = result && !library && !lean && /\bsearch-lean\b/u.test(command.text) ? leanSearch(result, masked) : undefined;
      const withheld = !library && !lean && !found && (command.hidden || output.hidden || outsideCwd);
      const shownCommand = clip(command.text.replace(/\b([a-f0-9]{12})[a-f0-9]{52}\b/gu, '$1…'), limits.command);
      const intents = (Array.isArray(item.commandActions) ? item.commandActions : []).flatMap((value): WebAgentActionIntent[] => {
        const action = object(value), kind = string(action?.type);
        const type = kind === 'read' ? 'read' : kind === 'listFiles' ? 'list' : kind === 'search' ? 'search' : undefined;
        if (!action || !type) return [];
        const where = string(action.path), query = string(action.query);
        return [{ type, ...(where ? { path: clip(mask(where).text, 1_000).text } : {}), ...(query ? { query: clip(shown(query), limits.query).text } : {}) }];
      }).slice(0, limits.intents);
      const tail = clipOutput(output.text.replace(/\s+$/u, ''));
      const exitCode = typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode) ? item.exitCode : undefined;
      // Whatever Codex calls it, a command that exited nonzero failed.
      const state = status('done');
      return { ...base, kind: 'command', status: state === 'done' && exitCode ? 'failed' : state, command: shownCommand.text,
        ...(intents.length ? { intents } : {}),
        ...(withheld ? { withheld: true } : library ? { library } : lean ? { lean } : found ? { found } : tail.text ? { output: tail.text, ...(tail.clipped ? { outputClipped: true } : {}) } : {}),
        ...(exitCode !== undefined ? { exitCode } : {}), ...(count(item.durationMs) !== undefined ? { durationMs: count(item.durationMs) } : {}) };
    }
    case 'fileChange': {
      const all = Array.isArray(item.changes) ? item.changes : [];
      let budget = limits.diffs;
      const changes = all.slice(0, limits.changes).flatMap((value): WebAgentFileChange[] => {
        const change = object(value), file = string(change?.path);
        if (!change || !file) return [];
        const kind = string(object(change.kind)?.type), where = mask(file), moved = string(object(change.kind)?.move_path);
        const diff = where.hidden ? undefined : clip(shown(string(change.diff) ?? ''), Math.min(limits.diff, Math.max(0, budget)));
        if (diff) budget -= diff.text.length;
        return [{ path: clip(where.text, 1_000).text, change: kind === 'add' || kind === 'delete' ? kind : 'update',
          ...(moved ? { movedTo: clip(mask(moved).text, 1_000).text } : {}),
          ...(diff?.text ? { diff: diff.text } : {}), ...(diff?.clipped || (where.hidden && string(change.diff)) ? { clipped: true } : {}) }];
      });
      return { ...base, kind: 'edit', status: status('done'), changes, ...(all.length > changes.length ? { omittedChanges: all.length - changes.length } : {}) };
    }
    case 'reasoning': {
      const parts = (value: unknown) => Array.isArray(value) ? value.filter((part): part is string => typeof part === 'string' && part.trim() !== '') : [];
      const summary = parts(item.summary);
      return text((summary.length ? summary : parts(item.content)).join('\n\n'), 'reasoning');
    }
    case 'agentMessage': return text(string(item.text), 'message');
    case 'plan': return text(string(item.text), 'plan');
    case 'webSearch': {
      const action = object(item.action), query = string(item.query) ?? string(action?.query), url = string(action?.url);
      return { ...base, kind: 'search', status: status('done'), ...(query ? { query: clip(shown(query), limits.query).text } : {}),
        ...(url ? { url: clip(url, limits.query).text } : {}) };
    }
    case 'mcpToolCall': case 'dynamicToolCall': {
      const server = string(item.server) ?? string(item.namespace), name = string(item.tool) ?? 'tool';
      const args = item.arguments === undefined ? '' : clip(shown(JSON.stringify(item.arguments) ?? ''), limits.arguments).text;
      const failed = item.success === false || item.error;
      return { ...base, kind: 'tool', status: status(failed ? 'failed' : 'done'), tool: clip(server ? `${server}.${name}` : name, 200).text,
        ...(args && args !== '{}' && args !== 'null' ? { arguments: args } : {}), ...(count(item.durationMs) !== undefined ? { durationMs: count(item.durationMs) } : {}) };
    }
    case 'imageView': return { ...base, kind: 'tool', status: 'done', tool: 'view_image', arguments: clip(mask(string(item.path) ?? '').text, limits.arguments).text };
    case 'contextCompaction': return { ...base, kind: 'compaction', status: 'done' };
    // User messages and hook prompts are the host's instructions to the Agent, not something the Agent did.
    default: return;
  }
}

const keys = new Set(['workerId', 'itemId', 'phase', 'kind', 'status', 'command', 'intents', 'output', 'outputClipped', 'withheld', 'exitCode',
  'durationMs', 'lean', 'found', 'library', 'changes', 'omittedChanges', 'text', 'textClipped', 'query', 'url', 'tool', 'arguments']);
const short = (value: unknown, limit: number) => value === undefined || typeof value === 'string' && value.length <= limit;
const flag = (value: unknown) => value === undefined || value === true;
const integer = (value: unknown) => value === undefined || typeof value === 'number' && Number.isSafeInteger(value);
const only = (item: Item, allowed: readonly string[]) => Object.keys(item).every(key => allowed.includes(key));

export function isWebAgentLeanCheck(value: unknown): value is WebAgentLeanCheck {
  const lean = object(value);
  return !!lean && only(lean, ['passed', 'timedOut', 'messages', 'omittedMessages']) && typeof lean.passed === 'boolean' && flag(lean.timedOut) &&
    integer(lean.omittedMessages) && Array.isArray(lean.messages) && lean.messages.length <= limits.leanMessages && lean.messages.every(entry => {
      const message = object(entry);
      return !!message && only(message, ['severity', 'file', 'line', 'column', 'text']) && ['error', 'warning', 'info'].includes(message.severity as string) &&
        short(message.file, 1_000) && integer(message.line) && integer(message.column) && typeof message.text === 'string' && short(message.text, limits.leanMessage);
    });
}
function isLeanSearch(value: unknown) {
  return Array.isArray(value) && value.length >= 1 && value.length <= limits.queries && value.every(entry => {
    const query = object(entry);
    return !!query && only(query, ['query', 'total', 'names']) && typeof query.query === 'string' && short(query.query, limits.query) &&
      typeof query.total === 'number' && Number.isSafeInteger(query.total) && query.total >= 0 && Array.isArray(query.names) &&
      query.names.length <= limits.names && query.names.every(name => typeof name === 'string' && name.length <= limits.name);
  });
}
function isLibraryAction(value: unknown) {
  const action = object(value), identity = object(action?.library);
  const requiredText = (value: unknown) => typeof value === 'string' && value.length > 0 && short(value, limits.name);
  const omitted = (value: unknown) => value === undefined || count(value) !== undefined;
  const declaration = (value: unknown) => {
    const item = object(value);
    return !!item && only(item, ['name', 'installation']) && requiredText(item.name) &&
      ['installed-frozen', 'not-installed'].includes(item.installation as string);
  };
  const declarations = (value: unknown) => Array.isArray(value) && value.length <= limits.names && value.every(declaration);
  if (!action || !identity || !only(identity, ['id', 'revision', 'catalogDigest']) || !requiredText(identity.id) || !requiredText(identity.revision) ||
    typeof identity.catalogDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(identity.catalogDigest)) return false;
  if (action.operation === 'search') return only(action, ['library', 'operation', 'query', 'goal', 'hits', 'namedReferences', 'omittedHits', 'omittedReferences']) &&
    typeof action.query === 'string' && short(action.query, limits.query) && short(action.goal, limits.query) && declarations(action.hits) &&
    declarations(action.namedReferences) && omitted(action.omittedHits) && omitted(action.omittedReferences);
  if (action.operation === 'get') {
    const source = object(action.source);
    return only(action, ['library', 'operation', 'declaration', 'source']) && declaration(action.declaration) && !!source &&
      only(source, ['offset', 'nextOffset', 'complete']) && count(source.offset) !== undefined && typeof source.complete === 'boolean' &&
      (source.complete ? source.nextOffset === null : count(source.nextOffset) !== undefined && (source.nextOffset as number) > (source.offset as number));
  }
  return action.operation === 'request' && only(action, ['library', 'operation', 'status', 'declarations', 'omittedDeclarations']) &&
    ['queued', 'already-installed'].includes(action.status as string) && declarations(action.declarations) &&
    (action.declarations as unknown[]).length > 0 && omitted(action.omittedDeclarations);
}

/** The shape and limits sanitizeAgentItem produces; the server accepts nothing else from a worker. */
export function isWebAgentActionBody(value: unknown): value is WebAgentActionBody {
  const action = object(value);
  if (!action || Object.keys(action).some(key => !keys.has(key))) return false;
  if (typeof action.workerId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/u.test(action.workerId)) return false;
  if (typeof action.itemId !== 'string' || !action.itemId || action.itemId.length > 200) return false;
  if (!['started', 'completed'].includes(action.phase as string) || !(webAgentActionKinds as readonly unknown[]).includes(action.kind)) return false;
  if (!['running', 'done', 'failed', 'declined'].includes(action.status as string)) return false;
  if (!short(action.command, limits.command) || !short(action.output, limits.output) || !short(action.text, limits.text) ||
      !short(action.query, limits.query) || !short(action.url, limits.query) || !short(action.tool, 200) || !short(action.arguments, limits.arguments)) return false;
  if (![action.outputClipped, action.withheld, action.textClipped].every(flag) || ![action.exitCode, action.durationMs, action.omittedChanges].every(integer)) return false;
  if ((action.lean !== undefined && !isWebAgentLeanCheck(action.lean)) || (action.found !== undefined && !isLeanSearch(action.found))) return false;
  if (action.library !== undefined && (action.kind !== 'command' || action.phase !== 'completed' || !isLibraryAction(action.library) ||
    [action.lean, action.found, action.output, action.outputClipped, action.withheld].some(value => value !== undefined))) return false;
  if (action.intents !== undefined && (!Array.isArray(action.intents) || action.intents.length > limits.intents || !action.intents.every(intent => {
    const item = object(intent);
    return item && Object.keys(item).every(key => ['type', 'path', 'query'].includes(key)) && ['read', 'list', 'search'].includes(item.type as string) &&
      short(item.path, 1_000) && short(item.query, limits.query);
  }))) return false;
  if (action.changes !== undefined && (!Array.isArray(action.changes) || action.changes.length > limits.changes || !action.changes.every(change => {
    const item = object(change);
    return item && Object.keys(item).every(key => ['path', 'change', 'movedTo', 'diff', 'clipped'].includes(key)) && typeof item.path === 'string' &&
      short(item.path, 1_000) && ['add', 'delete', 'update'].includes(item.change as string) && short(item.movedTo, 1_000) && short(item.diff, limits.diff) && flag(item.clipped);
  }))) return false;
  return JSON.stringify(action).length <= limits.encoded;
}
