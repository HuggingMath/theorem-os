import type { ResearchLibraryTrialTargetRef } from './researchLibraryTrialTypes';

/** Frozen reading context for discovery. It does not assert that any Library result solves this task. */
export type ResearchLibraryDiscovery = {
  ref: ResearchLibraryTrialTargetRef; runTitle: string; title: string; objective: string; statement: string; type: string;
  premises: string[]; environment: 'standard' | 'mathlib'; current: boolean; returnHref: string;
};
