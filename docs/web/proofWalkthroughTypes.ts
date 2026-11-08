export interface Localized {
  zh: string;
  en: string;
}

export interface ProofDerivationLine {
  statement: Localized;
  reason: Localized;
}

export interface ProofWalkthroughStep {
  id: string;
  title: Localized;
  given: Localized;
  claim: Localized;
  because: Localized;
  dependsOn: string[];
  derivation: ProofDerivationLine[];
  figure?: 'triangle-matchings' | 'convex-mass-section' | 'four-corner-cover' | 'color-separation' | 'snaky' | 'snaky-fork';
  /** Built into the record's lazy process asset, using the same renderer as its controls. */
  figureHtml?: Localized;
  next: Localized;
  evidence: {
    theorems: string[];
    taskIds?: string[];
    deliveryIds?: string[];
    checkIds?: string[];
    source: { name: string; line: number; endLine: number };
  };
}

/** Ordered reading groups; mathematical dependencies remain on each step. */
export interface ProofWalkthroughStage {
  title: Localized;
  summary: Localized;
  stepIds: string[];
}

/** A reading of the accepted proof, separate from the dated research journal. */
export interface ProofWalkthrough {
  recordId: string;
  runId: string;
  proofSha256: string;
  title: Localized;
  strategy: Localized;
  stages: ProofWalkthroughStage[];
  goal: Localized;
  notation?: Localized;
  steps: ProofWalkthroughStep[];
}
