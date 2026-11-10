import type { Locale } from './site';
import type { ProofWalkthroughStep } from './proofWalkthroughTypes';
import { renderCoverFigure } from './proofCoverFigure';
import { renderSnakyFigure, renderSnakyForkFigure } from './proofSnakyFigure';
import { renderTriangleFigure } from './proofTriangleFigure';
import { renderConvexFigure } from './proofConvexFigure';
import { renderSeparationFigure } from './proofSeparationFigure';
import { renderHadamardFigure } from './proofHadamardFigure';
import { renderTruffetFigure } from './proofTruffetFigure';

export function renderProofFigure(figure: ProofWalkthroughStep['figure'], locale: Locale): string {
  if (figure === 'triangle-matchings') return renderTriangleFigure(locale);
  if (figure === 'convex-mass-section') return renderConvexFigure(locale);
  if (figure === 'four-corner-cover') return renderCoverFigure(locale);
  if (figure === 'color-separation') return renderSeparationFigure(locale);
  if (figure === 'snaky') return renderSnakyFigure(locale);
  if (figure === 'snaky-fork') return renderSnakyForkFigure(locale);
  if (figure === 'truffet-elimination') return renderTruffetFigure(locale);
  if (figure === 'hadamard-fiber') return renderHadamardFigure(locale);
  return '';
}
