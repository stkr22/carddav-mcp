import { describe, expect, it } from 'vitest';

import { addressbookSearchBody } from '../src/dav-xml.js';
import {
  buildFilter,
  fieldsOf,
  matchesFilter,
  planServerFilter,
  whereSchema,
  type Node,
} from '../src/filter.js';
import { parseVCard } from '../src/vcard.js';
import { vcard } from './harness.js';

const card = (fields: Record<string, string>) =>
  parseVCard(vcard(fields), 'a test card');

const leaf = (
  field: string,
  op: string,
  value?: string
): Record<string, unknown> => ({
  field,
  op,
  ...(value === undefined ? {} : { value }),
});

const where = (input: unknown) => whereSchema.parse(input);

describe('the where schema', () => {
  it('requires a value for a text operator and refuses one for exists', () => {
    expect(
      whereSchema.safeParse({ all: [leaf('FN', 'contains')] }).success
    ).toBe(false);
    expect(
      whereSchema.safeParse({ all: [leaf('FN', 'exists', 'x')] }).success
    ).toBe(false);
    expect(whereSchema.safeParse({ all: [leaf('FN', 'exists')] }).success).toBe(
      true
    );
  });

  it('refuses a field that is not a vCard property this server names', () => {
    expect(
      whereSchema.safeParse({ all: [leaf('X-EVIL"/><C:x', 'exists')] }).success
    ).toBe(false);
    expect(whereSchema.safeParse({ all: [leaf('fn', 'exists')] }).success).toBe(
      false
    );
  });

  it('refuses a control character, a blank value and too many conditions', () => {
    expect(
      whereSchema.safeParse({ all: [leaf('FN', 'contains', 'a\nb')] }).success
    ).toBe(false);
    expect(
      whereSchema.safeParse({ all: [leaf('FN', 'contains', '​ ')] }).success
    ).toBe(false);
    const many = Array.from({ length: 21 }, () => leaf('FN', 'exists'));
    expect(whereSchema.safeParse({ all: many }).success).toBe(false);
    expect(
      whereSchema.safeParse({
        all: many.slice(0, 10),
        any: many.slice(0, 10),
        none: many.slice(0, 1),
      }).success
    ).toBe(false);
  });
});

describe('buildFilter', () => {
  it('returns nothing for no condition', () => {
    expect(buildFilter({})).toBeUndefined();
    expect(buildFilter({ where: where({}) })).toBeUndefined();
    expect(buildFilter({ query: '   ' })).toBeUndefined();
  });

  it('finds "Laura Meier" on a card stored as "Meier Laura"', () => {
    const filter = buildFilter({ query: 'Laura Meier' }) as Node;
    expect(matchesFilter(card({ FN: 'Meier Laura' }), filter)).toBe(true);
    expect(matchesFilter(card({ FN: 'Meier Hanna' }), filter)).toBe(false);
  });

  it('lets each word match in a different field', () => {
    const filter = buildFilter({ query: 'ada navy' }) as Node;
    expect(matchesFilter(card({ FN: 'Ada', ORG: 'Navy' }), filter)).toBe(true);
  });

  it('refuses a query of too many words', () => {
    expect(() => buildFilter({ query: 'a b c d e f g h i' })).toThrow(
      /at most 8/
    );
  });

  it('collects the fields a filter reads', () => {
    const filter = buildFilter({
      query: 'x',
      fields: ['FN'],
      where: where({
        all: [leaf('NOTE', 'exists')],
        none: [leaf('URL', 'exists')],
      }),
    }) as Node;
    expect(fieldsOf(filter).toSorted()).toEqual(['FN', 'NOTE', 'URL']);
  });
});

