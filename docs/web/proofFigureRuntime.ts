import type { ProofFigureRuntime } from './proofFigures';
import { mountCoverFigure } from './proofCoverFigure';
import { mountSnakyFigure } from './proofSnakyFigure';
import { mountTriangleFigure } from './proofTriangleFigure';

const runtime: ProofFigureRuntime = {
  mount(root, signal) {
    root.querySelectorAll<HTMLElement>('[data-proof-figure]').forEach(figure => {
      if (figure.dataset.proofFigure === 'triangle-matchings') mountTriangleFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'four-corner-cover') mountCoverFigure(figure, signal);
      else if (figure.dataset.proofFigure === 'snaky') mountSnakyFigure(figure, signal);
    });
  },
};
window.theoremosProofFigures = runtime;
