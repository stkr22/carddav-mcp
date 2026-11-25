import { z } from 'zod';

import { hasControlCharacters, stripInvisible } from './analyze.js';
import {
  VCARD_PROPS,
  type FilterMatch,
  type PropFilter,
  type VCardProp,
} from './dav-xml.js';
import { ToolInputError } from './errors.js';
import { readList, type ICAL } from './vcard.js';

/**
 * Search filters: what a caller asks, what is sent to the server, and what is
 * checked again here.
 *
 * Three representations, and the gap between them is the point of this file.
 *
 * **What a caller writes** is deliberately flat — `all`, `any`, `none`, each a
 * list of leaves. A recursive schema is the one part of JSON Schema that MCP
 * clients disagree about, and models write a flat shape more reliably than a
 * tree. The only thing it cannot say is `(A and B) or (C and D)`.
 *
 * **What is evaluated** is a tree ({@link Node}), because the query shorthand
 * needs one: `"laura meier"` is an AND of two terms, each an OR over several
 * fields.
 *
 * **What is sent** is one flat list of `prop-filter`s with one `test`, because
 * that is all RFC 6352 can carry. {@link planServerFilter} derives a *superset*
 * of the tree's matches from it — never a subset, since a card the server leaves
 * out can never be recovered — and {@link matchesFilter} makes it exact again
 * on what comes back. The server filter is an optimisation; the local one is
 * the meaning.
 */

/** Operators a caller may use. */
export const FILTER_OPS = [
  'contains',
  'equals',
  'starts_with',
  'ends_with',
  'exists',
  'missing',
] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/** Most leaves one request may carry, across `all`, `any` and `none`. */
export const MAX_FILTER_LEAVES = 20;
/** Most words a `query` is split into. */
export const MAX_QUERY_TERMS = 8;

/** The properties a filter may name. A closed list, shared with the XML layer. */
export const filterField = z.enum(VCARD_PROPS);

const filterValue = z
  .string()
  .max(512)
  .refine(
    (value) => !hasControlCharacters(value),
    'must be a single line without control characters'
  )
  .refine(
    (value) => stripInvisible(value).trim().length > 0,
    'must not be empty'
  );

/** One condition: a property, an operator and (usually) a value. */
export const filterLeaf = z
  .object({
    field: filterField.describe(
      'The vCard property. BDAY and ANNIVERSARY are compared as digits, so ' +
        '"0415" matches 1990-04-15, 19900415 and --0415 alike.'
    ),
    op: z
      .enum(FILTER_OPS)
      .describe(
        'contains, equals, starts_with and ends_with compare text ' +
          'case-insensitively. exists and missing take no value: they ask ' +
          'whether the card has the property at all.'
      ),
    value: filterValue.optional(),
  })
  .refine(
    (leaf) =>
      leaf.op === 'exists' || leaf.op === 'missing'
        ? leaf.value === undefined
        : leaf.value !== undefined,
    {
      message:
        'value is required for contains, equals, starts_with and ends_with, ' +
        'and must be left out for exists and missing',
      path: ['value'],
    }
  );
export type FilterLeaf = z.infer<typeof filterLeaf>;

/** The structured filter, as the tool takes it. */
export const whereSchema = z
  .object({
    all: z
      .array(filterLeaf)
      .max(MAX_FILTER_LEAVES)
      .optional()
      .describe('Every one of these must match.'),
    any: z
      .array(filterLeaf)
      .max(MAX_FILTER_LEAVES)
      .optional()
      .describe('At least one of these must match.'),
    none: z
      .array(filterLeaf)
      .max(MAX_FILTER_LEAVES)
      .optional()
      .describe('None of these may match.'),
  })
  .refine(
    ({ all = [], any = [], none = [] }) =>
      all.length + any.length + none.length <= MAX_FILTER_LEAVES,
    `at most ${MAX_FILTER_LEAVES} conditions in total`
  )
  .describe(
    'A contact matches when all of `all` match, at least one of `any` ' +
      'matches, and none of `none` match. Groups left out are not checked.'
  );
export type Where = z.infer<typeof whereSchema>;

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

export interface Leaf {
  kind: 'leaf';
  field: VCardProp;
  op: FilterOp;
  value?: string;
}
export type Node =
  | Leaf
  | { kind: 'and'; children: Node[] }
  | { kind: 'or'; children: Node[] }
  | { kind: 'not'; child: Node };

function leafOf(source: FilterLeaf): Leaf {
  return {
    kind: 'leaf',
    field: source.field,
    op: source.op,
    ...(source.value === undefined ? {} : { value: source.value }),
  };
}