describe('matchesFilter', () => {
  const ada = card({
    FN: 'Ada Lovelace',
    ORG: 'Analytical Engines;Research',
    'EMAIL;TYPE=WORK': 'ada@example.net',
    NOTE: 'First programmer.',
    CATEGORIES: 'history,maths',
  });
  const run = (input: unknown) =>
    matchesFilter(ada, buildFilter({ where: where(input) }) as Node);

  it('implements each text operator, case-insensitively', () => {
    expect(run({ all: [leaf('FN', 'contains', 'LOVE')] })).toBe(true);
    expect(run({ all: [leaf('FN', 'equals', 'ada lovelace')] })).toBe(true);
    expect(run({ all: [leaf('FN', 'equals', 'ada')] })).toBe(false);
    expect(run({ all: [leaf('FN', 'starts_with', 'ada')] })).toBe(true);
    expect(run({ all: [leaf('FN', 'ends_with', 'lace')] })).toBe(true);
    expect(run({ all: [leaf('FN', 'ends_with', 'ada')] })).toBe(false);
  });

  it('matches any value of a multi-valued property', () => {
    expect(run({ all: [leaf('CATEGORIES', 'equals', 'maths')] })).toBe(true);
  });

  it('implements exists and missing', () => {
    expect(run({ all: [leaf('NOTE', 'exists')] })).toBe(true);
    expect(run({ all: [leaf('URL', 'exists')] })).toBe(false);
    expect(run({ all: [leaf('URL', 'missing')] })).toBe(true);
  });

  it('combines all, any and none', () => {
    expect(
      run({
        all: [leaf('FN', 'contains', 'ada')],
        any: [
          leaf('FN', 'contains', 'zzz'),
          leaf('NOTE', 'contains', 'programmer'),
        ],
        none: [leaf('URL', 'exists')],
      })
    ).toBe(true);
    expect(
      run({
        all: [leaf('FN', 'contains', 'ada')],
        none: [leaf('NOTE', 'contains', 'programmer')],
      })
    ).toBe(false);
    // `none` means no value matches, not that some value does not.
    expect(run({ none: [leaf('CATEGORIES', 'equals', 'maths')] })).toBe(false);
  });

  it('sees through a zero-width space', () => {
    const hidden = card({ FN: 'Ad​a Zero' });
    expect(
      matchesFilter(hidden, buildFilter({ query: 'ada zero' }) as Node)
    ).toBe(true);
  });
});

const find = (value: string, op: string, bday: string) =>
  matchesFilter(
    card({ BDAY: bday }),
    buildFilter({ where: where({ all: [leaf('BDAY', op, value)] }) }) as Node
  );

describe('dates', () => {
  const spellings = ['19900415', '1990-04-15', '--0415', '--04-15'];

  it.each(spellings)('finds 15 April by month and day in %s', (bday) => {
    expect(find('0415', 'contains', bday)).toBe(true);
    expect(find('04-15', 'contains', bday)).toBe(true);
    expect(find('0416', 'contains', bday)).toBe(false);
  });

  it('compares a year, a full date and an end as digits', () => {
    expect(find('1990', 'starts_with', '1990-04-15')).toBe(true);
    expect(find('1990', 'starts_with', '--0415')).toBe(false);
    expect(find('1990-04-15', 'equals', '19900415')).toBe(true);
    expect(find('15', 'ends_with', '--04-15')).toBe(true);
  });

  it('falls back to text for a free-text date', () => {
    const text = card({ 'BDAY;VALUE=text': 'Advent' });
    const filter = buildFilter({
      where: where({ all: [leaf('BDAY', 'contains', 'advent')] }),
    }) as Node;
    expect(matchesFilter(text, filter)).toBe(true);
  });
});

const plan = (input: Parameters<typeof buildFilter>[0]) =>
  planServerFilter(buildFilter(input) as Node);

