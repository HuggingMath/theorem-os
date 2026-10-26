import { terms, type TermId } from '../glossary';

/** The Preact form of termHint(); termHints.ts handles the click for both. */
export const TermHint = ({ id }: { id: TermId }) =>
  <button type="button" class="term-hint" data-term={id} aria-label={`${terms[id].name}是什么`} aria-expanded="false"><span aria-hidden="true">?</span></button>;
