import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browser = await chromium.launch();
try {
  // The workbench interface is Chinese, so the English card shows the English verification replay instead.
  const cards = [
    { locale: 'zh', lang: 'zh-CN', page: 'out/site/index.html', output: 'social-preview.png', tagline: '数学研究运行时',
      footer: '在线工作台即将开放 · Lean 4 + Mathlib · 自备模型 Key', alt: '工作台草稿预览' },
    { locale: 'en', lang: 'en', page: 'out/site/en/index.html', output: 'social-preview-en.png', tagline: 'Research runtime for mathematics',
      footer: 'Online workbench opening soon · Lean 4 + Mathlib · Bring your own key', alt: 'Verification replay' },
  ];
  const mark = fs.readFileSync(path.join(root, 'docs/assets/mark.svg')).toString('base64');
  const css = fs.readFileSync(path.join(root, 'out/site/landing.css'), 'utf8');
  for (const card of cards) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, reducedMotion: 'reduce' });
    await page.goto(pathToFileURL(path.join(root, card.page)).href);
    const title = await page.locator('#hero-title').innerHTML();
    const category = await page.locator('.hero-category').innerText();
    const description = await page.locator('.hero-description').innerText();
    let product = fs.readFileSync(path.join(root, 'docs/assets/workbench-desktop.png'));
    if (card.locale === 'en') {
      await page.setViewportSize({ width: 1124, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const replay = page.locator('.replay-window');
      await replay.scrollIntoViewIfNeeded();
      const box = await replay.boundingBox();
      product = await page.screenshot({ clip: { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, box.width * 500 / 1440) } });
    }
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(`<!doctype html><html lang="${card.lang}"><meta charset="utf-8"><style>${css}
    body{width:1200px;height:630px;overflow:hidden;background:var(--bg);color:var(--ink)}
    .social{position:relative;height:630px;padding:28px 70px}
    .social-top{display:flex;align-items:center;justify-content:space-between}
    .social .brand{font-size:16px;gap:12px}.social .brand img{width:28px;height:28px}
    .preview{font-size:14px;color:var(--muted)}
    .social h1{font-size:72px;line-height:1.1;margin:12px 0 7px}
    .social-category{font-size:22px;line-height:1.5}
    .social-description{font-size:16px;margin-top:3px}
    .social-product{position:absolute;left:70px;right:70px;top:225px}
    .social-product img{width:100%;height:auto}
    .social-bottom{position:absolute;left:70px;right:70px;bottom:10px;display:flex;justify-content:space-between;font-size:13px;color:var(--muted)}
  </style><body><div class="social"><div class="social-top"><div class="brand"><img src="data:image/svg+xml;base64,${mark}" alt=""><span>${card.tagline}</span></div><span class="preview">v0.1.0 · Research Preview</span></div><h1>${title}</h1><p class="social-category">${category}</p><p class="social-description">${description}</p><div class="social-product"><img src="data:image/png;base64,${product.toString('base64')}" alt="${card.alt}"></div><div class="social-bottom"><span>${card.footer}</span><span>likc1606.github.io/theorem-os-site</span></div></div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.locator('.social-product img').evaluate(image => image.decode());
    await page.screenshot({ path: path.join(root, 'docs/assets', card.output) });
    await page.close();
    console.log(`Generated docs/assets/${card.output} from the homepage typography.`);
  }
} finally {
  await browser.close();
}
