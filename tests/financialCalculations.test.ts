import { describe, expect, it } from 'vitest';
import {
  calculateFinancialTotals,
  getCalendarDateInTimeZone,
  type FinancialTransaction,
} from '../src/lib/financialCalculations';

function transaction(
  type: FinancialTransaction['type'],
  amount: string,
  transactionDate: string,
): FinancialTransaction {
  return { type, amount, transactionDate };
}

describe('financial calculations', () => {
  it('includes past-dated expenses in actual totals', () => {
    expect(
      calculateFinancialTotals(
        [transaction('expense', '12.50', '2025-05-14')],
        '2025-05-15',
      ),
    ).toEqual({
      incomeCents: 0n,
      expenseCents: 1250n,
      netBalanceCents: -1250n,
      currentMonthExpenseCents: 1250n,
    });
  });

  it('includes expenses dated today', () => {
    expect(
      calculateFinancialTotals(
        [transaction('expense', '8.25', '2025-05-15')],
        '2025-05-15',
      ),
    ).toEqual({
      incomeCents: 0n,
      expenseCents: 825n,
      netBalanceCents: -825n,
      currentMonthExpenseCents: 825n,
    });
  });

  it.each(['2025-05-16', '2025-06-01'])(
    'excludes future expense dated %s from totals and monthly spending',
    (date) => {
      expect(
        calculateFinancialTotals(
          [transaction('expense', '500.00', date)],
          '2025-05-15',
        ),
      ).toEqual({
        incomeCents: 0n,
        expenseCents: 0n,
        netBalanceCents: 0n,
        currentMonthExpenseCents: 0n,
      });
    },
  );

  it('excludes future income from income and net balance', () => {
    expect(
      calculateFinancialTotals(
        [transaction('income', '2500.00', '2025-05-16')],
        '2025-05-15',
      ),
    ).toEqual({
      incomeCents: 0n,
      expenseCents: 0n,
      netBalanceCents: 0n,
      currentMonthExpenseCents: 0n,
    });
  });

  it('does not let a future expense push current-month spending over a limit', () => {
    const totals = calculateFinancialTotals(
      [
        transaction('expense', '90.00', '2025-05-15'),
        transaction('expense', '30.00', '2025-05-20'),
      ],
      '2025-05-15',
    );

    expect(totals.currentMonthExpenseCents).toBe(9000n);
    expect(totals.currentMonthExpenseCents).toBeLessThan(10000n);
  });

  it('handles month and year boundaries using calendar-date comparisons', () => {
    expect(
      calculateFinancialTotals(
        [
          transaction('expense', '10.00', '2024-12-31'),
          transaction('expense', '20.00', '2025-01-01'),
          transaction('income', '40.00', '2025-01-01'),
          transaction('expense', '30.00', '2025-01-02'),
        ],
        '2025-01-01',
      ),
    ).toEqual({
      incomeCents: 4000n,
      expenseCents: 3000n,
      netBalanceCents: 1000n,
      currentMonthExpenseCents: 2000n,
    });
  });

  it('gets today from the configured timezone without shifting calendar dates', () => {
    const instant = new Date('2025-03-01T00:30:00.000Z');

    expect(getCalendarDateInTimeZone(instant, 'UTC')).toBe('2025-03-01');
    expect(getCalendarDateInTimeZone(instant, 'America/Los_Angeles')).toBe('2025-02-28');
  });
});
