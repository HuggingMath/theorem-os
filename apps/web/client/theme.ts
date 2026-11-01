// Loaded synchronously in <head> before the stylesheet, so the first paint already has the right theme and history width.
import { markHistoryCollapsed, readHistoryCollapsed } from './historyPreference';
import { applyTheme, followThemeChanges } from './themePreference';

applyTheme();
followThemeChanges();
markHistoryCollapsed(readHistoryCollapsed(() => localStorage));
