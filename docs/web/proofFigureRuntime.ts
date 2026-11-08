import type { ProofFigureRuntime } from './proofFigures';
import { mountCoverFigure } from './proofCoverFigure';
import { mountSnakyFigure, mountSnakyForkFigure } from './proofSnakyFigure';
import { mountTriangleFigure } from './proofTriangleFigure';
import { mountConvexFigure } from './proofConvexFigure';
import { mountSeparationFigure } from './proofSeparationFigure';
import { mountHadamardFigure } from './proofHadamardFigure';
import { mountTruffetFigure } from './proofTruffetFigure';

const runtime: ProofFigureRuntime = {
  mount(root, signal) {
    root.querySelectorAll<HTMLElement>('[data-proof-figure]').forEach(figure => {
      if (figure.dataset.proofFigure === 'triangle-matchings') mountTriangleFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'convex-mass-section') mountConvexFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'four-corner-cover') mountCoverFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'color-separation') mountSeparationFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'snaky') mountSnakyFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'snaky-fork') mountSnakyForkFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'truffet-elimination') mountTruffetFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'hadamard-fiber') mountHadamardFigure(figure, signal);
    });
  },
};
window.theoremosProofFigures = runtime;
