export type ProofReadingPosition = { anchor: string; proofSha: string };

/** A follow-up identifies a selected position; it never supplies the quoted mathematics. */
export function focusedProblemHref(href: string, anchor: string): string {
  const at = href.indexOf('?'), prefix = at < 0 ? href : href.slice(0, at);
  const parameters = new URLSearchParams(at < 0 ? '' : href.slice(at + 1));
  parameters.set('archiveFocus', anchor);
  return `${prefix}?${parameters}`;
}

/** A position belongs to the exact accepted source, rather than a historical run. */
export function readProofReadingPosition(parameters: URLSearchParams): ProofReadingPosition | undefined {
  const anchor = parameters.get('reading') ?? '', proofSha = parameters.get('readingSha') ?? '';
  return anchor.length <= 200 && /^proof-(?:derivation-[A-Za-z0-9_-]+|source-(?:target|helper)-[1-9][0-9]*)$/u.test(anchor)
    && /^[a-f0-9]{64}$/u.test(proofSha) ? { anchor, proofSha } : undefined;
}

/** Only the originating workbench directory may be a proof's return destination. */
export function theoremDirectoryReturn(value: string | null, currentHref: string): string | undefined {
  if (!value) return undefined;
  try {
    const current = new URL(currentHref), destination = new URL(value, current);
    const directory = new URL(current.pathname.endsWith('/en/archive.html') ? '../../theorems.html' : '../theorems.html', current);
    if (destination.origin !== current.origin || destination.pathname !== directory.pathname
      || destination.username || destination.password || destination.searchParams.get('collection') !== 'solved') return undefined;
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch { return undefined; }
}

/** The handoff may remember a reading location, never choose another problem or source. */
export function archiveReadingReturn(value: string | undefined, proofId: string, currentHref: string, proofSha: string): string | undefined {
  if (!value) return undefined;
  try {
    const current = new URL(currentHref), destination = new URL(value, current);
    if (destination.origin !== current.origin || destination.username || destination.password
      || !['/classics/archive.html', '/classics/en/archive.html'].includes(destination.pathname)) return undefined;
    const original = new URLSearchParams(destination.hash.slice(1));
    if (original.get('proof') !== proofId || original.get('tab') !== 'reading') return undefined;
    const parameters = new URLSearchParams({ proof: proofId, tab: 'reading', status: 'verified' });
    const position = readProofReadingPosition(original);
    if (position?.proofSha === proofSha) {
      parameters.set('reading', position.anchor); parameters.set('readingSha', position.proofSha);
    }
    const directory = theoremDirectoryReturn(original.get('return'), destination.href);
    if (directory) parameters.set('return', directory);
    destination.search = ''; destination.hash = parameters.toString();
    return destination.href;
  } catch { return undefined; }
}
