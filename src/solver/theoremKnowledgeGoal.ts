import { maskLeanComments, maskLeanCommentsAndStrings } from '../math/leanSyntax';

type SurfaceToken = string | readonly ['bound', number, ...string[]];
type Scope = ReadonlyMap<string, number>;
const simpleName = /^[\p{L}_][\p{L}\p{M}\p{N}_']*$/u;
const binders = new Map([['∀', 'forall'], ['forall', 'forall'], ['∑', 'sum'], ['∏', 'prod']]);
const unsupported = new Set(['∃', 'exists', '∫', 'Σ', 'Π', '⨆', '⨅', 'fun', 'λ', 'let', 'letI', 'have', 'haveI',
  'match', 'by', 'where', 'do', 'if', 'then', 'else', '↦', '=>', ':=', '//', '|', '?', '_', '⊢', "'", '«', '»', '`', '$']);
const aliases = new Map([['ℕ', 'Nat'], ['ℤ', 'Int'], ['ℚ', 'Rat'], ['ℝ', 'Real'], ['ℂ', 'Complex'],
  ['→', '->'], ['↔', '<->']]);
// Filter/measure notations such as ∀ᶠ and ∀ᵐ are scoped macros, not a forall
// followed by a local named ᶠ/ᵐ. Preserve their original text until supported.
const decoratedQuantifier = /[∀∃][\p{Lm}\p{M}\p{No}]/u;
const ambiguousSumTail = new Set(['=', '≠', '<', '>', '≤', '≥', '∧', '∨', '→', '->', '↔', '<->',
  '∈', '∉', '⊆', '⊂', '⊇', '⊃', ',', ';', ':']);

export type KnowledgeResidualView = Readonly<{ display: string; target: string; goal: string; caseLabel?: string;
  localContext: 'closed-for-retrieval' | 'target-only' | 'no-locals'; fallbackReason?: string }>;

/** Split Lean's displayed cases, closing only simple local declarations. Never an elaborated type. */
export function knowledgeResidualViews(value: string): KnowledgeResidualView[] {
  if (!/⊢|\|-/u.test(value)) return [{ display: value, target: value, goal: value, localContext: 'no-locals' }];
  const blocks = value.split(/(?=^\s*case\s+[^\n]+$)/gmu).filter(block => block.trim());
  const result: KnowledgeResidualView[] = [];
  for (const block of blocks) {
    const markers = [...block.matchAll(/⊢|\|-/gu)];
    if (markers.length !== 1) {
      // Unsupported displays are searched as a whole, never by silently taking their final target.
      result.push({ display: block, target: block, goal: block, localContext: 'target-only', fallbackReason: 'ambiguous-goal-display' });
      continue;
    }
    const marker = markers[0]!, before = block.slice(0, marker.index), target = block.slice(marker.index! + marker[0].length).trim();
    const lines = before.trim().split('\n').map(line => line.trim()).filter(Boolean);
    const caseLabel = lines[0]?.startsWith('case ') ? lines.shift()!.slice(5).trim() : undefined;
    const binders: string[] = [], names = new Set<string>();
    let supported = true;
    for (const line of lines) {
      const declaration = /^([\p{L}_][\p{L}\p{M}\p{N}_' \t]*)\s*:\s*(.+)$/u.exec(line);
      if (!declaration || /:=|[✝†]|\.{3}|…/u.test(line)) { supported = false; break; }
      const declared = declaration[1]!.trim().split(/\s+/u), type = declaration[2]!.trim();
      if (!type || declared.some(name => !simpleName.test(name) || names.has(name) || name === '_')) { supported = false; break; }
      // Unbalanced or multiline locals and local definitions cannot be faithfully closed here.
      const stack: string[] = [];
      for (const char of type) {
        if ('([{'.includes(char)) stack.push(char);
        else if (')]}'.includes(char) && stack.pop() !== '([{'.charAt(')]}'.indexOf(char))) { supported = false; break; }
      }
      if (stack.length || !supported) { supported = false; break; }
      declared.forEach(name => names.add(name));
      binders.push(`(${declared.join(' ')} : ${type})`);
    }
    result.push({ display: block.trim(), target, goal: supported && binders.length ? `∀ ${binders.join(' ')}, ${target}` : target,
      ...(caseLabel ? { caseLabel } : {}), localContext: !supported ? 'target-only' : binders.length ? 'closed-for-retrieval' : 'no-locals',
      ...(!supported ? { fallbackReason: 'unsupported-local-declaration' } : {}) });
  }
  return result;
}

/** A conservative ranking surface, never evidence of Lean equivalence or applicability. */
export function knowledgeGoalSurfaceShape(value: string): string | undefined {
  if (maskLeanComments(value).includes('"')) return undefined;
  const source = maskLeanCommentsAndStrings(value);
  if (decoratedQuantifier.test(source)) return undefined;
  const tokens = [...source.matchAll(
    /[\p{L}_][\p{L}\p{M}\p{N}_']*(?:\.[\p{L}_][\p{L}\p{M}\p{N}_']*)*|[0-9]+|<->|->|=>|:=|\/\/|[^\s]/gu
  )].map(match => match[0]);
  if (!tokens.length || tokens.length > 8192 || tokens.some(token => unsupported.has(token))) return undefined;
  const pairs = new Map<number, number>(), stack: number[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (['(', '[', '{'].includes(token)) stack.push(index);
    else if ([')', ']', '}'].includes(token)) {
      const start = stack.pop();
      if (start === undefined || ['(', '[', '{'].indexOf(tokens[start]!) !== [')', ']', '}'].indexOf(token)) return undefined;
      pairs.set(start, index);
    }
  }
  if (stack.length) return undefined;
  let nextBinding = 0;

  function splitAt(start: number, end: number, separator: string): number | undefined {
    for (let index = start; index < end; index++) {
      if (tokens[index] === separator) return index;
      if (pairs.has(index)) index = pairs.get(index)!;
    }
    return undefined;
  }

  function normalize(start: number, end: number, scope: Scope, depth: number, sumBody = false): SurfaceToken[] | undefined {
    if (depth > 64) return undefined;
    const output: SurfaceToken[] = [];
    for (let index = start; index < end; index++) {
      const token = tokens[index]!, binder = binders.get(token);
      if (sumBody && (ambiguousSumTail.has(token) || binder === 'forall')) return undefined;
      if (binder) {
        const local = new Map(scope), header: SurfaceToken[] = [binder];
        let cursor = index + 1, declared = false;
        const declare = (names: readonly string[], typeStart: number, typeEnd: number, opening: string, closing: string) => {
          if (!names.length || names.some(name => !simpleName.test(name) || local.has(name) || name === '_root_') ||
              new Set(names).size !== names.length || typeStart >= typeEnd) return false;
          const type = normalize(typeStart, typeEnd, local, depth + 1);
          if (!type) return false;
          header.push(opening);
          for (const name of names) {
            const id = nextBinding++;
            local.set(name, id); header.push(['bound', id]);
          }
          header.push(':', ...type, closing); declared = true;
          return true;
        };
        if (binder === 'forall') {
          while (cursor < end && ['(', '[', '{'].includes(tokens[cursor]!)) {
            const close = pairs.get(cursor);
            if (close === undefined || close >= end) return undefined;
            const colon = splitAt(cursor + 1, close, ':');
            if (colon === undefined) {
              if (tokens[cursor] !== '[' || cursor + 1 === close) return undefined;
              const type = normalize(cursor + 1, close, local, depth + 1);
              if (!type) return undefined;
              header.push('[', ...type, ']');
            } else if (!declare(tokens.slice(cursor + 1, colon), colon + 1, close, tokens[cursor]!, tokens[close]!)) return undefined;
            cursor = close + 1;
          }
        }
        if (tokens[cursor] !== ',') {
          const comma = splitAt(cursor, end, ','), colon = comma === undefined ? undefined : splitAt(cursor, comma, ':');
          if (comma === undefined || colon === undefined || (binder !== 'forall' && colon !== cursor + 1)) return undefined;
          for (let check = colon + 1; check < comma; check++) {
            if (pairs.has(check)) check = pairs.get(check)!;
            else if (binders.has(tokens[check]!)) return undefined;
          }
          if (!declare(tokens.slice(cursor, colon), colon + 1, comma, '(', ')')) return undefined;
          cursor = comma;
        }
        if (!declared || cursor + 1 >= end) return undefined;
        const body = normalize(cursor + 1, end, local, depth + 1, binder !== 'forall');
        return body ? [...output, ...header, ',', ...body] : undefined;
      }
      const close = pairs.get(index);
      if (close !== undefined) {
        // Dependent arrows outside an explicit forall are outside this small supported surface.
        if (splitAt(index + 1, close, ':') !== undefined && ['→', '->'].includes(tokens[close + 1] ?? '')) return undefined;
        const contents = normalize(index + 1, close, scope, depth + 1);
        if (!contents) return undefined;
        output.push(token, ...contents, tokens[close]!); index = close;
      } else {
        const [head, ...fields] = token.split('.'), bound = scope.get(head!);
        output.push(bound === undefined ? aliases.get(token) ?? token : ['bound', bound, ...fields]);
      }
    }
    return output;
  }

  const result = normalize(0, tokens.length, new Map(), 0);
  return result && nextBinding ? JSON.stringify(result) : undefined;
}

/*
 * A syntactic reading of a closed Lean type, shared by retrieval and goal-path review. Bound names are numbered
 * by first later use, so `(N : Matrix …)` and `(M : Matrix …)` agree;
 * a shape this reader does not understand yields no suggestion rather than a guess. It never decides validity.
 */
export type StatementShape = { parts: { key: string; text: string; binder: boolean }[]; conclusion: string };
const OPEN = '([{⟨⦃', CLOSE = ')]}⟩⦄';
// Each scopes over the rest of its expression, so a later depth-0 arrow belongs to its body.
const SCOPING = ['∀', '∃', 'Σ', 'Π', 'λ', '∑', '∏', '⋃', '⋂', '⨆', '⨅', 'fun', 'let', 'have', 'show', 'forall', 'exists'];
const ID = String.raw`\p{L}\p{N}_'!?ₐ-ₜ`;
const NAME = new RegExp(`^[\\p{L}_][${ID}]*$`, 'u'), NAME_CHAR = new RegExp(`[${ID}.]`, 'u');
const RELATION = /^(\S+?)\s*(∈|∉|<|≤|>|≥|≠|⊆|⊂)\s*(\S.*)$/su;
const maxStatementLength = 20000;

const scopingAt = (text: string, index: number) => SCOPING.some(word => text.startsWith(word, index) &&
  !(/^\p{L}/u.test(word) && (index > 0 && NAME_CHAR.test(text[index - 1]!) || NAME_CHAR.test(text[index + word.length] ?? ''))));
/** First depth-0 token at or after `from`; none once a depth-0 scoping binder starts. */
function topLevel(text: string, tokens: readonly string[], from = 0) {
  let depth = 0;
  for (let index = from; index < text.length; index++) {
    const char = text[index]!;
    if (OPEN.includes(char)) depth++;
    else if (CLOSE.includes(char)) { if (--depth < 0) return -1; }
    else if (depth === 0) {
      if (scopingAt(text, index)) return -1;
      if (tokens.some(token => text.startsWith(token, index))) return index;
    }
  }
  return -1;
}
/** Index of the bracket closing `text[0]`, or -1. */
function closing(text: string) {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    if (OPEN.includes(text[index]!)) depth++;
    else if (CLOSE.includes(text[index]!) && --depth === 0) return index;
  }
  return -1;
}
const squash = (text: string) => text.replace(/\s+/gu, ' ').replace(/([([{⟨⦃]) /gu, '$1').replace(/ ([)\]}⟩⦄])/gu, '$1').trim();
function unwrap(text: string) {
  text = text.trim();
  while (text.startsWith('(') && closing(text) === text.length - 1) text = text.slice(1, -1).trim();
  return text;
}

function parseStatement(type: string): { shape: StatementShape; prefix: string } | undefined {
  if (type.length > maxStatementLength || decoratedQuantifier.test(maskLeanCommentsAndStrings(type))) return;
  const parts: StatementShape['parts'] = [], names = new Map<string, string>();
  const reference = (name: string) => new RegExp(`(?<![${ID}.])${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?![${ID}])`, 'gu');
  const rename = (text: string) => squash([...names].reduce((value, [from, to]) => value.replace(reference(from), to), unwrap(text)));
  // Only names used later are numbered: an unused named hypothesis is an ordinary premise.
  const bind = (binderNames: readonly string[], key: string, text: string, rest: string) => {
    for (const name of binderNames) {
      const used = name !== '_' && reference(name).test(rest);
      if (used) names.set(name, `_b${names.size}`);
      parts.push({ key, text, binder: used });
    }
  };
  const group = (inner: string, bracket: string, rest: string) => {
    const colon = topLevel(inner, [':']);
    if (colon < 0) {
      if (bracket === '[') { parts.push({ key: rename(inner), text: squash(inner), binder: true }); return true; }
      // `∀ x y, P` leaves the binder types to elaboration.
      const bare = inner.trim().split(/\s+/u);
      if (bracket !== '{' && bare.every(name => NAME.test(name))) { bind(bare, '?', squash(inner), rest); return true; }
      const relation = bracket ? undefined : RELATION.exec(inner.trim());
      if (!relation || !NAME.test(relation[1]!)) return false;
      bind([relation[1]!], `${relation[2]} ${rename(relation[3]!)}`, squash(inner), rest);
      return true;
    }
    const binderNames = inner.slice(0, colon).trim().split(/\s+/u);
    if (!binderNames.every(name => NAME.test(name))) return false;
    bind(binderNames, rename(inner.slice(colon + 1)), squash(inner), rest);
    return true;
  };
  const normalized = type.replace(/<->/gu, '↔').replace(/->/gu, '→').trim();
  let body = normalized;
  for (let guard = 0; guard < 256; guard++) {
    body = body.trim();
    const quantifier = /^(?:∀|forall\b)/u.exec(body);
    if (quantifier) {
      const offset = quantifier[0].length, comma = topLevel(body, [','], offset);
      if (comma < 0) return;
      let binders = body.slice(offset, comma).trim();
      const rest = body.slice(comma + 1);
      while (binders) {
        const bracket = binders[0]!;
        if (!OPEN.includes(bracket)) { if (!group(binders, '', rest)) return; break; }
        const end = closing(binders);
        if (end < 0 || !group(binders.slice(1, end), bracket, binders.slice(end + 1) + rest)) return;
        binders = binders.slice(end + 1).trim();
      }
      body = rest; continue;
    }
    // `→` binds tighter than `↔`, so a depth-0 iff anywhere makes the whole body the conclusion.
    if (topLevel(body, ['↔']) >= 0) break;
    const arrow = topLevel(body, ['→']);
    if (arrow < 0) break;
    const head = body.slice(0, arrow).trim(), tail = body.slice(arrow + 1);
    // A dependent arrow `(h : P) → Q` names its premise.
    if (head.startsWith('(') && closing(head) === head.length - 1 && topLevel(head.slice(1, -1), [':']) >= 0 &&
        group(head.slice(1, -1), '(', tail)) { body = tail; continue; }
    parts.push({ key: rename(head), text: squash(head), binder: false });
    body = tail;
  }
  return { shape: { parts, conclusion: rename(body) }, prefix: normalized.slice(0, normalized.length - body.length) };
}

/** Read binders and arrow premises off a closed type; undefined when its shape is not understood. */
export function splitStatement(type: string): StatementShape | undefined {
  return parseStatement(type)?.shape;
}

/** Read the two sides of a top-level iff, respecting parentheses and scoped binders. */
export function splitIffConclusion(conclusion: string): readonly [string, string] | undefined {
  if (conclusion.length > maxStatementLength) return;
  const body = unwrap(conclusion.replace(/<->/gu, '↔'));
  const iff = topLevel(body, ['↔']);
  if (iff < 0 || topLevel(body, ['↔'], iff + 1) >= 0) return;
  const left = squash(unwrap(body.slice(0, iff))), right = squash(unwrap(body.slice(iff + 1)));
  return left && right ? [left, right] : undefined;
}

/** Preserve the parsed context for a retrieval query; the replacement is not checked as a Lean proposition. */
export function withStatementConclusion(type: string, replacement: string): string | undefined {
  const parsed = parseStatement(type);
  return parsed ? parsed.prefix + replacement : undefined;
}
