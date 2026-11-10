import { describe, expect, it } from 'vitest';
import { embedBriefFonts, type BriefFontUsage } from '../apps/web/client/researchBriefFonts';
const usage = (families: string[], text: string, style = 'normal', weight = 400): BriefFontUsage => ({ families, text, style, weight });
const font = (family: string, file: string, extra = '') => `@font-face{font-family:${family};font-style:normal;font-weight:400;src:url(fonts/${file}.woff2) format("woff2"),url(fonts/${file}.woff) format("woff");${extra}}`;
describe('standalone brief font embedding', () => {
  it('embeds only faces needed by actual text, not unused KaTeX variants or other Unicode subsets', async () => {
    const css = font('KaTeX_Main', 'main') + font('KaTeX_Fraktur', 'unused') + font('Chinese', 'chinese', 'unicode-range:U+4E00-9FFF;') + font('Chinese', 'latin', 'unicode-range:U+00-FF;') + '.formula{color:inherit}';
    const requests: string[] = [];
    const result = await embedBriefFonts([{ css, url: 'https://local.invalid/assets/katex/katex.css' }], [usage(['KaTeX_Main'], 'x + 1'), usage(['Chinese'], '证明')], async url => { requests.push(url); return 'data:font/woff2;base64,AA=='; });
    expect(requests).toEqual(['https://local.invalid/assets/katex/fonts/main.woff2', 'https://local.invalid/assets/katex/fonts/chinese.woff2']);
    expect(result[0]).not.toContain('unused'); expect(result[0]).not.toContain('latin'); expect(result[0]).not.toContain('.woff)');
    expect(result[0]).toContain('.formula{color:inherit}'); expect(result[0].match(/data:font\/woff2/gu)).toHaveLength(2);
  });
  it('selects italic/bold math and variable body weights, preserves descriptors, and resolves each sheet relative to its own location', async () => {
    const body = '@font-face{font-family:"Body Face";font-style:normal;font-weight:100 900;src:url("assets/body.woff2") format("woff2")}';
    const math = font('KaTeX_Main', 'regular') + font('KaTeX_Main', 'bold-italic').replace('font-style:normal', 'font-style:italic').replace('font-weight:400', 'font-weight:700');
    const requests: string[] = [];
    const result = await embedBriefFonts([{ css: body, url: 'https://local.invalid/app.css' }, { css: math, url: 'https://local.invalid/assets/katex/style.css' }], [usage(['Body Face'], 'Body', 'normal', 600), usage(['KaTeX_Main'], 'x', 'italic', 700)], async url => { requests.push(url); return 'data:font/woff2;base64,AA=='; });
    expect(requests).toEqual(['https://local.invalid/assets/body.woff2', 'https://local.invalid/assets/katex/fonts/bold-italic.woff2']);
    expect(result[0]).toContain('font-weight:100 900'); expect(result[1]).not.toContain('fonts/regular'); expect(result[1]).toContain('font-style:italic');
  });
  it('rejects a failed font read instead of producing a silently incomplete export', async () => {
    await expect(embedBriefFonts([{ css: font('KaTeX_Main', 'main'), url: 'https://local.invalid/style.css' }], [usage(['KaTeX_Main'], 'x')], async () => { throw new Error('font unavailable'); })).rejects.toThrow('font unavailable');
  });
});
