import { describe, expect, it } from 'vitest';
import { formatDate } from '../src/utils/date';

describe('formatDate', () => {
	it('formats a date correctly', () => {
		const date = new Date('2026-09-23T12:00:00');

		expect(formatDate(date)).toBe('Sep 23, 2026');
	});
});