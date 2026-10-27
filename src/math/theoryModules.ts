/** Solver-owned modules for a reusable theory library: each holds one topic's definitions and lemmas, compiles and
 *  caches on its own, and is imported by later modules or the original files. They start as an empty namespace. */
export const THEORY_MODULE_DIRECTORY = 'Submission/Theory';
export const THEORY_MODULE_NAMESPACE = 'Submission.Theory';
export const MAX_THEORY_MODULES = 64;

export function theoryModuleFiles(count: number): readonly string[] {
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_THEORY_MODULES) throw new Error('math_theory_modules_invalid');
  return Object.freeze(Array.from({ length: count },
    (_, index) => `${THEORY_MODULE_DIRECTORY}/T${String(index + 1).padStart(2, '0')}.lean`));
}

/** The frozen context permits declarations and imports inside this namespace, like the pinned Helpers baseline. */
export const theoryModuleSource = (): string => `namespace ${THEORY_MODULE_NAMESPACE}\n\nend ${THEORY_MODULE_NAMESPACE}\n`;

export const isTheoryModuleFile = (file: string): boolean => /^Submission\/Theory\/T[0-9]{2}\.lean$/u.test(file);
