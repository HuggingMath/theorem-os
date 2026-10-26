import { terms, type TermId } from '../glossary';
import { t } from '../../i18n';

/** The Preact form of termHint(); termHints.ts handles the click for both. */
export const TermHint = ({ id }: { id: TermId }) =>
  <button type="button" class="term-hint" data-term={id} aria-label={t('{0}是什么', terms[id].name)} aria-expanded="false"><span aria-hidden="true">?</span></button>;
