import type { Locale } from './site';
import type { ProofWalkthroughStep } from './proofWalkthroughTypes';
import { renderCoverFigure } from './proofCoverFigure';
import { renderSnakyFigure } from './proofSnakyFigure';
import { renderTriangleFigure } from './proofTriangleFigure';

export function renderProofFigure(figure: ProofWalkthroughStep['figure'], locale: Locale): string {
  if (figure === 'triangle-matchings') return renderTriangleFigure(locale);
  if (figure === 'four-corner-cover') return renderCoverFigure(locale);
  if (figure === 'snaky') return renderSnakyFigure(locale);
  return '';
}
