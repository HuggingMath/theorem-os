import { maskLeanCommentsAndStrings, leanScopeCommands, leanScopeNamespace, updateLeanScopes, type LeanScope } from './leanSyntax';
import { mathDigest } from './mathRuntimeIo';

export const inspectLeanSource = (
  source: string
): { sorryCount: number; admitCount: number; axioms: string[] } => {
  const inspectedSource = maskLeanCommentsAndStrings(source);
  let sorryCount = 0;
  let admitCount = 0;
  const axioms: string[] = [];
  for (const match of inspectedSource.matchAll(/\b(?:(sorry)\b|(admit)\b|axiom\s+([A-Za-z0-9_'.]+))/gu)) {
    if (match[1]) sorryCount += 1;
    else if (match[2]) admitCount += 1;
    else if (axioms.length < 64) axioms.push(match[3]);
  }
  return {
    sorryCount,
    admitCount,
    axioms,
  };
};

type MathematicsLeanSourceDeclarationKind = 'theorem' | 'definition' | 'instance';

type LeanSourceDeclaration = Readonly<{
  startOffset: number;
  bodyOffset: number;
  firstTermOffset: number;
  parametersOffset: number;
  whereBody?: boolean;
  name: string;
  canonicalHeader: string;
  kind: MathematicsLeanSourceDeclarationKind;
}>;

export type MathematicsLeanSourceDeclaration = Readonly<{
  startOffset: number;
  name: string;
  declarationType: string;
  kind: MathematicsLeanSourceDeclarationKind;
}>;

const isLeanNameCharacter = (value: string | undefined): boolean =>
  Boolean(value && /[\p{L}\p{M}\p{N}_'.?!]/u.test(value));

// A structure initializer may place fields in the declaration's column.
// Command tokens, rather than indentation alone, delimit an empty field list.
const leanWhereCommand = /^(?:@\[|#|(?:theorem|lemma|def|abbrev|opaque|instance|example|class|structure|inductive|coinductive|axiom|constant|constants|variable|variables|universe|universes|namespace|section|end|mutual|open|export|include|omit|set_option|attribute|local|scoped|noncomputable|private|protected|public|unsafe|partial|nonrec|meta|syntax|macro|elab|notation|infix|infixl|infixr|prefix|postfix|initialize|builtin_initialize|import)(?![\p{L}\p{M}\p{N}_'.?!]))/u;

/** `instance` inside `@[…]` or `attribute […]`, or after `deriving`, names an attribute or a derive handler.
 * Read as a declaration, `attribute [instance 1001] a` swallowed the next command up to its `:=`. */
function isInstanceAttributeOrDeriving(source: string, offset: number): boolean {
  const before = source.slice(Math.max(0, offset - 256), offset);
  if (/(?<![\p{L}\p{M}\p{N}_'.?!])deriving\s+$/u.test(before)) return true;
  const open = before.lastIndexOf('[');
  if (open < 0 || before.slice(open).includes(']')) return false;
  return /(?:@|(?<![\p{L}\p{M}\p{N}_'.?!])attribute\s*)$/u.test(before.slice(0, open)) &&
    /^\[(?:[^[\]"]*,)?\s*(?:(?:local|scoped)\s+|-\s*)?$/u.test(before.slice(open));
}

function scopedLeanDeclarations(source: string, declarations: readonly MathematicsLeanSourceDeclaration[]) {
  const scopes: LeanScope[] = [], commands = leanScopeCommands(maskLeanCommentsAndStrings(source));
  let command = commands.next();
  return declarations.map(declaration => {
    while (!command.done && command.value.index < declaration.startOffset) {
      updateLeanScopes(scopes, command.value[1], command.value[2]?.trim());
      command = commands.next();
    }
    const namespace = leanScopeNamespace(scopes);
    const qualifiedName = declaration.name.startsWith('_root_.') ? declaration.name.slice(7) :
      [namespace, declaration.name].filter(Boolean).join('.');
    return { ...declaration, namespace, qualifiedName };
  });
}

export function inspectScopedLeanDeclarations(source: string) {
  return scopedLeanDeclarations(source, inspectLeanDeclarations(source));
}

/** Statements may repeat a final name component in different namespaces (`Literal.eval`, `Clause.eval`). Such
 * declarations are identified by their qualified name, every other one by its written name. Keyed by start offset. */
export function leanDeclarationKeys(source: string): Map<number, string> {
  const declarations = inspectScopedLeanDeclarations(source), counts = new Map<string, number>();
  const local = (name: string) => name.split('.').at(-1)!;
  for (const item of declarations) counts.set(local(item.name), (counts.get(local(item.name)) ?? 0) + 1);
  return new Map(declarations.map(item => [item.startOffset, counts.get(local(item.name))! > 1 ? item.qualifiedName : item.name]));
}

/** Final name components that repeat, with their counts; a valid edit keeps exactly the original repeats. */
export function repeatedLeanLocalNames(names: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name.split('.').at(-1)!, (counts.get(name.split('.').at(-1)!) ?? 0) + 1);
  return JSON.stringify([...counts].filter(([, count]) => count > 1).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

/** The declaration a closed type query reopens; a same-named declaration in another namespace is not it. */
export function findLeanTypeQueryDeclaration(source: string, theoremName: string) {
  const declarations = inspectScopedLeanDeclarations(source);
  return declarations.find(declaration => declaration.qualifiedName === theoremName) ??
    declarations.find(declaration => declaration.name === theoremName);
}

/** Reopen a declaration's namespaces and active lookup scopes for a closed type query. */
export function leanDeclarationContextCommands(source: string, theoremName: string) {
  const target = findLeanTypeQueryDeclaration(source, theoremName);
  if (!target) throw new Error('Lean type query declaration was not found.');
  const regions = inspectLeanDeclarationRegions(source);
  const frames: string[][] = [[]];
  const ends: string[] = [];
  for (const command of leanScopeCommands(maskLeanCommentsAndStrings(source))) {
    if (command.index >= target.startOffset) break;
    if (regions.some(region => command.index >= region.startOffset && command.index < region.endOffset)) continue;
    const kind = command[1];
    if (kind === 'namespace' || kind === 'section') {
      frames.push([command[0].trim()]); ends.push(`end${command[2]?.trim() ? ' ' + command[2].trim() : ''}`);
    } else if (kind === 'mutual') { frames.push([]); ends.push(''); }
    else if (kind === 'end') { if (frames.length > 1) { frames.pop(); ends.pop(); } }
    else if (kind === 'open') frames.at(-1)!.push(command[0].trim());
  }
  // An unclosed `mutual` before the target is not reopened.
  return { before: frames.flat(), after: ends.filter(Boolean).reverse() };
}

/**
 * Extract named declaration headers without mistaking a binder default such
 * as `(x : Nat := 0)` for the declaration/body boundary. This is deliberately
 * a small lexer rather than a regular expression: comments, strings, and
 * balanced delimiter groups are all skipped while searching for the top-level
 * `:=` or a line-leading equation clause `|`. Lean permits Unicode,
 * apostrophes, `?` and `!` in identifiers; a single quote is not a string delimiter here.
 */
type LeanDeclarationIndex = 'named' | 'projection' | 'legacy-where';

function* leanSourceDeclarations(source: string, mode: LeanDeclarationIndex = 'named'): Generator<LeanSourceDeclaration, void, void> {
  const includeAnonymousInstances = mode === 'projection';
  const declarationKeywords: Readonly<Record<string, string>> = {
    t: 'theorem', l: 'lemma', d: 'def', i: 'instance', o: 'opaque', a: 'abbrev',
  };
  const codePointBefore = (offset: number): string | undefined => {
    if (offset <= 0) return undefined;
    const previous = source.charCodeAt(offset - 1);
    if (previous >= 0xdc00 && previous <= 0xdfff && offset >= 2) return source.slice(offset - 2, offset);
    return source[offset - 1];
  };
  const codePointAt = (offset: number): string | undefined => {
    if (offset >= source.length) return undefined;
    const value = source.codePointAt(offset);
    return value === undefined ? undefined : String.fromCodePoint(value);
  };
  let index = 0;
  let blockDepth = 0;
  let lineComment = false;
  let quote: '"' | undefined;
  let escaped = false;

  const skipTrivia = (start: number): number => {
    let cursor = start;
    while (cursor < source.length) {
      if (/\s/u.test(source[cursor])) {
        cursor += 1;
        continue;
      }
      if (source[cursor] === '-' && source[cursor + 1] === '-') {
        cursor += 2;
        while (cursor < source.length && source[cursor] !== '\n') cursor += 1;
        continue;
      }
      if (source[cursor] === '/' && source[cursor + 1] === '-') {
        cursor += 2;
        let depth = 1;
        while (cursor < source.length && depth > 0) {
          if (source[cursor] === '/' && source[cursor + 1] === '-') {
            depth += 1;
            cursor += 2;
          } else if (source[cursor] === '-' && source[cursor + 1] === '/') {
            depth -= 1;
            cursor += 2;
          } else cursor += 1;
        }
        continue;
      }
      break;
    }
    return cursor;
  };

  const isEmptyInstanceWhere = (whereStart: number): boolean => {
    const nextToken = skipTrivia(whereStart + 5);
    if (nextToken === source.length) return true;
    const nextLine = source.lastIndexOf('\n', nextToken - 1) + 1;
    if (nextLine <= whereStart) return false;
    return leanWhereCommand.test(source.slice(nextToken));
  };

  const hasEquationArrow = (start: number): boolean => {
    let cursor = start + 1;
    const delimiters: string[] = [];
    while (cursor < source.length) {
      cursor = skipTrivia(cursor);
      const value = source[cursor];
      if (value === undefined) break;
      if (value === '"') {
        cursor++;
        while (cursor < source.length) {
          if (source[cursor] === '\\') cursor += 2;
          else if (source[cursor++] === '"') break;
        }
        continue;
      }
      if (value === "'" && !isLeanNameCharacter(codePointBefore(cursor))) {
        const character = /^'(?:\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|x[\da-fA-F]{2}|[^\r\n])|[^'\\\r\n])'/u.exec(source.slice(cursor));
        if (character) { cursor += character[0].length; continue; }
      }
      if (delimiters.length === 0) {
        if (source.startsWith('=>', cursor)) return true;
        if (source.startsWith(':=', cursor)) return false;
        // Type relations and lambdas cannot be top-level equation patterns.
        if (/[=→≤≥≠∧∨↔∈∉]/u.test(value) || source.startsWith('->', cursor)) return false;
        if (!isLeanNameCharacter(codePointBefore(cursor)) &&
            /^(?:fun|λ|match)(?![\p{L}\p{M}\p{N}_'.?!])/u.test(source.slice(cursor))) return false;
      }
      const opening = '([{'.indexOf(value);
      if (opening >= 0) delimiters.push(')]}'[opening]);
      else if (')]}'.includes(value) && delimiters.pop() !== value) return false;
      cursor++;
    }
    return false;
  };

  // Keep the canonicalizer beside the lexer state it serves; this parser is
  // intentionally self-contained so declaration-header behavior stays local.
  // eslint-disable-next-line unicorn/consistent-function-scoping
  const canonicalize = (value: string): string => {
    let result = '';
    let cursor = 0;
    let nestedBlockDepth = 0;
    let inLineComment = false;
    let stringQuote: '"' | undefined;
    let stringEscaped = false;
    let pendingSpace = false;
    while (cursor < value.length) {
      const current = value[cursor];
      const next = value[cursor + 1];
      if (inLineComment) {
        if (current === '\n') {
          inLineComment = false;
          pendingSpace = true;
        }
        cursor += 1;
        continue;
      }
      if (nestedBlockDepth > 0) {
        if (current === '/' && next === '-') {
          nestedBlockDepth += 1;
          cursor += 2;
        } else if (current === '-' && next === '/') {
          nestedBlockDepth -= 1;
          cursor += 2;
          pendingSpace = true;
        } else cursor += 1;
        continue;
      }
      if (stringQuote) {
        if (pendingSpace && result) result += ' ';
        pendingSpace = false;
        result += current;
        if (stringEscaped) stringEscaped = false;
        else if (current === '\\') stringEscaped = true;
        else if (current === stringQuote) stringQuote = undefined;
        cursor += 1;
        continue;
      }
      if (current === '-' && next === '-') {
        inLineComment = true;
        cursor += 2;
        continue;
      }
      if (current === '/' && next === '-') {
        nestedBlockDepth = 1;
        cursor += 2;
        continue;
      }
      if (current === '"') {
        if (pendingSpace && result) result += ' ';
        pendingSpace = false;
        stringQuote = current;
        result += current;
      } else if (/\s/u.test(current)) {
        pendingSpace = true;
      } else {
        if (pendingSpace && result) result += ' ';
        pendingSpace = false;
        result += current;
      }
      cursor += 1;
    }
    return result.trim();
  };

  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (current === '\n') lineComment = false;
      index += 1;
      continue;
    }
    if (blockDepth > 0) {
      if (current === '/' && next === '-') {
        blockDepth += 1;
        index += 2;
      } else if (current === '-' && next === '/') {
        blockDepth -= 1;
        index += 2;
      } else index += 1;
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (current === '\\') escaped = true;
      else if (current === quote) quote = undefined;
      index += 1;
      continue;
    }
    if (current === '-' && next === '-') {
      lineComment = true;
      index += 2;
      continue;
    }
    if (current === '/' && next === '-') {
      blockDepth = 1;
      index += 2;
      continue;
    }
    if (current === '"') {
      quote = current;
      index += 1;
      continue;
    }
    const keyword = declarationKeywords[current!];
    if (
      !keyword ||
      !source.startsWith(keyword, index) ||
      isLeanNameCharacter(codePointBefore(index)) ||
      isLeanNameCharacter(codePointAt(index + keyword.length)) ||
      keyword === 'instance' && isInstanceAttributeOrDeriving(source, index)
    ) {
      index += 1;
      continue;
    }
    let nameStart = skipTrivia(index + keyword.length);
    const priorityStart = includeAnonymousInstances && keyword === 'instance' && source[nameStart] === '('
      ? skipTrivia(nameStart + 1) : undefined;
    if (priorityStart !== undefined && source.startsWith('priority', priorityStart) &&
        source.startsWith(':=', skipTrivia(priorityStart + 'priority'.length))) {
      let cursor = nameStart, depth = 0;
      do {
        cursor = skipTrivia(cursor);
        if (source[cursor] === '"') {
          for (cursor++; cursor < source.length; cursor++) {
            if (source[cursor] === '\\') cursor++;
            else if (source[cursor] === '"') { cursor++; break; }
          }
          continue;
        }
        if (source[cursor] === '(') depth++;
        else if (source[cursor] === ')') depth--;
        cursor++;
      } while (cursor < source.length && depth > 0);
      nameStart = skipTrivia(cursor);
    }
    // A dot qualifies another name component; the dot in `name.{u, v}`
    // introduces universe parameters and is not part of the declaration name.
    const name = /^[\p{L}\p{M}\p{N}_'][\p{L}\p{M}\p{N}_'?!]*(?:\.[\p{L}\p{M}\p{N}_'][\p{L}\p{M}\p{N}_'?!]*)*/u.exec(source.slice(nameStart))?.[0] ?? '';
    const nameEnd = nameStart + name.length;
    if (!name && !(includeAnonymousInstances && keyword === 'instance')) {
      index += keyword.length;
      continue;
    }
    let cursor = nameEnd;
    let parenDepth = 0;
    let bracketDepth = 0;
    let braceDepth = 0;
    let localBlockDepth = 0;
    let localLineComment = false;
    let localQuote: '"' | undefined;
    let localEscaped = false;
    let proofStart = -1;
    let bodyOffset = -1;
    let whereBody = false;
    let hasTopLevelMatchType = false;
    let pendingLocalBindings = 0;
    while (cursor < source.length) {
      const value = source[cursor];
      const following = source[cursor + 1];
      if (localLineComment) {
        if (value === '\n') localLineComment = false;
        cursor += 1;
        continue;
      }
      if (localBlockDepth > 0) {
        if (value === '/' && following === '-') {
          localBlockDepth += 1;
          cursor += 2;
        } else if (value === '-' && following === '/') {
          localBlockDepth -= 1;
          cursor += 2;
        } else cursor += 1;
        continue;
      }
      if (localQuote) {
        if (localEscaped) localEscaped = false;
        else if (value === '\\') localEscaped = true;
        else if (value === localQuote) localQuote = undefined;
        cursor += 1;
        continue;
      }
      if (value === '-' && following === '-') {
        localLineComment = true;
        cursor += 2;
        continue;
      }
      if (value === '/' && following === '-') {
        localBlockDepth = 1;
        cursor += 2;
        continue;
      }
      if (value === '"') {
        localQuote = value;
        cursor += 1;
        continue;
      }
      if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 &&
          !isLeanNameCharacter(codePointBefore(cursor))) {
        const binding = /^(?:letI|haveI|let|have)\b/u.exec(source.slice(cursor));
        if (binding && !isLeanNameCharacter(codePointAt(cursor + binding[0].length))) {
          pendingLocalBindings++;
          cursor += binding[0].length;
          continue;
        }
      }
      if (
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0 &&
        source.startsWith('match', cursor) &&
        !isLeanNameCharacter(codePointBefore(cursor)) &&
        !isLeanNameCharacter(codePointAt(cursor + 5))
      )
        hasTopLevelMatchType = true;
      if (value === '(') parenDepth += 1;
      else if (value === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (value === '[') bracketDepth += 1;
      else if (value === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (value === '{') braceDepth += 1;
      else if (value === '}') braceDepth = Math.max(0, braceDepth - 1);
      else if (value === ':' && following === '=' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
        if (pendingLocalBindings > 0) { pendingLocalBindings--; cursor += 2; continue; }
        proofStart = cursor;
        bodyOffset = cursor + 2;
        break;
      } else if (keyword === 'instance' &&
        parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && source.startsWith('where', cursor) &&
        !isLeanNameCharacter(codePointBefore(cursor)) && !isLeanNameCharacter(codePointAt(cursor + 5)) &&
        (includeAnonymousInstances || mode !== 'legacy-where' && isEmptyInstanceWhere(cursor))) {
        // A default-only instance ends here. Keep populated named instances on
        // their historical first-field := boundary so frozen hashes stay valid.
        proofStart = cursor;
        bodyOffset = cursor + 5;
        whereBody = true;
        break;
      } else if (
        value === '|' &&
        !hasTopLevelMatchType &&
        following !== '|' &&
        following !== '>' &&
        parenDepth === 0 &&
        bracketDepth === 0 &&
        braceDepth === 0 &&
        /^\s*$/u.test(source.slice(source.lastIndexOf('\n', cursor - 1) + 1, cursor)) &&
        hasEquationArrow(cursor)
      ) {
        // Equation clauses are the body itself, unlike the := separator.
        // Include the first pipe in the protected body; defaults, strings and
        // nested match expressions in binders were skipped above. A top-level
        // match return type stays on the established := path conservatively.
        proofStart = cursor;
        bodyOffset = cursor;
        break;
      }
      cursor += 1;
    }
    if (proofStart >= 0) {
      const startOffset = index;
      index = Math.max(bodyOffset, proofStart + 1);
      const header = source.slice(nameStart, proofStart);
      yield Object.freeze({
        startOffset,
        bodyOffset,
        // A := term may begin flush left on the next line, even after comments.
        firstTermOffset: !whereBody && source.startsWith(':=', proofStart) ? skipTrivia(bodyOffset) : bodyOffset,
        parametersOffset: nameEnd,
        whereBody,
        name,
        kind:
          keyword === 'theorem' || keyword === 'lemma' ? 'theorem' : keyword === 'instance' ? 'instance' : 'definition',
        get canonicalHeader() {
          return canonicalize(header);
        },
      });
    } else index = nameEnd;
  }
}

const leanSourceDeclarationCache = new Map<string, readonly LeanSourceDeclaration[]>();
const LEAN_SOURCE_DECLARATION_CACHE_MAX_ENTRIES = 128;

const cachedLeanSourceDeclarations = (source: string, mode: LeanDeclarationIndex = 'named'): readonly LeanSourceDeclaration[] => {
  const key = `${mode}:` + mathDigest(source);
  const cached = leanSourceDeclarationCache.get(key);
  if (cached) {
    leanSourceDeclarationCache.delete(key);
    leanSourceDeclarationCache.set(key, cached);
    return cached;
  }
  const declarations = Object.freeze([...leanSourceDeclarations(source, mode)]);
  leanSourceDeclarationCache.set(key, declarations);
  while (leanSourceDeclarationCache.size > LEAN_SOURCE_DECLARATION_CACHE_MAX_ENTRIES) {
    const oldest = leanSourceDeclarationCache.keys().next().value;
    if (oldest === undefined) break;
    leanSourceDeclarationCache.delete(oldest);
  }
  return declarations;
};

const sourceDeclarationHash = (declaration: LeanSourceDeclaration): string =>
  mathDigest(declaration.canonicalHeader);

export const declarationHashes = (source: string): Map<string, string> => {
  const hashes = new Map<string, string>();
  for (const declaration of cachedLeanSourceDeclarations(source)) {
    const declarationHash = sourceDeclarationHash(declaration);
    hashes.set(declaration.name, declarationHash);
    const local = declaration.name.split('.').at(-1);
    if (local && local !== declaration.name) hashes.set(local, declarationHash);
  }
  return hashes;
};

export const hashMathFormalSourceDeclaration = (formalStatement: string, theoremName: string): string | undefined => {
  const localRequestedName = theoremName.split('.').at(-1);
  for (const declaration of cachedLeanSourceDeclarations(formalStatement)) {
    const localDeclaredName = declaration.name.split('.').at(-1);
    if (declaration.name !== theoremName && localDeclaredName !== localRequestedName) continue;
    return sourceDeclarationHash(declaration);
  }
  return undefined;
};

/**
 * Return the named theorem, definition, and instance headers visible in a
 * Lean source file.
 * This is a read-only index primitive for bounded premise retrieval; it does
 * not execute Lean and therefore cannot be treated as proof evidence.
 */
export const inspectLeanDeclarations = (source: string): readonly MathematicsLeanSourceDeclaration[] =>
  Object.freeze(
    [...cachedLeanSourceDeclarations(source)].map(({ startOffset, name, kind, canonicalHeader }) =>
      Object.freeze({ startOffset, name, kind, declarationType: canonicalHeader })
    )
  );

/** Conservative source regions for construction edits; kernel verification remains independent. */
export const inspectLeanDeclarationRegions = (source: string) => {
  let cleaned: string | undefined;
  return cachedLeanSourceDeclarations(source).map(declaration => leanSourceDeclarationRegion(source, declaration,
    declaration.whereBody ? cleaned ??= maskLeanCommentsAndStrings(source) : undefined));
};

/** Read existing frozen records with their exact pre-fix boundaries; never used to prepare a new task. */
export function inspectLegacyLeanWhereSource(source: string) {
  const declarations = cachedLeanSourceDeclarations(source, 'legacy-where');
  return {
    declarations: scopedLeanDeclarations(source, declarations.map(({ startOffset, name, kind, canonicalHeader }) =>
      ({ startOffset, name, kind, declarationType: canonicalHeader }))),
    regions: declarations.map(declaration => leanSourceDeclarationRegion(source, declaration, undefined, declaration.bodyOffset)),
  };
}

function leanSourceDeclarationRegion(source: string, declaration: LeanSourceDeclaration, cleanedSource?: string,
  firstTermOffset = declaration.firstTermOffset) {
  const lineStart = source.lastIndexOf('\n', declaration.startOffset - 1) + 1;
  const indentation = source.slice(lineStart, declaration.startOffset).match(/^\s*/u)?.[0].length ?? 0;
  let endOffset = source.length;
  let cursor = source.indexOf('\n', firstTermOffset);
  while (cursor >= 0 && cursor + 1 < source.length) {
    const start = cursor + 1;
    const end = source.indexOf('\n', start);
    const line = source.slice(start, end < 0 ? undefined : end);
    const boundaryLine = declaration.whereBody ? cleanedSource!.slice(start, end < 0 ? undefined : end) : line;
    if (boundaryLine.trim() && !boundaryLine.trimStart().startsWith('--') &&
        (line.match(/^\s*/u)?.[0].length ?? 0) <= indentation &&
        (!declaration.whereBody || leanWhereCommand.test(boundaryLine.trimStart()))) {
      endOffset = start;
      break;
    }
    cursor = end;
  }
  return {
    name: declaration.name,
    startOffset: declaration.startOffset,
    declarationType: declaration.canonicalHeader,
    bodyOffset: declaration.bodyOffset,
    endOffset,
  };
}

/** Projection also tracks anonymous instances by source position, without inventing Lean names.
 * Named declaration, hash and construction-edit indexes retain their existing contract. */
export function inspectLeanProjectionDeclarations(source: string) {
  const cleaned = maskLeanCommentsAndStrings(source);
  const scopes: LeanScope[] = [], commands = leanScopeCommands(cleaned);
  const indexed = cachedLeanSourceDeclarations(source, 'projection').map(declaration => ({ declaration,
    region: leanSourceDeclarationRegion(source, declaration, cleaned) }));
  const openFrames: { namespace: string; command: string; startOffset: number; endOffset: number; local: boolean }[][] = [[]];
  let localOpens: typeof openFrames[number] = [], commandRegion = 0;
  let command = commands.next();
  return indexed.map(({ declaration, region }) => {
    while (!command.done && command.value.index < declaration.startOffset) {
      const current = command.value, kind = current[1]!, argument = current[2]?.trim() ?? '';
      command = commands.next();
      while (indexed[commandRegion] && indexed[commandRegion]!.region.endOffset <= current.index) commandRegion++;
      // `open ... in` inside a proof is local to its expression, never a later declaration's scope.
      if (indexed[commandRegion] && current.index >= indexed[commandRegion]!.region.startOffset) continue;
      if (kind === 'namespace' || kind === 'section' || kind === 'mutual') openFrames.push([]);
      else if (kind === 'end' && openFrames.length > 1) openFrames.pop();
      else if (kind === 'open' && !/^scoped\b/u.test(argument)) {
        const local = /\s+in\s*$/u.test(argument);
        const entry = { namespace: leanScopeNamespace(scopes), command: local ? argument.replace(/\s+in\s*$/u, '') : argument,
          startOffset: current.index, endOffset: current.index + current[0].length, local };
        if (local) localOpens.push(entry);
        else openFrames.at(-1)!.push(entry);
      }
      updateLeanScopes(scopes, kind, argument);
    }
    const namespace = leanScopeNamespace(scopes), name = declaration.name || undefined;
    const qualifiedName = name === undefined ? undefined : name.startsWith('_root_.') ? name.slice(7) :
      [namespace, name].filter(Boolean).join('.');
    const opens = [...openFrames.flat(), ...localOpens];
    localOpens = [];
    return { ...region, name, namespace, qualifiedName, opens, parametersOffset: declaration.parametersOffset };
  });
}
