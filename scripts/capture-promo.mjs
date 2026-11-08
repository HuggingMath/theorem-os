import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
try {
  const cards = [
    { lang: 'zh-CN', page: 'out/site/index.html', output: 'social-preview.png',
      description: '数学研究与 Lean 证明工作台', access: '申请内测' },
    { lang: 'en', page: 'out/site/en/index.html', output: 'social-preview-en.png',
      description: 'A workspace for mathematical research and Lean proofs', access: 'Request access' },
  ];
  const mark = fs.readFileSync(path.join(root, 'docs/assets/mark.svg')).toString('base64');
  const css = fs.readFileSync(path.join(root, 'out/site/landing.css'), 'utf8');
  for (const card of cards) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, reducedMotion: 'reduce' });
    await page.goto(pathToFileURL(path.join(root, card.page)).href);
    const title = await page.locator('#hero-title').innerHTML();
    // Share cards use native type and the tutorial's add-zero identity, keeping text crisp at preview size.
    await page.setContent(`<!doctype html><html lang="${card.lang}"><meta charset="utf-8"><style>${css}
      body{width:1200px;height:630px;overflow:hidden;background:var(--bg);color:var(--ink)}
      .social{height:630px;padding:48px 60px;display:flex;flex-direction:column;justify-content:space-between}
      .social-top,.social-bottom{display:flex;align-items:center;justify-content:space-between;gap:40px}
      .social .brand{font-size:30px;gap:12px}.social .brand img{width:36px;height:36px}
      .social-domain{font-size:22px}
      .social-main{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center}
      .social h1{font-size:62px;line-height:1.18;letter-spacing:-.02em}
      .social-proof{height:276px;background:var(--tool);color:var(--tool-ink);display:flex;align-items:center;justify-content:center;border-radius:var(--radius)}
      .social-proof p{font-family:var(--serif);font-size:86px;line-height:1.2;white-space:nowrap}
      .social-description{font-size:20px;max-width:38em}
      .social-access{font-size:18px;background:var(--accent);color:var(--accent-ink);padding:14px 24px;border-radius:var(--radius);white-space:nowrap}
    </style><body><div class="social"><div class="social-top"><div class="brand"><img src="data:image/svg+xml;base64,${mark}" alt=""><span>TheoremOS</span></div><span class="social-domain">theoremos.top</span></div><div class="social-main"><h1>${title}</h1><div class="social-proof"><p>n + 0 = n</p></div></div><div class="social-bottom"><p class="social-description">${card.description}</p><span class="social-access">${card.access} ↗</span></div></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(root, 'docs/assets', card.output) });
    await page.close();
    console.log(`Generated docs/assets/${card.output} with native typography and no embedded screenshots.`);
  }
} finally {
  await browser.close();
}
