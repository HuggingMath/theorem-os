import { KERNEL_COMPUTE_LIBRARY } from './kernelComputeLibrary';

/** Solver-owned modules reserved for generated kernel certificates. Kernel.lean is a frozen host library;
 *  PartNN.lean start empty so certificates can be spread over modules that compile independently. */
export const CERTIFICATE_SLOT_DIRECTORY = 'Submission/Certificates';
export const CERTIFICATE_KERNEL_MODULE = `${CERTIFICATE_SLOT_DIRECTORY}/Kernel.lean`;
export const MAX_CERTIFICATE_SLOTS = 64;

export function certificateSlotFiles(parts: number): readonly string[] {
  if (!Number.isSafeInteger(parts) || parts < 0 || parts > MAX_CERTIFICATE_SLOTS) throw new Error('math_certificate_slots_invalid');
  if (!parts) return Object.freeze([]);
  return Object.freeze([CERTIFICATE_KERNEL_MODULE, ...Array.from({ length: parts },
    (_, index) => `${CERTIFICATE_SLOT_DIRECTORY}/Part${String(index + 1).padStart(2, '0')}.lean`)]);
}

/** Baseline bytes: the library is frozen original source, part slots are empty. */
export function certificateSlotSource(file: string): string {
  return file === CERTIFICATE_KERNEL_MODULE ? KERNEL_COMPUTE_LIBRARY.trim() + '\n' : '';
}

export const isCertificateSlotFile = (file: string): boolean =>
  file === CERTIFICATE_KERNEL_MODULE || /^Submission\/Certificates\/Part[0-9]{2}\.lean$/u.test(file);
