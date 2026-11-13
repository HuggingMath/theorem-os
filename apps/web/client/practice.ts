import { h, render } from 'preact';
import { ResearchPractice } from './ResearchPractice';
import { locale, otherLocale } from '../i18n';

const explicit = new URLSearchParams(location.search).get('lang');
const language = explicit === 'zh' || explicit === 'en' ? explicit : locale;
const tx = (zh: string, en: string) => language === 'en' ? en : zh;
document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
document.title = tx('录制研究演练 · TheoremOS', 'Recorded research exercise · TheoremOS');
const root = document.getElementById('practice-root');
if (root) render(h(ResearchPractice, { language }), root);
const home = document.querySelector<HTMLAnchorElement>('[data-practice-home]');
if (home) { home.textContent = tx('打开工作台', 'Open the workbench'); home.href = `./?lang=${language}`; }
const languageLink = document.querySelector<HTMLAnchorElement>('[data-practice-language]');
if (languageLink) { languageLink.textContent = otherLocale.label; languageLink.href = `practice.html?lang=${otherLocale.locale}`; }
const skip = document.querySelector<HTMLAnchorElement>('.skip-link');
if (skip) skip.textContent = tx('跳到主要内容', 'Skip to main content');
