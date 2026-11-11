import { describe, expect, it } from 'vitest';
import type { ResearchProblemBudget } from '../apps/web/researchBudgetTypes';
import { budgetEditorState, completeBudgetSave, readBudgetIntoEditor, type BudgetEditorValues } from '../apps/web/client/researchBudgetEditor';

const plan = (revision = 2): ResearchProblemBudget => ({ key: 'problem', revision, tokenLimit: 700000, amountLimit: 40, currency: 'USD' });
const submitted: BudgetEditorValues = { tokenLimit: '700000', amount: '40', currency: 'USD' };

describe('problem budget save continuity', () => {
  it('loads optional and zero budgets without changing their meaning', () => {
    expect(budgetEditorState()).toMatchObject({ tokenLimit: '', amount: '', currency: 'CNY', expectedRevision: 0 });
    expect(budgetEditorState({ ...plan(), tokenLimit: null, amountLimit: 0 })).toMatchObject({ tokenLimit: '', amount: '0' });
  });

  it('marks an unchanged submission clean at the saved revision', () => {
    const current = { ...submitted, editing: true, expectedRevision: 1 };
    expect(completeBudgetSave(current, submitted, plan())).toEqual({ ...submitted, editing: false, expectedRevision: 2 });
  });

  it.each<[string, BudgetEditorValues]>([
    ['tokens', { ...submitted, tokenLimit: '900000' }],
    ['amount', { ...submitted, amount: '80' }],
    ['currency', { ...submitted, currency: 'CNY' }],
    ['all fields', { tokenLimit: '900000', amount: '80', currency: 'CNY' }],
    ['cleared limits', { tokenLimit: '', amount: '', currency: 'USD' }],
  ])('preserves newer %s and lets the next save finish at the next revision', (_label, values) => {
    const current = { ...values, editing: true, expectedRevision: 1 };
    const retained = completeBudgetSave(current, submitted, plan());
    expect(retained).toEqual({ ...values, editing: true, expectedRevision: 2 });
    expect(readBudgetIntoEditor(retained, plan())).toBe(retained);
    const next = { ...plan(3), tokenLimit: values.tokenLimit === '' ? null : Number(values.tokenLimit), amountLimit: values.amount === '' ? null : Number(values.amount), currency: values.currency };
    expect(completeBudgetSave(retained, values, next)).toEqual({ ...values, editing: false, expectedRevision: 3 });
  });

  it('does not roll back a confirmed save when the previous resource read is still displayed', () => {
    const saved = completeBudgetSave({ ...submitted, editing: true, expectedRevision: 1 }, submitted, plan());
    expect(readBudgetIntoEditor(saved, { ...plan(1), tokenLimit: 500000, amountLimit: 20 })).toBe(saved);
    expect(readBudgetIntoEditor(saved, { ...plan(3), tokenLimit: 800000 })).toMatchObject({ tokenLimit: '800000', expectedRevision: 3 });
  });

  it('retains edits and their base revision when another device updates the budget', () => {
    const current = { tokenLimit: '900000', amount: '80', currency: 'CNY' as const, editing: true, expectedRevision: 2 };
    expect(readBudgetIntoEditor(current, plan(3))).toBe(current);
    const reviewed = { ...current, expectedRevision: 3 };
    expect(completeBudgetSave(reviewed, submitted, plan(2))).toEqual(reviewed);
  });
});
