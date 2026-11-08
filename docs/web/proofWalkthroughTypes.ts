export interface Localized {
  zh: string;
  en: string;
}

export interface ProofWalkthroughStep {
  id: string;
  title: Localized;
  given: Localized;
  claim: Localized;
  because: Localized;
  next: Localized;
  evidence: {
    theorems: string[];
    taskIds?: string[];
    deliveryIds?: string[];
    checkIds?: string[];
    source: { name: string; line: number; endLine: number };
  };
}

/** A reading of the accepted proof, separate from the dated research journal. */
export interface ProofWalkthrough {
  recordId: string;
  runId: string;
  proofSha256: string;
  title: Localized;
  goal: Localized;
  notation?: Localized;
  steps: ProofWalkthroughStep[];
}
