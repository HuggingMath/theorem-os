import { render } from 'katex';
import type { MathRuntime } from './mathAssets';

/** Shared by chat, research, explanations and archives; loaded only when a formula is displayed. */
window.theoremosMath = { render } satisfies MathRuntime;
