import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { embeddedJson, staticReportHtml, writeStaticReport, type StaticReportPage } from '../apps/web/staticReport';

// A synthetic out/ in the shape bun run build:web writes; these test the inlining contract, not the real pages.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const page = (name: string, extra = '') => ['<!doctype html>', '<html lang="zh-CN">', '<head>', '  <meta charset="utf-8">',
  `  <title>${name}</title>`, '  <link rel="icon" type="image/svg+xml" href="assets/mark.svg">', '  <script src="theme.js"></script>',
  '  <link rel="stylesheet" href="app.css">', '</head>', '<body>', '  <a class="brand" href="./"><img src="assets/mark.svg" alt=""></a>',
  `  <main id="main"></main>${extra}`, `  <script src="${name}.js" defer></script>`, '</body>', '</html>', ''].join('\n');
const face = (family: string, file: string) => `@font-face{font-family:${family};src:url("assets/fonts/${file}") format("woff2")}`;
const CSS = [face('Inter', 'InterVariable-latin.woff2'), face('"TheoremOS Sans SC"', 'NotoSansSC-ui.woff2'),
  face('"TheoremOS Serif Latin"', 'TheoremOSSerif-latin.woff2'), face('"TheoremOS Serif SC"', 'NotoSerifSC-common.woff2'),
  face('"JetBrains Mono"', 'JetBrainsMono.woff2'), 'body{background:url(data:image/png;base64,AA==)}.lean{font-family:"JetBrains Mono"}', ''].join('\n');

function build(edit: Record<string, string | null> = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'static-report-'))); roots.push(root);
  const files: Record<string, string | null> = {
    'out/web/theme.js': 'document.documentElement.dataset.theme = "light";', 'out/web/app.css': CSS,
    'out/web/assets/mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'out/web/assets/fonts/InterVariable-latin.woff2': 'inter', 'out/web/assets/fonts/TheoremOSSerif-latin.woff2': 'serif',
    'out/web/assets/fonts/JetBrainsMono.woff2': 'mono', 'out/web/assets/fonts/NotoSansSC-ui.woff2': 'noto',
    'out/web/explain.html': page('explain'), 'out/web/explain.js': 'window.explainBundle = 1;',
    'out/web-report/formalization.html': page('formalization'), 'out/web-report/formalization.js': 'window.formalizationBundle = 1;',
    ...edit };
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}
// A payload that would end its script element or break a JavaScript string if it were embedded raw.
const PAYLOAD = { title: '</script><script>alert(1)</script>', note: 'a\u2028b\u2029c <!-- d', formula: '$a < b$' };
const formalization = { page: 'formalization', data: PAYLOAD } as unknown as StaticReportPage;
const payloadOf = (html: string) => JSON.parse(/<script type="application\/json" id="report-data">([^<]*)<\/script>/u.exec(html)![1]!);
const base64 = (text: string) => Buffer.from(text).toString('base64');

