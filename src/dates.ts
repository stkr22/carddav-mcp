/**
 * Calendar arithmetic for `upcoming_dates`, on plain year-month-day triples.
 *
 * Deliberately not `Date` objects: a birthday is a day on the calendar and has
 * no time zone, and adding "seven days" to a local midnight is wrong twice a
 * year where the clocks change. Everything here counts days since the epoch in
 * UTC, which has no such gaps, and converts back at the edge.
 */

export interface Ymd {
  year: number;
  month: number;
  day: number;
}

/** Years a card uses as a placeholder for "no year", which are not facts. */
const PLACEHOLDER_YEARS: ReadonlySet<number> = new Set([0, 1604]);

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function toEpochDay({ year, month, day }: Ymd): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function fromEpochDay(days: number): Ymd {
  const date = new Date(days * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

export function addDays(date: Ymd, days: number): Ymd {
  return fromEpochDay(toEpochDay(date) + days);
}

const pad = (value: number, width: number): string =>
  String(value).padStart(width, '0');

export function formatYmd({ year, month, day }: Ymd): string {
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

/** `YYYY-MM-DD`, strictly, and only a date that exists. */
export function parseYmd(text: string): Ymd | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return undefined;
  if (day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
}

/** The calendar day a clock reads, in the zone the process runs in (`TZ`). */
export function todayIn(now: Date): Ymd {
  return {
    year: now.getFullYear(),
    month: now.getMonth() + 1,
    day: now.getDate(),
  };
}

/** The IANA zone `todayIn` reads, for the answer to say. */
export function zoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Longest window a call may cover, so a result stays a result. */
export const MAX_WINDOW_DAYS = 366;

/**
 * The window a call asks for, inclusive at both ends.
 *
 * `days` counts calendar days starting with `from`, so `days: 1` is that one
 * day and `days: 7` is it and the six after — "the next seven days" without
 * the model having to do the subtraction, which is the step it gets wrong.
 */
export function resolveWindow(input: {
  today: Ymd;
  from?: string | undefined;
  to?: string | undefined;
  days?: number | undefined;
}): { from: Ymd; to: Ymd } | { error: string } {
  let from = input.today;
  if (input.from !== undefined && input.from !== 'today') {
    const parsed = parseYmd(input.from);
    if (parsed === undefined) {
      return { error: 'from must be "today" or a date written YYYY-MM-DD.' };
    }
    from = parsed;
  }
  if (input.to !== undefined && input.days !== undefined) {
    return { error: 'pass days or to, not both.' };
  }
  let to: Ymd;
  if (input.to !== undefined) {
    const parsed = parseYmd(input.to);
    if (parsed === undefined) {
      return { error: 'to must be a date written YYYY-MM-DD.' };
    }
    to = parsed;
  } else {
    to = addDays(from, (input.days ?? 7) - 1);
  }
  const span = toEpochDay(to) - toEpochDay(from) + 1;
  if (span < 1) return { error: 'to must not be before from.' };
  if (span > MAX_WINDOW_DAYS) {
    return {
      error:
        `the window is ${span} days; at most ${MAX_WINDOW_DAYS} are covered ` +
        'in one call.',
    };
  }
  return { from, to };
}

/** Whether a stored year is a fact about the person rather than a placeholder. */
export function isKnownYear(year: number | undefined): year is number {
  return year !== undefined && year > 0 && !PLACEHOLDER_YEARS.has(year);
}

export interface Occurrence {
  date: Ymd;
  /** Set when 29 February is observed on the 28th, to say what the card says. */
  shiftedFrom?: string;
}

/**
 * Every occurrence of a month and day inside a window.
 *
 * A window can span New Year, so each calendar year it touches is tried. A
 * 29 February date in a year without one is observed on 28 February: the 28th
 * is the last day the person has certainly been born on, where 1 March is
 * already after it — and the answer says so rather than quietly moving it.
 */
export function occurrencesIn(
  month: number,
  day: number,
  window: { from: Ymd; to: Ymd }
): Occurrence[] {
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(2000, month)) {
    return [];
  }
  const start = toEpochDay(window.from);
  const end = toEpochDay(window.to);
  const found: Occurrence[] = [];
  for (let year = window.from.year; year <= window.to.year; year += 1) {
    const shifted = month === 2 && day === 29 && !isLeapYear(year);
    const date: Ymd = { year, month, day: shifted ? 28 : day };
    const at = toEpochDay(date);
    if (at >= start && at <= end) {
      found.push({
        date,
        ...(shifted ? { shiftedFrom: '02-29' } : {}),
      });
    }
  }
  return found;
}
