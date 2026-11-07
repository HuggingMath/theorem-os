import { admin } from './admin';
import { app } from './app';
import { collaboration } from './collaboration';
import { common } from './common';
import { editor } from './editor';
import { errors } from './errors';
import { explain } from './explain';
import { formalize } from './formalize';
import { guide } from './guide';
import { legal } from './legal';
import { modules } from './modules';
import { pages } from './pages';
import { process } from './process';
import { server } from './server';

/** English for every Chinese interface string, keyed by the Chinese text. tests/webI18n.test.ts checks coverage. */
export const en: Record<string, string> = { ...server, ...pages, ...common, ...app, ...collaboration, ...modules, ...editor, ...guide, ...legal, ...admin, ...errors, ...explain, ...formalize, ...process };
