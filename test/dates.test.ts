import { describe, expect, it } from 'vitest';

import {
  addDays,
  formatYmd,
  isKnownYear,
  occurrencesIn,
  parseYmd,
  resolveWindow,
  todayIn,
  type Ymd,
} from '../src/dates.js';

const ymd = (text: string): Ymd => parseYmd(text) as Ymd;
const window = (from: string, to: string) => ({ from: ymd(from), to: ymd(to) });
const dates = (month: number, day: number, from: string, to: string) =>
  occurrencesIn(month, day, window(from, to)).map((o) => formatYmd(o.date));

describe('parseYmd', () => {
  it('accepts a date that exists and nothing else', () => {
    expect(parseYmd('2026-11-25')).toEqual({ year: 2026, month: 11, day: 25 });
    expect(parseYmd('2024-02-29')).toBeDefined();
    for (const bad of [
      '2026-02-29',
      '2026-13-01',
      '2026-00-10',
      '26-1-1',
      'today',
      '2026-04-31',
      '',
    ]) {
      expect(parseYmd(bad), bad).toBeUndefined();
    }
  });
});

describe('addDays', () => {
  it('carries across months and years, and over a leap day', () => {
    expect(formatYmd(addDays(ymd('2026-11-25'), 6))).toBe('2026-12-01');
    expect(formatYmd(addDays(ymd('2026-12-30'), 3))).toBe('2027-01-02');
    expect(formatYmd(addDays(ymd('2028-02-27'), 2))).toBe('2028-02-29');
    expect(formatYmd(addDays(ymd('2027-02-27'), 2))).toBe('2027-03-01');
    expect(formatYmd(addDays(ymd('2026-03-01'), -1))).toBe('2026-02-28');
  });
});

describe('todayIn', () => {
  it('reads the calendar day of the clock it is given', () => {
    expect(todayIn(new Date(2026, 10, 25, 23, 59))).toEqual(ymd('2026-11-25'));
    expect(todayIn(new Date(2026, 0, 1, 0, 0))).toEqual(ymd('2026-01-01'));
  });
});

describe('resolveWindow', () => {
  const today = ymd('2026-11-25');

  it('defaults to the next seven days, today included', () => {
    expect(resolveWindow({ today })).toEqual({
      from: today,
      to: ymd('2026-12-01'),
    });
  });

  it('treats days=1 as today alone', () => {
    expect(resolveWindow({ today, days: 1 })).toEqual({
      from: today,
      to: today,
    });
  });

  it('starts from a given day, or from "today"', () => {
    expect(resolveWindow({ today, from: '2026-12-28', days: 7 })).toEqual({
      from: ymd('2026-12-28'),
      to: ymd('2027-01-03'),
    });
    expect(resolveWindow({ today, from: 'today', days: 1 })).toEqual({
      from: today,
      to: today,
    });
  });

  it('takes an explicit end instead of days', () => {
    expect(
      resolveWindow({ today, from: '2026-04-10', to: '2026-04-20' })
    ).toEqual({
      from: ymd('2026-04-10'),
      to: ymd('2026-04-20'),
    });
  });

  it.each([
    [{ days: 3, to: '2026-12-01' }, /not both/],
    [{ from: '2026-12-01', to: '2026-11-01' }, /before from/],
    [{ from: 'tomorrow' }, /YYYY-MM-DD/],
    [{ to: '2026-02-30' }, /YYYY-MM-DD/],
    [{ days: 367 }, /at most 366/],
    [{ from: '2026-01-01', to: '2027-01-02' }, /at most 366/],
  ])('refuses %j', (input, message) => {
    const result = resolveWindow({ today, ...input });
    expect('error' in result && result.error).toMatch(message);
  });

  it('allows a full year including a leap one', () => {
    expect(
      'error' in resolveWindow({ today, from: '2028-01-01', to: '2028-12-31' })
    ).toBe(false);
  });
});

describe('occurrencesIn', () => {
  it('finds a date inside the window, on its first and its last day', () => {
    expect(dates(11, 25, '2026-11-25', '2026-12-01')).toEqual(['2026-11-25']);
    expect(dates(12, 1, '2026-11-25', '2026-12-01')).toEqual(['2026-12-01']);
    expect(dates(12, 2, '2026-11-25', '2026-12-01')).toEqual([]);
    expect(dates(11, 24, '2026-11-25', '2026-12-01')).toEqual([]);
  });

  it('wraps the year end', () => {
    expect(dates(1, 2, '2026-12-28', '2027-01-03')).toEqual(['2027-01-02']);
    expect(dates(12, 30, '2026-12-28', '2027-01-03')).toEqual(['2026-12-30']);
  });

  it('finds a date in both years of a window that spans a year end twice over', () => {
    expect(dates(1, 1, '2026-01-01', '2027-01-01')).toEqual([
      '2026-01-01',
      '2027-01-01',
    ]);
  });

  it('observes 29 February on the 28th in a year without one, and says so', () => {
    const found = occurrencesIn(2, 29, window('2027-02-20', '2027-03-05'));
    expect(found.map((o) => formatYmd(o.date))).toEqual(['2027-02-28']);
    expect(found[0]?.shiftedFrom).toBe('02-29');
  });

  it('keeps 29 February in a leap year', () => {
    const found = occurrencesIn(2, 29, window('2028-02-20', '2028-03-05'));
    expect(found.map((o) => formatYmd(o.date))).toEqual(['2028-02-29']);
    expect(found[0]?.shiftedFrom).toBeUndefined();
  });

  it('does not report the shifted day when the window ends on the 27th', () => {
    expect(dates(2, 29, '2027-02-20', '2027-02-27')).toEqual([]);
  });

  it('refuses a month and day that cannot exist', () => {
    expect(dates(2, 30, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(dates(13, 1, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(dates(4, 31, '2026-01-01', '2026-12-31')).toEqual([]);
    expect(dates(0, 5, '2026-01-01', '2026-12-31')).toEqual([]);
  });
});

describe('isKnownYear', () => {
  it('treats the placeholder years as unknown', () => {
    expect(isKnownYear(1990)).toBe(true);
    expect(isKnownYear(undefined)).toBe(false);
    expect(isKnownYear(1604)).toBe(false);
    expect(isKnownYear(0)).toBe(false);
  });
});
