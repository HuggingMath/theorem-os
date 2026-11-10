export type ResearchProblemBudget = {
  key: string; revision: number; currency: 'CNY' | 'USD'; tokenLimit: number | null; amountLimit: number | null; updatedAt?: string;
};
export type ResearchBudgetView = {
  plan: ResearchProblemBudget; title: string; knownTokens: number; missingUsage: number; unpricedEntries: number;
  spent: { CNY: number; USD: number }; remainingTokens: number | null; remainingAmount: number | null;
  forecast: { tokens: number; model: string; currency: 'CNY' | 'USD' | null; amount: number | null;
    overTokens: boolean; overAmount: boolean; perMillion: number | null };
};
