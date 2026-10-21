export const APP_CURRENCY = 'EUR';

const wholeCurrencyFormatter = new Intl.NumberFormat('en-IE', {
  maximumFractionDigits: 0,
});

export function formatCurrencyCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const whole = wholeCurrencyFormatter.format(absolute / 100n);
  const fraction = String(absolute % 100n).padStart(2, '0');
  return `${negative ? '−' : ''}€${whole}.${fraction}`;
}

export function formatCurrencyAmount(amount: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(amount);
  if (!match) throw new RangeError('Currency amount must be a decimal value with at most two places.');

  const [, sign, whole, fraction = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return formatCurrencyCents(sign === '-' ? -cents : cents);
}
