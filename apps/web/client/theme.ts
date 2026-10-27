// Loaded synchronously in <head> before the stylesheet, so the first paint already has the right theme.
import { applyTheme, followThemeChanges } from './themePreference';

applyTheme();
followThemeChanges();
