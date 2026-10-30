import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * Lists the Chinese interface text the English dictionary (apps/web/i18n/en.ts) must cover: t() keys in the browser
 * bundles, static page markup, the server text the client shows through localizeText, and the server's error messages,
 * which it shows through localizeMessage. Agent output stays as written. `bun scripts/web-i18n.ts` prints keys without
 * an English entry.
 */
const root = path.resolve(import.meta.dirname, '..');
export const han = /[　-〿一-鿿＀-￯]/u;
const web = (...parts: string[]) => path.join(root, 'apps/web', ...parts);
const read = (file: string) => fs.readFileSync(file, 'utf8');
const parse = (file: string) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

/** Sources bundled for the browser, where Chinese text is only allowed as a t() key. */
export function bundleSources() {
  const client = fs.readdirSync(web('client'), { recursive: true, encoding: 'utf8' })
    .filter(name => /\.tsx?$/u.test(name) && !/\.test\./u.test(name)).map(name => web('client', name));
  return [...client, web('presentation.ts'), web('report.ts')].sort();
}

/** Every t('…') key, with the source line, plus any Chinese literal outside t() that is not on the allow list. */
export function scanBundle(files = bundleSources()) {
  const keys = new Map<string, string>(), stray: string[] = [];
  for (const file of files) {
    const source = parse(file);
    const where = (node: ts.Node) => `${path.relative(root, file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
        const [key, ...rest] = node.arguments;
        if (key && ts.isStringLiteralLike(key)) { if (!keys.has(key.text)) keys.set(key.text, where(key)); }
        else stray.push(`${where(node)} t() needs a literal key`);
        rest.forEach(visit);
        return;
      }
      const literal = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node) || ts.isJsxText(node);
      if (literal && han.test(node.getText(source)) && !allowed(node, source)) stray.push(`${where(node)} ${node.getText(source).slice(0, 80)}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { keys, stray };
}

/**
 * Chinese literals that are not interface text: checks against server messages, the CJK-aware list separator, the
 * Chinese token units (English uses K/M), and the language switch's search keywords, which match in both languages.
 */
const allowedText = new Set(['/会话/u', '/[，,\\s]+/u', "'会话校验'", '} 亿`', '} 万`',
  "'language locale english chinese 语言 中文 英文'"]);
const allowed = (node: ts.Node, source: ts.SourceFile) => allowedText.has(node.getText(source));

/** Text nodes and readable attributes of the static pages, with whitespace collapsed as localizeDocument does. */
export function pageKeys() {
  const keys = new Map<string, string>();
  const decode = (value: string) => value.replace(/&nbsp;/gu, ' ').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');
  for (const name of ['index.html', 'login.html', 'share.html', 'guide.html', 'explain.html']) {
    const markup = read(web('client', name)).replace(/<(script|style)\b[\s\S]*?<\/\1>/giu, '').replace(/<!--[\s\S]*?-->/gu, '');
    const add = (value: string) => { const key = decode(value).trim().replace(/\s+/gu, ' '); if (han.test(key) && !keys.has(key)) keys.set(key, name); };
    for (const match of markup.matchAll(/>([^<]+)</gu)) add(match[1]);
    for (const match of markup.matchAll(/\s(?:aria-label|title|placeholder|alt|content|aria-description|data-label)="([^"]*)"/gu)) add(match[1]);
    const title = /<title>([^<]*)<\/title>/u.exec(markup);
    if (title) add(title[1]);
  }
  return keys;
}

/**
 * Chinese text the server stores or sends that the client passes through localizeText: event messages, runtime status,
 * template and environment names, share labels, module names, module-plan validation, and the sample run. Errors are
 * left to errorKeys.
 */
export function serverKeys() {
  const keys = new Map<string, string>();
  const files = ['apps/web/progress.ts', 'apps/web/jobs.ts', 'apps/web/runner.ts', 'apps/web/config.ts', 'apps/web/share.ts', 'apps/web/moduleRegistry.ts', 'src/solver/modules/policy.ts', 'scripts/build-web-sample.ts'];
  for (const relative of files) {
    const source = parse(path.join(root, relative));
    const visit = (node: ts.Node) => {
      if (ts.isThrowStatement(node) || ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(source))) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.error$/u.test(node.left.getText(source))) return;
      if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'error') return;
      if (ts.isStringLiteralLike(node) && han.test(node.text) && !keys.has(node.text))
        keys.set(node.text, `${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return keys;
}

/**
 * Error messages the server sends as `{ error }` or stores as a run's error, which the client shows through
 * localizeMessage. A template literal becomes a key with {0}, {1}… in place of its values; a message that only passes
 * on another error's text adds nothing.
 */
export function errorKeys() {
  const keys = new Map<string, string>();
  const files = ['apps/web/server.ts', 'apps/web/jobs.ts', 'apps/web/storage.ts', 'apps/web/auth.ts', 'apps/web/explain.ts',
    'apps/web/runner.ts', 'apps/web/worker.ts', 'apps/web/moduleRegistry.ts', 'apps/web/knowledgeService.ts'];
  for (const relative of files) {
    const source = parse(path.join(root, relative));
    const add = (node: ts.Node, text: string) => {
      if (han.test(text) && !keys.has(text)) keys.set(text, `${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`);
    };
    const collect = (node: ts.Node) => {
      if (ts.isStringLiteralLike(node)) add(node, node.text);
      else if (ts.isTemplateExpression(node))
        add(node, node.head.text + node.templateSpans.map((span, index) => `{${index}}${span.literal.text}`).join(''));
      else ts.forEachChild(node, collect);
    };
    // Besides error constructors, `.error =` and `error:`: the worker's `{ type: 'error', message }` and the explain
    // service's table of provider statuses.
    const visit = (node: ts.Node) => {
      if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(source))) node.arguments?.forEach(collect);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.error$/u.test(node.left.getText(source))) collect(node.right);
      else if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'error') collect(node.initializer);
      else if (ts.isObjectLiteralExpression(node) && node.properties.some(item => ts.isPropertyAssignment(item) && item.name.getText(source) === 'type'
        && item.initializer.getText(source) === "'error'")) {
        for (const item of node.properties) if (ts.isPropertyAssignment(item) && item.name.getText(source) === 'message') collect(item.initializer);
      } else if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'upstreamStatus' && node.initializer) collect(node.initializer);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return keys;
}

export function requiredKeys() {
  const { keys, stray } = scanBundle();
  return { keys: new Map([...errorKeys(), ...serverKeys(), ...pageKeys(), ...keys]), stray };
}

if (import.meta.main) {
  const { en } = await import('../apps/web/i18n/en');
  const { keys, stray } = requiredKeys();
  const missing = [...keys].filter(([key]) => !Object.hasOwn(en, key));
  for (const line of stray) console.log(`stray ${line}`);
  if (process.argv.includes('--json')) console.log(JSON.stringify(Object.fromEntries(missing), null, 1));
  else for (const [key, where] of missing) console.log(`${where}\t${JSON.stringify(key)}`);
  console.error(`${keys.size} keys, ${missing.length} missing, ${stray.length} stray`);
}
