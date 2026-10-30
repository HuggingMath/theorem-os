import { admin } from './admin';
import { app } from './app';
import { collaboration } from './collaboration';
import { common } from './common';
import { editor } from './editor';
import { explain } from './explain';
import { guide } from './guide';
import { modules } from './modules';
import { pages } from './pages';
import { server } from './server';

/** English for every Chinese interface string, keyed by the Chinese text. tests/webI18n.test.ts checks coverage. */
export const en: Record<string, string> = { ...server, ...pages, ...common, ...app, ...collaboration, ...modules, ...editor, ...guide, ...admin, ...explain };