describe('planServerFilter', () => {
  it('sends a single condition exactly', () => {
    const result = plan({
      where: where({ all: [leaf('TITLE', 'starts_with', 'Co')] }),
    });
    expect(result).toEqual({
      test: 'allof',
      exact: true,
      filters: [{ field: 'TITLE', term: 'Co', match: 'starts-with' }],
    });
  });

  it('sends all as allof and any as anyof, exactly', () => {
    expect(
      plan({
        where: where({
          all: [leaf('TITLE', 'contains', 'a'), leaf('NOTE', 'exists')],
        }),
      })
    ).toMatchObject({ test: 'allof', exact: true });
    expect(
      plan({
        where: where({
          any: [leaf('TITLE', 'contains', 'a'), leaf('NOTE', 'exists')],
        }),
      })
    ).toMatchObject({ test: 'anyof', exact: true });
  });

  it('sends a one-word query as one anyof over the fields', () => {
    const result = plan({ query: 'ada' });
    expect(result?.test).toBe('anyof');
    expect(result?.filters).toHaveLength(5);
    expect(result?.exact).toBe(true);
  });

  it('narrows a multi-word query to its first word and says it is not exact', () => {
    const result = plan({ query: 'laura meier' });
    expect(result?.test).toBe('anyof');
    expect(result?.exact).toBe(false);
    expect(result?.filters.every((filter) => filter.term === 'laura')).toBe(
      true
    );
  });

  it('sends the plain conditions of a mixed filter and keeps the rest local', () => {
    const result = plan({
      where: where({
        all: [leaf('TITLE', 'contains', 'lead')],
        any: [leaf('NOTE', 'contains', 'a'), leaf('URL', 'exists')],
        none: [leaf('EMAIL', 'exists')],
      }),
    });
    expect(result).toMatchObject({ test: 'allof', exact: false });
    expect(result?.filters).toHaveLength(1);
  });

  it('never sends a negation', () => {
    expect(
      plan({ where: where({ none: [leaf('FN', 'contains', 'a')] }) })
    ).toBeUndefined();
  });

  it('never sends a date as text, but does send its existence', () => {
    expect(
      plan({ where: where({ all: [leaf('BDAY', 'contains', '0415')] }) })
    ).toBeUndefined();
    expect(
      plan({ where: where({ all: [leaf('BDAY', 'exists')] }) })
    ).toMatchObject({
      exact: true,
    });
  });

  it('does not send an OR with a branch it cannot send', () => {
    expect(
      plan({
        where: where({
          any: [leaf('FN', 'contains', 'a'), leaf('BDAY', 'contains', '04')],
        }),
      })
    ).toBeUndefined();
  });

  it('sends only contains against a compound property', () => {
    expect(
      plan({ where: where({ all: [leaf('ORG', 'equals', 'Research')] }) })
    ).toBeUndefined();
    expect(
      plan({ where: where({ all: [leaf('ORG', 'contains', 'Research')] }) })
    ).toBeDefined();
  });

  it('does not send a term whose stored spelling is escaped', () => {
    expect(
      plan({ where: where({ all: [leaf('NOTE', 'contains', 'a, b')] }) })
    ).toBeUndefined();
    expect(
      plan({ where: where({ all: [leaf('NOTE', 'contains', 'a;b')] }) })
    ).toBeUndefined();
    expect(
      plan({ where: where({ all: [leaf('NOTE', 'contains', 'a\\b')] }) })
    ).toBeUndefined();
  });

  it('is a superset of the tree for any card, for every leaf of an OR of ANDs', () => {
    const tree: Node = {
      kind: 'or',
      children: [
        {
          kind: 'and',
          children: [
            { kind: 'leaf', field: 'ORG', op: 'contains', value: 'acme' },
            { kind: 'leaf', field: 'BDAY', op: 'contains', value: '0415' },
          ],
        },
        { kind: 'leaf', field: 'TITLE', op: 'contains', value: 'ceo' },
      ],
    };
    const result = planServerFilter(tree);
    expect(result?.exact).toBe(false);
    expect(result?.filters.map((filter) => filter.field).toSorted()).toEqual([
      'ORG',
      'TITLE',
    ]);
  });
});

describe('the request body for a plan', () => {
  it('writes allof, exists and is-not-defined', () => {
    const body = addressbookSearchBody(
      [
        { field: 'TITLE', term: 'a<b', match: 'starts-with' },
        { field: 'URL', term: '', match: 'exists' },
        { field: 'NOTE', term: '', match: 'missing' },
      ],
      { test: 'allof' }
    );
    expect(body).toContain('<C:filter test="allof">');
    expect(body).toContain('<C:prop-filter name="URL"/>');
    expect(body).toContain('<C:is-not-defined/>');
    expect(body).toContain('match-type="starts-with">a&lt;b</C:text-match>');
    // No term reaches a body for a filter that carries none.
    expect(body.match(/<C:text-match/g)).toHaveLength(1);
  });

  it('still defaults to anyof and contains', () => {
    const body = addressbookSearchBody([{ field: 'FN', term: 'a' }]);
    expect(body).toContain('<C:filter test="anyof">');
    expect(body).toContain('match-type="contains"');
  });

  it('refuses a line break in a term, whatever the match type', () => {
    expect(() =>
      addressbookSearchBody([{ field: 'FN', term: 'a\r\nb', match: 'equals' }])
    ).toThrow(/control characters/);
  });
});
