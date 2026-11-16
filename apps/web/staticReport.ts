import fs from 'node:fs';
import path from 'node:path';
import { writeMathFrozen } from '../../src/math/mathRuntimeIo';
import { assertMathCanonicalPath, isMathPathWithin } from '../../src/math/paths';
import type { WebExplanationReport, WebFormalizationReport } from './shared';

/**
 * Offline report pages: one HTML file that opens from disk with nothing to fetch. The page's template, its bundle, the
 * theme script, the stylesheet, the mark and the Latin fonts are inlined; the payload is embedded as JSON that the
 * bundle reads (leanPane.reportData). Chinese text uses system fonts, since the Noto subsets would add about 1.7 MB.
 * The workbench serves out/web; the formalization page is built to out/web-report, which nothing serves.
 */
export type StaticReportPage =
  | { page: 'explain'; data: WebExplanationReport }
  | { page: 'formalization'; data: WebFormalizationReport };

const templates = { explain: 'out/web', formalization: 'out/web-report' } as const;
const fonts = ['Geist-latin.woff2', 'InstrumentSerif-latin.woff2', 'JetBrainsMono.woff2'] as const;
/** Nothing loads from outside the file; the Markdown download of the explanation page is a blob: link. */
const policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'";

const bytes = (file: string) => {
  if (!fs.existsSync(file)) throw new Error(`static_report_build_missing: ${file} (run bun run build:web)`);
  return fs.readFileSync(file);
};
const read = (file: string) => bytes(file).toString('utf8');
const dataUri = (type: string, body: Buffer) => `data:${type};base64,${body.toString('base64')}`;
/** Replaces exactly one occurrence; a template that changed shape fails instead of shipping a page that loads nothing. */
function once(text: string, find: string, replacement: string): string {
  const at = text.indexOf(find);
  if (at < 0 || text.indexOf(find, at + 1) >= 0) throw new Error(`static_report_template_changed: ${find}`);
  return text.slice(0, at) + replacement + text.slice(at + find.length);
}
/** Text inside a <script> element must not close it or open a comment the parser would honour. */
function scriptText(text: string): string {
  if (/<\/script|<!--/iu.test(text)) throw new Error('static_report_script_unsafe');
  return text;
}
/** JSON for a <script type="application/json"> element; `<` and the line separators are escaped. */
export const embeddedJson = (value: unknown) =>
  JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

function stylesheet(web: string): string {
  let css = read(path.join(web, 'app.css'));
  // The Chinese faces are subsets of Noto; without them the font stacks fall back to the system's CJK fonts.
  css = css.split('\n').filter(line => !/^@font-face\{[^}]*NotoS(?:ans|erif)SC-/u.test(line)).join('\n');
  for (const font of fonts)
    css = once(css, `url("assets/fonts/${font}")`, `url("${dataUri('font/woff2', bytes(path.join(web, 'assets/fonts', font)))}")`);
  if (/url\(\s*(?!["']?data:)/iu.test(css)) throw new Error('static_report_stylesheet_reference');
  if (/<\/style/iu.test(css)) throw new Error('static_report_stylesheet_unsafe');
  return css;
}

function mathStylesheet(web: string): string {
  const directory = path.join(web, 'assets/katex');
  // Modern browsers use woff2; keep offline formula fonts inside the report's single file.
  const css = read(path.join(directory, 'katex.min.css')).replace(/src:url\(fonts\/([^()]+\.woff2)\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]+"\))*/gu,
    (_match, font: string) => `src:url("${dataUri('font/woff2', bytes(path.join(directory, 'fonts', font)))}") format("woff2")`);
  if (/url\(\s*(?!["']?data:)/iu.test(css) || /<\/style/iu.test(css)) throw new Error('static_report_math_stylesheet_reference');
  return css;
}

/** The report page as one self-contained HTML document. `root` is the repository, whose out/ holds the built pages. */
export function staticReportHtml(root: string, report: StaticReportPage): string {
  const web = path.join(root, 'out/web'), pages = path.join(root, templates[report.page]);
  const mark = dataUri('image/svg+xml', bytes(path.join(web, 'assets/mark.svg')));
  // The template's tags are swapped for placeholders and checked first, so nothing inlined is read as markup.
  const inlined: Record<string, string> = {
    theme: `<script>${scriptText(read(path.join(web, 'theme.js')))}</script>`,
    style: `<style>${stylesheet(web)}</style><style data-theoremos-math-style>${mathStylesheet(web)}</style>`,
    data: `<script type="application/json" id="report-data">${embeddedJson(report.data)}</script>`,
    bundle: `<script>${scriptText(read(path.join(web, 'math.js')))}</script><script>${scriptText(read(path.join(pages, `${report.page}.js`)))}</script>` };
  let html = read(path.join(pages, `${report.page}.html`));
  if (html.includes('\0')) throw new Error('static_report_template_changed');
  html = once(html, '<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="${policy}">`);
  html = once(html, '<link rel="icon" type="image/svg+xml" href="assets/mark.svg">', `<link rel="icon" type="image/svg+xml" href="${mark}">`);
  html = once(html, '<img src="assets/mark.svg"', `<img src="${mark}"`);
  html = once(html, '<script src="theme.js"></script>', '\0theme\0');
  html = once(html, '<link rel="stylesheet" href="app.css">', '\0style\0');
  html = once(html, `<script src="${report.page}.js" defer></script>`, '\0data\0\n  \0bundle\0');
  // Loaded resources only: the explanation page's links back to the workbench are hidden by its report mode.
  if (/\ssrc="(?!data:)|<link[^>]*\shref="(?!data:)/u.test(html)) throw new Error('static_report_reference');
  return html.replace(/\0(theme|style|data|bundle)\0/gu, (_match, name: string) => inlined[name]!);
}

/** Writes the page to a new file outside the repository; an existing file is never replaced. */
export function writeStaticReport(root: string, output: string, report: StaticReportPage): string {
  const file = path.resolve(output);
  assertMathCanonicalPath(file);
  if (isMathPathWithin(root, file)) throw new Error('Keep report files outside the source repository.');
  if (path.extname(file) !== '.html') throw new Error('static_report_output_not_html');
  if (fs.existsSync(file)) throw new Error('static_report_output_exists');
  writeMathFrozen(file, staticReportHtml(root, report));
  return file;
}
