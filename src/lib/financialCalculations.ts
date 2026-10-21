export interface FinancialTransaction {
  type: 'income' | 'expense';
  amount: string;
  transactionDate: string;
}

export interface FinancialTotals {
  incomeCents: bigint;
  expenseCents: bigint;
  netBalanceCents: bigint;
  currentMonthExpenseCents: bigint;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
}

export function getCalendarDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    calendar: 'gregory',
    day: '2-digit',
    month: '2-digit',
    numberingSystem: 'latn',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;

  if (!year || !month || !day) {
    throw new Error('Unable to determine the current calendar date.');
  }

  return `${year}-${month}-${day}`;
}

export function amountInCents(amount: string): bigint {
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function calculateFinancialTotals(
  transactions: FinancialTransaction[],
  today: string,
): FinancialTotals {
  let incomeCents = 0n;
  let expenseCents = 0n;
  let currentMonthExpenseCents = 0n;
  const currentMonth = today.slice(0, 7);

  for (const transaction of transactions) {
    if (transaction.transactionDate > today) continue;

    const amount = amountInCents(transaction.amount);
    if (transaction.type === 'income') {
      incomeCents += amount;
    } else {
      expenseCents += amount;
      if (transaction.transactionDate.startsWith(currentMonth)) {
        currentMonthExpenseCents += amount;
      }
    }
  }

  return {
    incomeCents,
    expenseCents,
    netBalanceCents: incomeCents - expenseCents,
    currentMonthExpenseCents,
  };
}
