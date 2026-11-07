import { afterEach, describe, expect, it, vi } from 'vitest';
import { admin } from '../apps/web/i18n/admin';
import { app } from '../apps/web/i18n/app';
import { collaboration } from '../apps/web/i18n/collaboration';
import { common } from '../apps/web/i18n/common';
import { editor } from '../apps/web/i18n/editor';
import { en } from '../apps/web/i18n/en';
import { errors } from '../apps/web/i18n/errors';
import { explain } from '../apps/web/i18n/explain';
import { formalize } from '../apps/web/i18n/formalize';
import { guide } from '../apps/web/i18n/guide';
import { modules } from '../apps/web/i18n/modules';
import { pages } from '../apps/web/i18n/pages';
import { process } from '../apps/web/i18n/process';
import { server } from '../apps/web/i18n/server';
import { localizeText, t } from '../apps/web/i18n';
import { han, requiredKeys } from '../scripts/web-i18n';

describe('workbench English dictionary', () => {
  const parts = { server, pages, common, app, collaboration, modules, editor, guide, admin, errors, explain, formalize, process };
  const { keys, stray } = requiredKeys();
  const placeholders = (text: string) => [...text.matchAll(/\{(\d+)\}/gu)].map(match => match[1]).sort().join(',');

  it('covers every Chinese interface string, with no Chinese text outside t()', () => {
    expect(stray).toEqual([]);
    expect([...keys].filter(([key]) => !Object.hasOwn(en, key)).map(([key, where]) => `${where} ${key}`)).toEqual([]);
  });

  it('has English values with the same placeholders as their keys', () => {
    expect(Object.entries(en).filter(([, value]) => han.test(value) || !value.trim())).toEqual([]);
    expect(Object.entries(en).filter(([key, value]) => placeholders(key) !== placeholders(value))).toEqual([]);
  });

  it('keeps each key in one part and drops entries nothing uses', () => {
    const seen = new Map<string, string>(), duplicates: string[] = [];
    for (const [name, part] of Object.entries(parts)) for (const key of Object.keys(part)) {
      if (seen.has(key)) duplicates.push(`${key} (${seen.get(key)}, ${name})`);
      seen.set(key, name);
    }
    expect(duplicates).toEqual([]);
    expect(Object.keys(en).filter(key => !keys.has(key))).toEqual([]);
  });

  it('stays Chinese outside the browser so the server keeps its stored text', () => {
    expect(t('运行 {0} 次', 3)).toBe('运行 3 次');
    expect(localizeText('独立验收')).toBe('独立验收');
  });
});

describe('server error messages in an English browser', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
  // The locale is read once at import, so the module is loaded again under a stubbed English browser with an empty page.
  async function english() {
    vi.resetModules();
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', { documentElement: {}, title: '', createTreeWalker: () => ({ nextNode: () => null }), querySelectorAll: () => [] });
    vi.stubGlobal('NodeFilter', { SHOW_TEXT: 4 });
    vi.stubGlobal('localStorage', { getItem: () => 'en' });
    return import('../apps/web/i18n');
  }

  it('translates exact and filled-in messages and keeps the filled values', async () => {
    const { localizeMessage } = await english();
    expect(localizeMessage('会话已过期，请刷新页面。')).toBe(en['会话已过期，请刷新页面。']);
    expect(localizeMessage('运行队列已满：3 个任务正在运行，12 个在排队。草稿已保留，请等几分钟后再提交。'))
      .toBe('The run queue is full: 3 running, 12 waiting. Your draft was kept; submit again in a few minutes.');
    expect(localizeMessage('已达到 20 条运行记录的上限。请先下载需要的档案，删除已结束的记录后重试。'))
      .toBe('You have reached the limit of 20 run records. Download the archives you need, delete finished records and try again.');
    expect(localizeMessage('模型服务返回错误（HTTP 502）。')).toBe('The model provider returned an error (HTTP 502).');
    // Text that is not an error key, such as an Agent's own words, stays as written.
    expect(localizeMessage('证明在第 3 步卡住了。')).toBe('证明在第 3 步卡住了。');
    expect(localizeMessage('')).toBe('');
  });

  it('matches every templated error key with its own English', async () => {
    const { localizeMessage } = await english();
    for (const key of Object.keys(errors).filter(key => /\{\d+\}/u.test(key))) {
      const filled = (text: string) => text.replace(/\{(\d+)\}/gu, (_match, index: string) => String(40 + Number(index)));
      expect(localizeMessage(filled(key)), key).toBe(filled(errors[key]!));
    }
  });

  it('counts one thing in the singular, after a describing word and in the sentence it starts', async () => {
    const { t: say } = await english();
    expect(say('{0} 个原题目标，没有新增辅助声明。', 1)).toBe('1 original target, no added helper declarations.');
    expect(say('另有 {0} 个 Agent 空闲、准备中或已停止。', 1)).toBe('1 more Agent is idle, preparing or stopped.');
    expect(say('另有 {0} 条消息没有显示。', 1)).toBe('1 more message is not shown.');
    // "are" belongs to "Changes" here, not to the counted file.
    expect(say('另有 {0} 个文件的改动没有显示。', 1)).toBe('Changes to 1 more file are not shown.');
    expect([say('修改 {0} 个文件', 1), say('{0} 个错误', 1), say('约 {0} 小时', 1)]).toEqual(['Edited 1 file', '1 error', 'about 1 hour']);
    expect([say('{0} / {1} 条声明审阅', 1, 4), say('{0} / {1} 条声明审阅', 0, 1)]).toEqual(['1 / 4 statement reviews', '0 / 1 statement review']);
    expect([say('{0} 个错误', 21), say('约 {0} 小时', 1.5), say('{0} 个原题目标，没有新增辅助声明。', 2)])
      .toEqual(['21 errors', 'about 1.5 hours', '2 original targets, no added helper declarations.']);
  });
});
