export interface MonthlyBudgetRecord {
  month: string;
  baseAmount: string;
}

export interface MonthlyExpenseRecord {
  month: string;
  amount: string;
}

export type BudgetStatus =
  | 'under'
  | 'near'
  | 'over'
  | 'no-available'
  | 'negative-available'
  | 'unconfigured';

export interface MonthlyBudgetResult {
  month: string;
  hasBudget: boolean;
  baseBudget: string;
  openingRollover: string;
  availableBudget: string;
  eligibleExpenses: string;
  remainingBudget: string;
  closingRollover: string;
  spendingPercentage: string | null;
  status: BudgetStatus;
}

const monthPattern = /^(\d{4})-(\d{2})$/;
const amountPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/;

export function isValidBudgetMonth(value: string): boolean {
  const match = monthPattern.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  return year >= 1 && month >= 1 && month <= 12;
}

export function parseBudgetAmount(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const amount = value;
  if (!amountPattern.test(amount) || amountInCents(amount) <= 0n) return null;
  return amount;
}

export function amountInCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function centsToAmount(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const formatted = `${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
  return negative ? `-${formatted}` : formatted;
}

function budgetStatus(
  hasBudget: boolean,
  available: bigint,
  expenses: bigint,
): BudgetStatus {
  if (available < 0n) return 'negative-available';
  if (available === 0n) {
    if (expenses > 0n) return 'over';
    return hasBudget ? 'no-available' : 'unconfigured';
  }
  if (expenses * 100n < available * 80n) return 'under';
  if (expenses <= available) return 'near';
  return 'over';
}

function spendingPercentage(available: bigint, expenses: bigint): string | null {
  if (available <= 0n) return null;
  const hundredths = (expenses * 10000n) / available;
  return `${hundredths / 100n}.${String(hundredths % 100n).padStart(2, '0')}`;
}

export function calculateMonthlyBudget(
  history: MonthlyBudgetRecord[],
  expenses: MonthlyExpenseRecord[],
  targetMonth: string,
): MonthlyBudgetResult {
  if (!isValidBudgetMonth(targetMonth)) {
    throw new RangeError('Budget month must be a valid YYYY-MM month.');
  }

  const budgetByMonth = new Map<string, MonthlyBudgetRecord>();
  for (const budget of history) {
    if (!isValidBudgetMonth(budget.month) || budgetByMonth.has(budget.month)) {
      throw new Error('Budget history contains an invalid or duplicate month.');
    }
    budgetByMonth.set(budget.month, budget);
  }

  const expenseByMonth = new Map<string, bigint>();
  for (const expense of expenses) {
    if (!isValidBudgetMonth(expense.month)) {
      throw new Error('Expense history contains an invalid month.');
    }
    expenseByMonth.set(
      expense.month,
      (expenseByMonth.get(expense.month) ?? 0n) + amountInCents(expense.amount),
    );
  }

  const targetBudget = budgetByMonth.get(targetMonth);
  const eventMonths = new Set(
    [...budgetByMonth.keys(), ...expenseByMonth.keys()].filter((month) => month <= targetMonth),
  );
  eventMonths.add(targetMonth);

  let closingRollover = 0n;
  let targetResult: MonthlyBudgetResult | undefined;

  for (const month of [...eventMonths].sort()) {
    const budget = budgetByMonth.get(month);
    const baseBudget = budget ? amountInCents(budget.baseAmount) : 0n;
    const openingRollover = closingRollover;
    const availableBudget = baseBudget + openingRollover;
    const eligibleExpenses = expenseByMonth.get(month) ?? 0n;
    closingRollover = availableBudget - eligibleExpenses;

    if (month === targetMonth) {
      const status = budgetStatus(Boolean(targetBudget), availableBudget, eligibleExpenses);
      targetResult = {
        month,
        hasBudget: Boolean(targetBudget),
        baseBudget: centsToAmount(baseBudget),
        openingRollover: centsToAmount(openingRollover),
        availableBudget: centsToAmount(availableBudget),
        eligibleExpenses: centsToAmount(eligibleExpenses),
        remainingBudget: centsToAmount(closingRollover),
        closingRollover: centsToAmount(closingRollover),
        spendingPercentage: spendingPercentage(availableBudget, eligibleExpenses),
        status,
      };
    }
  }

  if (!targetResult) throw new Error('Unable to calculate the requested monthly budget.');
  return targetResult;
}
