import { describe, expect, it } from 'vitest';
import {
  APP_CURRENCY,
  formatCurrencyAmount,
  formatCurrencyCents,
} from '../src/lib/currencyFormatting';

describe('single-currency EUR formatting', () => {
  it('identifies EUR as the application currency', () => {
    expect(APP_CURRENCY).toBe('EUR');
  });

  it.each([
    ['0.01', '€0.01'],
    ['1234.5', '€1,234.50'],
    ['-0.01', '−€0.01'],
  ])('formats the decimal amount %s as %s without floating-point conversion', (amount, expected) => {
    expect(formatCurrencyAmount(amount)).toBe(expected);
  });

  it('formats signed minor units consistently', () => {
    expect(formatCurrencyCents(123450n)).toBe('€1,234.50');
    expect(formatCurrencyCents(-1n)).toBe('−€0.01');
  });

  it('rejects amounts that are not valid decimal currency values', () => {
    expect(() => formatCurrencyAmount('1.001')).toThrow(RangeError);
    expect(() => formatCurrencyAmount('1e3')).toThrow(RangeError);
  });
});
