import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { researchExamples } from '../apps/web/problemExamples';

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

/** Sources bundled for the browser, where interface text uses t() or a checked tx() language pair. */
export function bundleSources() {
  const client = fs.readdirSync(web('client'), { recursive: true, encoding: 'utf8' })
    .filter(name => /\.tsx?$/u.test(name) && !/\.test\./u.test(name)).map(name => web('client', name));
  return [...client, web('formalizationReasons.ts'), web('presentation.ts'), web('report.ts')].sort();
}

// These existing tables feed tx() with a Chinese/English pair rather than literal arguments.
const bilingualTables = new Map([
  ['apps/web/client/researchShared.tsx', 'statusNames'],
  ['apps/web/client/researchViews.tsx', 'pageNames'],
  ['apps/web/client/researchFeedback.tsx', 'statuses'],
  ['apps/web/client/researchProblem.tsx', 'labels'],
]);

/** Dictionary keys, plus interface text without a dictionary entry or an inline English counterpart. */
export function scanBundle(files = bundleSources()) {
  const keys = new Map<string, string>(), stray: string[] = [];
  for (const file of files) {
    const source = parse(file);
    const relative = path.relative(root, file);
    const where = (node: ts.Node) => `${relative}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;
    const addKey = (key: ts.StringLiteralLike) => { if (!keys.has(key.text)) keys.set(key.text, where(key)); };
    const formalizationReasons = relative === 'apps/web/formalizationReasons.ts';
    const visit = (node: ts.Node) => {
      // This shared module looks up stop reasons before translating them in the browser or on the server.
      if (formalizationReasons && ts.isVariableDeclaration(node) && node.name.getText(source) === 'reasons'
          && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
        for (const property of node.initializer.properties) {
          if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) addKey(property.initializer);
          else visit(property);
        }
        return;
      }
      if (ts.isVariableDeclaration(node) && bilingualTables.get(relative) === node.name.getText(source) && node.initializer) {
        const pairs = (value: ts.Node) => {
          if (ts.isArrayLiteralExpression(value) && value.elements.every(ts.isStringLiteralLike)) {
            const english = value.elements.at(-1);
            if (value.elements.length < 2 || !english || !ts.isStringLiteralLike(english) || !english.text.trim() || han.test(english.text))
              stray.push(`${where(value)} bilingual table needs a nonempty English label`);
          } else ts.forEachChild(value, pairs);
        };
        pairs(node.initializer);
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'tx') {
        const [chinese, english] = node.arguments;
        if (chinese && ts.isSpreadElement(chinese)) { visit(chinese.expression); return; }
        if (!chinese || !english) stray.push(`${where(node)} tx() needs both language values`);
        // Static Chinese belongs to this pair; interpolated expressions still need their own translation.
        if (chinese && ts.isTemplateExpression(chinese)) chinese.templateSpans.forEach(span => visit(span.expression));
        else if (chinese && !ts.isStringLiteralLike(chinese)) visit(chinese);
        if (english && ts.isStringLiteralLike(english) && !english.text.trim()) stray.push(`${where(english)} tx() needs nonempty English`);
        if (english) visit(english);
        return;
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 't'
          || formalizationReasons && ['translate', 'tOverride'].includes(node.expression.text))) {
        const [key, ...rest] = node.arguments;
        if (key && ts.isStringLiteralLike(key)) addKey(key);
        else if (formalizationReasons && node.expression.text === 'tOverride' && key && ts.isConditionalExpression(key)
            && key.whenTrue.getText(source) === 'reasons[key]' && ts.isStringLiteralLike(key.whenFalse)) addKey(key.whenFalse);
        else stray.push(`${where(node)} ${node.expression.text}() needs a literal key`);
        rest.forEach(visit);
        return;
      }
      const literal = ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node) || ts.isJsxText(node);
      if (literal && han.test(node.getText(source)) && !allowed(node.getText(source), relative)) stray.push(`${where(node)} ${node.getText(source).slice(0, 80)}`);
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
const allowedText = new Set(['/会话/u', '/[，,\\s]+/u', '/[,，\\n]/u', "'会话校验'", '} 亿`', '} 万`',
  "'language locale english chinese 语言 中文 英文'",
  "'classic problems proofs solutions archive library 经典 题库 数学 解答 过程'",
  "'formalization translation natural language 形式化 转换 回译 自然语言'",
  "'formalize formalization natural language tex 形式化 转换 自然语言 原题'",
  "'statement review translation intent 原意 声明 审阅 回译 转换 自然语言'",
  "'explain proof natural language 讲解 解释 证明 转换 自然语言'",
  "'knowledge search library 知识 检索 知识库'", "'archive records 归档 记录'", "'guidance feedback history 指导 历史 人工'",
  "'roadmap trajectory steps timeline route 研究路线图 轨迹 步骤 过程 路线'",
  "'collaboration agents plan tasks dependencies reviews 协作 计划 任务 分工 依赖 审阅 Agent'"]);
// These patterns and phrases normalize the saved proof text in its own language.
const savedExplanationText = new Set([
  "'|(迹条件|维数条件|交换条件|交换性|假设|条件|等式|不等式|结论)'",
  "`(?![ \\t]*(?:是|为|表示|代表))([ \\t]+说)?`",
  "/[ \\t]说$/u",
  "'维数等式'", "'假设'", "'由题设可知，'",
]);
const allowed = (text: string, file: string) => allowedText.has(text)
  || (file === 'apps/web/client/readableExplanation.ts' && savedExplanationText.has(text));

/** Text nodes and readable attributes of the static pages, with whitespace collapsed as localizeDocument does. */
export function pageKeys() {
  const keys = new Map<string, string>();
  const decode = (value: string) => value.replace(/&nbsp;/gu, ' ').replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"').replace(/&#39;/gu, "'").replace(/&amp;/gu, '&');
  for (const name of ['index.html', 'login.html', 'share.html', 'guide.html', 'terms.html', 'privacy.html', 'explain.html', 'formalization.html', 'formalize.html']) {
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
  for (const example of researchExamples) for (const value of [example.name, example.task]) keys.set(value, 'apps/web/problemExamples.ts');
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
  // Project event titles are also shown in the activity feed.
  const projectFile = 'apps/web/researchProjects.ts', projectSource = parse(path.join(root, projectFile));
  const projectEvents = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.expression.getText(projectSource) === 'this.event') {
      const title = node.arguments[3];
      if (title && ts.isStringLiteralLike(title) && han.test(title.text)) keys.set(title.text, projectFile);
    }
    ts.forEachChild(node, projectEvents);
  };
  projectEvents(projectSource);
  return keys;
}

/**
 * Error messages the server sends as `{ error }` or stores as a run's error, which the client shows through
 * localizeMessage. A template literal becomes a key with {0}, {1}… in place of its values; a message that only passes
 * on another error's text adds nothing.
 */
export function errorKeys() {
  const keys = new Map<string, string>();
  const files = ['apps/web/shared.ts', 'apps/web/conversations.ts', 'apps/web/formalizations.ts', 'apps/web/server.ts', 'apps/web/paperDrafts.ts', 'apps/web/jobs.ts', 'apps/web/storage.ts', 'apps/web/auth.ts', 'apps/web/explain.ts', 'apps/web/quota.ts', 'apps/web/admission.ts', 'apps/web/providerCheck.ts',
    'apps/web/runner.ts', 'apps/web/worker.ts', 'apps/web/moduleRegistry.ts', 'apps/web/knowledgeService.ts', 'apps/web/researchProjects.ts', 'apps/web/researchAssets.ts', 'apps/web/researchApi.ts', 'apps/web/researchMathematics.ts', 'apps/web/researchCandidateScope.ts', 'apps/web/researchAssetPrefill.ts', 'apps/web/researchLibraryTrials.ts', 'apps/web/researchProblems.ts', 'apps/web/researchMathExamples.ts',
    'apps/web/researchBudgets.ts', 'apps/web/researchPersonal.ts', 'apps/web/researchJourney.ts', 'apps/web/researchProjectStart.ts',
    'apps/web/sharedProofs.ts', 'apps/web/researchCollections.ts', 'apps/web/researchCollaborationApi.ts', 'apps/web/researchMode.ts', 'apps/web/nativeTeamProfiles.ts'];
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
      if (relative === 'apps/web/shared.ts' && ts.isVariableDeclaration(node) &&
        /^retired.*Message$/u.test(node.name.getText(source)) && node.initializer) collect(node.initializer);
      else if (ts.isNewExpression(node) && /Error$/u.test(node.expression.getText(source))) node.arguments?.forEach(collect);
      else if (['apps/web/researchAssets.ts', 'apps/web/researchApi.ts', 'apps/web/researchMathematics.ts', 'apps/web/researchAssetPrefill.ts', 'apps/web/researchLibraryTrials.ts', 'apps/web/researchPersonal.ts', 'apps/web/researchJourney.ts', 'apps/web/sharedProofs.ts'].includes(relative) && ts.isCallExpression(node) && node.expression.getText(source) === 'fail' && node.arguments[1]) collect(node.arguments[1]);
      else if (relative === 'apps/web/researchLibraryTrials.ts' && ts.isPropertyAssignment(node) && ['incompatibility', 'error'].includes(node.name.getText(source))) collect(node.initializer);
      else if (relative === 'apps/web/researchLibraryTrials.ts' && ts.isVariableDeclaration(node) && node.name.getText(source) === 'reason' && node.initializer) collect(node.initializer);
      else if (relative === 'apps/web/researchAssets.ts' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'reason') collect(node.initializer);
      else if (relative === 'apps/web/researchApi.ts' && ts.isBinaryExpression(node) && node.left.getText(source) === 'reason') collect(node.right);
      else if (relative === 'apps/web/researchApi.ts' && ts.isVariableDeclaration(node) && node.name.getText(source) === 'reason' && node.initializer) collect(node.initializer);
      else if (relative === 'apps/web/researchCandidateScope.ts' && ts.isReturnStatement(node) && node.expression) collect(node.expression);
      else if (relative === 'apps/web/researchMode.ts' && ts.isReturnStatement(node) && node.expression) collect(node.expression);
      else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && /\.error$/u.test(node.left.getText(source))) collect(node.right);
      else if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'error') collect(node.initializer);
      else if (relative === 'apps/web/providerCheck.ts' && ts.isPropertyAssignment(node) && node.name.getText(source) === 'message') collect(node.initializer);
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