/** The fields `query` is matched against when `fields` is not given. */
export const DEFAULT_QUERY_FIELDS: readonly VCardProp[] = [
  'FN',
  'NICKNAME',
  'EMAIL',
  'TEL',
  'ORG',
];

/**
 * Builds the tree from what a caller passed.
 *
 * **`query` is split into words, each of which must match** — in any of the
 * fields. A card storing `FN:Meier Laura` is the same person as "Laura Meier",
 * and a phrase search never found her. Splitting only ever adds matches: every
 * card a phrase matched also matches its words.
 *
 * Returns `undefined` for no condition at all, which the caller turns into a
 * refusal.
 */
export function buildFilter(input: {
  query?: string | undefined;
  fields?: readonly VCardProp[] | undefined;
  where?: Where | undefined;
}): Node | undefined {
  const parts: Node[] = [];

  if (input.query !== undefined) {
    const words = input.query.split(/\s+/).filter((word) => word.length > 0);
    if (words.length > MAX_QUERY_TERMS) {
      throw new ToolInputError(
        `carddav-mcp: query has ${words.length} words; at most ` +
          `${MAX_QUERY_TERMS} are matched. Use fewer, or use where.`
      );
    }
    const fields = input.fields ?? DEFAULT_QUERY_FIELDS;
    for (const word of words) {
      parts.push({
        kind: 'or',
        children: fields.map((field): Leaf => ({
          kind: 'leaf',
          field,
          op: 'contains',
          value: word,
        })),
      });
    }
  }

  const { all = [], any = [], none = [] } = input.where ?? {};
  for (const leaf of all) parts.push(leafOf(leaf));
  if (any.length > 0) {
    parts.push({ kind: 'or', children: any.map(leafOf) });
  }
  if (none.length > 0) {
    parts.push({
      kind: 'not',
      child: { kind: 'or', children: none.map(leafOf) },
    });
  }

  if (parts.length === 0) return undefined;
  return parts.length === 1 && parts[0] !== undefined
    ? parts[0]
    : { kind: 'and', children: parts };
}

/** Every property the tree looks at, which the retrieval has to include. */
export function fieldsOf(node: Node): VCardProp[] {
  const found = new Set<VCardProp>();
  const walk = (current: Node): void => {
    if (current.kind === 'leaf') found.add(current.field);
    else if (current.kind === 'not') walk(current.child);
    else current.children.forEach(walk);
  };
  walk(node);
  return [...found];
}

// ---------------------------------------------------------------------------
// Local evaluation — the meaning of a filter
// ---------------------------------------------------------------------------

/** Properties whose value is a date, compared as digits. */
const DATE_FIELDS: ReadonlySet<VCardProp> = new Set(['BDAY', 'ANNIVERSARY']);

const fold = (value: string): string =>
  stripInvisible(value).trim().toLowerCase();
const digitsOf = (value: string): string => value.replace(/\D+/g, '');

/**
 * Whether a card satisfies the tree.
 *
 * Folded through `stripInvisible` on both sides. A card whose `FN` carries a
 * zero-width space between two letters is a card a plain `includes` will not
 * find, and hiding from a search is exactly what that character is there for.
 *
 * A date is compared as its digits, because the same day is stored as
 * `19900415`, `1990-04-15`, `--0415` and `--04-15` depending on the client that
 * wrote it, and a text comparison would find one of the four.
 */
export function matchesFilter(card: ICAL.Component, node: Node): boolean {
  switch (node.kind) {
    case 'and':
      return node.children.every((child) => matchesFilter(card, child));
    case 'or':
      return node.children.some((child) => matchesFilter(card, child));
    case 'not':
      return !matchesFilter(card, node.child);
    case 'leaf':
      return leafMatches(card, node);
  }
}

function leafMatches(card: ICAL.Component, leaf: Leaf): boolean {
  const values = readList(card, leaf.field.toLowerCase());
  if (leaf.op === 'exists') return values.length > 0;
  if (leaf.op === 'missing') return values.length === 0;

  const term = leaf.value ?? '';
  const numeric = DATE_FIELDS.has(leaf.field) && digitsOf(term).length > 0;
  const needle = numeric ? digitsOf(term) : fold(term);
  if (needle.length === 0) return false;

  return values.some((raw) => {
    const value = numeric ? digitsOf(raw) : fold(raw);
    switch (leaf.op) {
      case 'contains':
        return value.includes(needle);
      case 'equals':
        return value === needle;
      case 'starts_with':
        return value.startsWith(needle);
      case 'ends_with':
        return value.endsWith(needle);
    }
    return false;
  });
}

// ---------------------------------------------------------------------------
// The server filter — a superset, never a subset
// ---------------------------------------------------------------------------