describe('static report pages', () => {
  it('inlines the page into one file that loads nothing from outside it', () => {
    const html = staticReportHtml(build(), formalization);
    expect(html).toContain(`<meta charset="utf-8">\n  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; ` +
      `script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:; base-uri 'none'; form-action 'none'">`);
    expect(html).toContain('<script>document.documentElement.dataset.theme = "light";</script>');
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,${base64('<svg xmlns="http://www.w3.org/2000/svg"/>')}">`);
    expect(html).toContain('<img src="data:image/svg+xml;base64,');
    for (const [file, body] of [['InterVariable-latin', 'inter'], ['TheoremOSSerif-latin', 'serif'], ['JetBrainsMono', 'mono']]) {
      expect(html).toContain(`url("data:font/woff2;base64,${base64(body!)}")`);
      expect(html).not.toContain(file);
    }
    // The Chinese faces are dropped, so the fallback stacks use system fonts.
    expect(html).not.toContain('NotoS');
    expect(html).toContain('.lean{font-family:"JetBrains Mono"}');
    expect(html).toMatch(/<script type="application\/json" id="report-data">[^<]*<\/script>\n {2}<script>window\.formalizationBundle = 1;<\/script>/u);
    expect(html).not.toMatch(/\ssrc="(?!data:)|<link[^>]*\shref="(?!data:)/u);
    expect(html.match(/<script/gu)).toHaveLength(3);
    expect(payloadOf(html)).toEqual(PAYLOAD);
  });

  it('builds the explanation page from out/web and the formalization page from out/web-report', () => {
    const root = build();
    expect(staticReportHtml(root, { page: 'explain', data: { title: 'x' } } as unknown as StaticReportPage)).toContain('window.explainBundle = 1;');
    expect(staticReportHtml(root, formalization)).not.toContain('window.explainBundle');
  });

  it('escapes what would end the data element or a script string', () => {
    const json = embeddedJson(PAYLOAD);
    expect(json).not.toMatch(/[<\u2028\u2029]/u);
    expect(json).toContain('\\u003c/script>');
    expect(JSON.parse(json)).toEqual(PAYLOAD);
  });
  it.each([
    ['a missing bundle', { 'out/web-report/formalization.js': null }, /^static_report_build_missing: .*\/out\/web-report\/formalization\.js \(run bun run build:web\)$/u],
    ['a missing font', { 'out/web/assets/fonts/JetBrainsMono.woff2': null }, /^static_report_build_missing: .*JetBrainsMono\.woff2/u],
    ['a missing mark', { 'out/web/assets/mark.svg': null }, /^static_report_build_missing: .*mark\.svg/u],
    ['a bundle tag that changed', { 'out/web-report/formalization.html': page('formalization').replace(' defer>', '>') },
      'static_report_template_changed: <script src="formalization.js" defer></script>'],
    ['a second mark image', { 'out/web-report/formalization.html': page('formalization', '<img src="assets/mark.svg">') },
      'static_report_template_changed: <img src="assets/mark.svg"'],
    ['another loaded script', { 'out/web-report/formalization.html': page('formalization', '<script src="extra.js"></script>') }, 'static_report_reference'],
    ['another loaded stylesheet', { 'out/web-report/formalization.html': page('formalization', '<link rel="preload" href="font.woff2">') },
      'static_report_reference'],
    ['a bundle that closes its script', { 'out/web-report/formalization.js': 'const tag = "</SCRIPT>";' }, 'static_report_script_unsafe'],
    ['a theme script that opens a comment', { 'out/web/theme.js': 'if (a <!-- b) {}' }, 'static_report_script_unsafe'],
    ['a stylesheet asset', { 'out/web/app.css': CSS + '.x{background:url(assets/grain.png)}' }, 'static_report_stylesheet_reference'],
    ['a quoted stylesheet asset', { 'out/web/app.css': CSS + '.x{background:url( "assets/grain.png")}' }, 'static_report_stylesheet_reference'],
    ['a font referenced twice', { 'out/web/app.css': CSS + face('Inter', 'InterVariable-latin.woff2') },
      'static_report_template_changed: url("assets/fonts/InterVariable-latin.woff2")'],
    ['a stylesheet that closes its element', { 'out/web/app.css': CSS + '/* </style> */' }, 'static_report_stylesheet_unsafe'],
  ])('refuses to build a page with %s', (_name, edit, error) => {
    expect(() => staticReportHtml(build(edit), formalization)).toThrow(error);
  });

  it('writes a new read-only file outside the repository and never replaces one', () => {
    const root = build(), reports = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'static-report-out-'))); roots.push(reports);
    const output = path.join(reports, 'proof.html');
    expect(writeStaticReport(root, output, formalization)).toBe(output);
    expect(fs.readFileSync(output, 'utf8')).toBe(staticReportHtml(root, formalization));
    expect(fs.statSync(output).mode & 0o777).toBe(0o400);
    expect(() => writeStaticReport(root, output, formalization)).toThrow('static_report_output_exists');
    expect(() => writeStaticReport(root, path.join(root, 'report.html'), formalization)).toThrow('Keep report files outside the source repository.');
    expect(() => writeStaticReport(root, path.join(reports, 'proof.htm'), formalization)).toThrow('static_report_output_not_html');
    // A build that fails leaves no file behind.
    fs.rmSync(path.join(root, 'out/web/theme.js'));
    expect(() => writeStaticReport(root, path.join(reports, 'broken.html'), formalization)).toThrow('static_report_build_missing');
    expect(fs.readdirSync(reports)).toEqual(['proof.html']);
    // A link outside the repository that leads into it is refused before anything is read.
    fs.symlinkSync(root, path.join(reports, 'repo'));
    expect(() => writeStaticReport(root, path.join(reports, 'repo', 'report.html'), formalization)).toThrow('math_path_invalid');
    expect(fs.readdirSync(root).toSorted()).toEqual(['out']);
  });
});
