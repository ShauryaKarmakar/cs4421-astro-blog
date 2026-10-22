import { describe, expect, it } from 'vitest';
import {
  calculateMonthlyBudget,
  centsToAmount,
  type MonthlyBudgetRecord,
  type MonthlyExpenseRecord,
} from '../src/lib/budgetCalculations';

function budget(month: string, baseAmount: string): MonthlyBudgetRecord {
  return { month, baseAmount };
}

function expense(month: string, amount: string): MonthlyExpenseRecord {
  return { month, amount };
}

describe('overall monthly budget calculations', () => {
  it('carries positive rollover after underspending into the next month', () => {
    const result = calculateMonthlyBudget(
      [budget('2025-01', '500.00'), budget('2025-02', '500.00')],
      [expense('2025-01', '400.00')],
      '2025-02',
    );

    expect(result).toMatchObject({
      baseBudget: '500.00',
      openingRollover: '100.00',
      availableBudget: '600.00',
      eligibleExpenses: '0.00',
      remainingBudget: '600.00',
      closingRollover: '600.00',
      status: 'under',
    });
  });

  it('carries negative rollover after overspending without clamping it', () => {
    const result = calculateMonthlyBudget(
      [budget('2025-01', '500.00'), budget('2025-02', '500.00')],
      [expense('2025-01', '550.00')],
      '2025-02',
    );

    expect(result).toMatchObject({
      openingRollover: '-50.00',
      availableBudget: '450.00',
      remainingBudget: '450.00',
    });
  });

  it('replaces a base amount without adding to it and preserves rollover and spending', () => {
    const expenses = [expense('2025-09', '400.00'), expense('2025-10', '250.00')];
    const beforeEdit = calculateMonthlyBudget(
      [budget('2025-09', '500.00'), budget('2025-10', '500.00')],
      expenses,
      '2025-10',
    );
    const afterEdit = calculateMonthlyBudget(
      [budget('2025-09', '500.00'), budget('2025-10', '400.00')],
      expenses,
      '2025-10',
    );

    expect(beforeEdit).toMatchObject({
      openingRollover: '100.00',
      availableBudget: '600.00',
      eligibleExpenses: '250.00',
      remainingBudget: '350.00',
    });
    expect(afterEdit).toMatchObject({
      baseBudget: '400.00',
      openingRollover: '100.00',
      availableBudget: '500.00',
      eligibleExpenses: '250.00',
      remainingBudget: '250.00',
    });
  });

  it('recalculates all later month rollover after an earlier base amount edit', () => {
    const expenses = [expense('2025-01', '400.00'), expense('2025-02', '350.00')];
    const originalHistory = [
      budget('2025-01', '500.00'),
      budget('2025-02', '500.00'),
      budget('2025-03', '500.00'),
    ];
    const editedHistory = [
      budget('2025-01', '400.00'),
      budget('2025-02', '500.00'),
      budget('2025-03', '500.00'),
    ];

    expect(calculateMonthlyBudget(originalHistory, expenses, '2025-03').openingRollover)
      .toBe('250.00');
    expect(calculateMonthlyBudget(editedHistory, expenses, '2025-03').openingRollover)
      .toBe('150.00');
  });

  it('carries balances across missing budget months and applies expenses in those months', () => {
    const result = calculateMonthlyBudget(
      [budget('2024-10', '100.00'), budget('2025-01', '100.00')],
      [
        expense('2024-10', '25.00'),
        expense('2024-11', '10.00'),
        expense('2024-12', '5.00'),
      ],
      '2025-01',
    );

    expect(result).toMatchObject({
      openingRollover: '60.00',
      availableBudget: '160.00',
      eligibleExpenses: '0.00',
      closingRollover: '160.00',
    });
  });

  it('returns calculations for a month without a base budget', () => {
    const result = calculateMonthlyBudget(
      [budget('2025-01', '100.00')],
      [expense('2025-01', '40.00'), expense('2025-02', '15.00')],
      '2025-02',
    );

    expect(result).toMatchObject({
      hasBudget: false,
      baseBudget: '0.00',
      openingRollover: '60.00',
      availableBudget: '60.00',
      eligibleExpenses: '15.00',
      remainingBudget: '45.00',
    });
  });

  it('aggregates expenses from every category exactly once', () => {
    const result = calculateMonthlyBudget(
      [budget('2025-04', '500.00')],
      [expense('2025-04', '12.50'), expense('2025-04', '33.25')],
      '2025-04',
    );
    expect(result.eligibleExpenses).toBe('45.75');
    expect(result.remainingBudget).toBe('454.25');
  });

  it('uses exact inclusive boundaries for under, near and over status', () => {
    const calculate = (amount: string) =>
      calculateMonthlyBudget([budget('2025-01', '100.00')], [expense('2025-01', amount)], '2025-01');

    expect(calculate('79.99')).toMatchObject({ status: 'under', spendingPercentage: '79.99' });
    expect(calculate('80.00')).toMatchObject({ status: 'near', spendingPercentage: '80.00' });
    expect(calculate('100.00')).toMatchObject({ status: 'near', spendingPercentage: '100.00' });
    expect(calculate('100.01')).toMatchObject({ status: 'over', spendingPercentage: '100.01' });
  });

  it('reports zero and negative available budget without a percentage', () => {
    const zero = calculateMonthlyBudget(
      [budget('2025-01', '50.00'), budget('2025-02', '10.00')],
      [expense('2025-01', '60.00')],
      '2025-02',
    );
    const negative = calculateMonthlyBudget(
      [budget('2025-01', '20.00'), budget('2025-02', '10.00')],
      [expense('2025-01', '40.00')],
      '2025-02',
    );

    expect(zero).toMatchObject({
      availableBudget: '0.00',
      remainingBudget: '0.00',
      spendingPercentage: null,
      status: 'no-available',
    });
    expect(
      calculateMonthlyBudget(
        [budget('2025-01', '50.00'), budget('2025-02', '10.00')],
        [expense('2025-01', '60.00'), expense('2025-02', '1.00')],
        '2025-02',
      ),
    ).toMatchObject({
      availableBudget: '0.00',
      eligibleExpenses: '1.00',
      remainingBudget: '-1.00',
      spendingPercentage: null,
      status: 'over',
    });
    expect(negative).toMatchObject({
      availableBudget: '-10.00',
      remainingBudget: '-10.00',
      spendingPercentage: null,
      status: 'negative-available',
    });
  });

  it('handles December-to-January and leap-year month transitions', () => {
    const newYear = calculateMonthlyBudget(
      [budget('2024-12', '100.00'), budget('2025-01', '100.00')],
      [expense('2024-12', '25.00')],
      '2025-01',
    );
    const leapYear = calculateMonthlyBudget(
      [budget('2024-02', '100.00'), budget('2024-03', '100.00')],
      [expense('2024-02', '25.00')],
      '2024-03',
    );
    expect(newYear.openingRollover).toBe('75.00');
    expect(leapYear.openingRollover).toBe('75.00');
  });

  it('does not change earlier historical results when a later base is edited', () => {
    const expenses = [expense('2025-01', '50.00')];
    const beforeEdit = calculateMonthlyBudget(
      [budget('2025-01', '100.00'), budget('2025-02', '100.00')],
      expenses,
      '2025-01',
    );
    const afterEdit = calculateMonthlyBudget(
      [budget('2025-01', '100.00'), budget('2025-02', '900.00')],
      expenses,
      '2025-01',
    );
    expect(afterEdit).toEqual(beforeEdit);
  });

  it('formats signed minor currency units without floating-point arithmetic', () => {
    expect(centsToAmount(-1n)).toBe('-0.01');
    expect(centsToAmount(10005n)).toBe('100.05');
  });
});