/** What goes on the wire for one request. */
export interface ServerPlan {
  test: 'anyof' | 'allof';
  filters: PropFilter[];
  /**
   * True when the server's answer is exactly the tree's, before the local
   * re-check. False when it is a superset and the rest is finished here.
   */
  exact: boolean;
}

/** Properties whose stored text is a structured or comma-separated value. */
const COMPOUND_FIELDS: ReadonlySet<VCardProp> = new Set([
  'N',
  'ORG',
  'ADR',
  'CATEGORIES',
  'NICKNAME',
]);

const WIRE_MATCH: Record<
  Exclude<FilterOp, 'exists' | 'missing'>,
  FilterMatch
> = {
  contains: 'contains',
  equals: 'equals',
  starts_with: 'starts-with',
  ends_with: 'ends-with',
};

/**
 * Whether the server would give the same answer for a leaf as the local check.
 *
 * Only when it provably would. A server compares against the **stored text** —
 * `Analytical Engines;Research`, `history,maths`, `Smith\, Jones` — where the
 * local check compares the parsed values. So:
 *
 * - dates are never sent as text: the stored spelling varies by client;
 * - a compound property is sent only for `contains`, since `equals` against
 *   `Research` would miss `Analytical Engines;Research` on the server and
 *   match here, and a card left out by the server is gone for good;
 * - a term containing `,` `;` or `\` is not sent, because the stored text
 *   escapes them and servers differ on whether they compare before or after.
 *
 * `exists` and `missing` carry no text and are always safe.
 */
function pushable(leaf: Leaf): boolean {
  if (leaf.op === 'exists' || leaf.op === 'missing') return true;
  if (DATE_FIELDS.has(leaf.field)) return false;
  if (COMPOUND_FIELDS.has(leaf.field) && leaf.op !== 'contains') return false;
  return !/[\\,;]/.test(leaf.value ?? '');
}

function wire(leaf: Leaf): PropFilter {
  return {
    field: leaf.field,
    term: leaf.value ?? '',
    match:
      leaf.op === 'exists' || leaf.op === 'missing'
        ? leaf.op
        : WIRE_MATCH[leaf.op],
  };
}

/**
 * One leaf that every card matching `node` must satisfy, if there is one.
 * Any single conjunct of an AND is a necessary condition for it.
 */
function necessaryLeaf(node: Node): Leaf | undefined {
  if (node.kind === 'leaf') return pushable(node) ? node : undefined;
  if (node.kind === 'and') {
    for (const child of node.children) {
      const found = necessaryLeaf(child);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/** Leaves, at least one of which every match satisfies — for an OR branch. */
function alternatives(
  node: Node
): { leaves: Leaf[]; exact: boolean } | undefined {
  if (node.kind === 'leaf') {
    return pushable(node) ? { leaves: [node], exact: true } : undefined;
  }
  if (node.kind === 'or') {
    const leaves: Leaf[] = [];
    let exact = true;
    for (const child of node.children) {
      const inner = alternatives(child);
      if (inner === undefined) return undefined;
      leaves.push(...inner.leaves);
      exact &&= inner.exact;
    }
    return { leaves, exact };
  }
  if (node.kind === 'and') {
    const one = necessaryLeaf(node);
    return one === undefined ? undefined : { leaves: [one], exact: false };
  }
  return undefined;
}

/**
 * The filter to send, or `undefined` when nothing about the tree can safely be
 * narrowed on the server — in which case the whole collection is fetched.
 *
 * Negation is never sent. `negate-condition` on a property with several values
 * means "some value does not match", where `none` means "no value matches", and
 * servers also disagree about a property that is absent.
 */
export function planServerFilter(node: Node): ServerPlan | undefined {
  if (node.kind === 'leaf') {
    return pushable(node)
      ? { test: 'allof', filters: [wire(node)], exact: true }
      : undefined;
  }
  if (node.kind === 'not') return undefined;

  if (node.kind === 'and') {
    const leaves: Leaf[] = [];
    let exact = true;
    for (const child of node.children) {
      if (child.kind === 'leaf' && pushable(child)) leaves.push(child);
      else exact = false;
    }
    if (leaves.length > 0) {
      return { test: 'allof', filters: leaves.map(wire), exact };
    }
    // No plain condition to send; an OR branch still narrows the request.
    for (const child of node.children) {
      const inner = child.kind === 'or' ? planServerFilter(child) : undefined;
      if (inner !== undefined) return { ...inner, exact: false };
    }
    return undefined;
  }

  const options = alternatives(node);
  if (options === undefined) return undefined;
  return {
    test: 'anyof',
    filters: options.leaves.map(wire),
    exact: options.exact,
  };
}
