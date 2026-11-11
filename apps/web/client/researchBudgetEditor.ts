import type { ResearchProblemBudget } from '../researchBudgetTypes';

export type BudgetEditorValues = { tokenLimit: string; amount: string; currency: 'CNY' | 'USD' };
export type BudgetEditorState = BudgetEditorValues & { editing: boolean; expectedRevision: number };

export function budgetEditorState(plan?: ResearchProblemBudget): BudgetEditorState {
  return { tokenLimit: plan?.tokenLimit == null ? '' : String(plan.tokenLimit), amount: plan?.amountLimit == null ? '' : String(plan.amountLimit),
    currency: plan?.currency ?? 'CNY', editing: false, expectedRevision: plan?.revision ?? 0 };
}

/** A stale read or a background refresh cannot replace edits or roll back a confirmed save. */
export function readBudgetIntoEditor(current: BudgetEditorState, plan: ResearchProblemBudget): BudgetEditorState {
  return current.editing || plan.revision < current.expectedRevision ? current : budgetEditorState(plan);
}

/** Only the submitted inputs become clean. Newer inputs continue from the confirmed revision. */
export function completeBudgetSave(current: BudgetEditorState, submitted: BudgetEditorValues, saved: ResearchProblemBudget): BudgetEditorState {
  const unchanged = current.tokenLimit === submitted.tokenLimit && current.amount === submitted.amount && current.currency === submitted.currency;
  return unchanged ? budgetEditorState(saved) : { ...current, editing: true, expectedRevision: Math.max(current.expectedRevision, saved.revision) };
}
