import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';

import {
  formatYmd,
  isKnownYear,
  MAX_WINDOW_DAYS,
  occurrencesIn,
  resolveWindow,
  toEpochDay,
  todayIn,
  zoneName,
} from '../dates.js';
import { SUMMARY_PROPS } from '../dav-xml.js';
import { MAX_MAX_ENTRIES } from '../config.js';
import { ToolInputError } from '../errors.js';
import { boundedLimit, searchCards } from '../entries.js';
import type { Node } from '../filter.js';
import { notes, untrustedFields } from '../output-schema.js';
import { run, untrustedResult } from '../result.js';
import { addressBooksParam, limitParam, offsetParam } from '../schema.js';
import { shapeSummary } from '../shape.js';
import { parseVCard, readDate } from '../vcard.js';
import { READ_ONLY } from './annotations.js';
import {
  applyLimit,
  limitNote,
  resolveBooks,
  type ToolContext,
} from './common.js';

const KINDS = ['birthday', 'anniversary'] as const;
type Kind = (typeof KINDS)[number];

const PROPERTY: Record<Kind, 'bday' | 'anniversary'> = {
  birthday: 'bday',
  anniversary: 'anniversary',
};

/** What an event carries of the contact — enough to name them, nothing more. */
const CONTACT_KEYS = ['id', 'formatted_name', 'nickname', 'organization'];

/** The clock, replaceable in a test without touching the system's. */
export const clock = { now: (): Date => new Date() };

/**
 * `upcoming_dates`: birthdays and anniversaries inside a window.
 *
 * CardDAV has no date or range filter — RFC 6352 offers text matching and
 * nothing else, and a birthday is stored as `19900415`, `1990-04-15` or
 * `--0415` depending on the client — so the question cannot be put to the
 * server. What can is "has a BDAY at all", which narrows the request, and the
 * calendar arithmetic runs here, in `dates.ts`, where a leap day and a New Year
 * are cases rather than surprises.
 */
export function registerDateTools(
  server: McpServer,
  context: ToolContext
): void {
  server.registerTool(
    'upcoming_dates',
    {
      title: 'Upcoming birthdays and anniversaries',
      description:
        'Birthdays and anniversaries that fall inside a window of days, ' +
        'sorted by date, with the age or the number of years where the card ' +
        'states a year. Use this instead of searching for a date: it does the ' +
        'calendar arithmetic (today, the next 7 days, month and year ends, ' +
        '29 February). `days` counts calendar days starting at `from`, so ' +
        'days=1 is only that day and days=7 is the next week. The day is ' +
        'read in the server’s own time zone, which the answer names.',
      inputSchema: z.object({
        from: z
          .string()
          .max(10)
          .optional()
          .describe('First day: "today" (the default) or YYYY-MM-DD.'),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_WINDOW_DAYS)
          .optional()
          .describe(
            'Calendar days in the window, counting `from` itself. Default 7.'
          ),
        to: z
          .string()
          .max(10)
          .optional()
          .describe('Last day, YYYY-MM-DD, instead of `days`.'),
        kinds: z
          .array(z.enum(KINDS))
          .min(1)
          .max(2)
          .optional()
          .describe('birthday, anniversary or both (the default).'),
        address_books: addressBooksParam,
        limit: limitParam,
        offset: offsetParam,
      }),
      annotations: READ_ONLY,
      outputSchema: z.object({
        ...untrustedFields,
        today: z.string().describe('The current day, YYYY-MM-DD.'),
        timezone: z.string().describe('The zone "today" was read in.'),
        from: z.string(),
        to: z.string(),
        events: z.array(
          z
            .looseObject({
              date: z
                .string()
                .describe('The day it falls on in the window, YYYY-MM-DD.'),
              kind: z.enum(KINDS),
              days_until: z
                .number()
                .int()
                .describe('Days from today; negative for a past window.'),
              id: z.string().describe('The contact, for get_contact.'),
              formatted_name: z.string().optional(),
              nickname: z.string().optional(),
              organization: z.string().optional(),
              year_known: z.boolean(),
              years: z
                .number()
                .int()
                .optional()
                .describe(
                  'The age being reached, or years of the anniversary. ' +
                    'Absent when the card states no year.'
                ),
              shifted_from: z
                .string()
                .optional()
                .describe(
                  '"02-29" when a leap-day date is observed on 28 February.'
                ),
            })
            .meta({ additionalProperties: true })
        ),
        count: z.number().int(),
        total: z.number().int().describe('Events in the window, before limit.'),
        matched_with: z.string(),
        notes,
      }),
    },
    async (args) =>
      run(async () => {
        const kinds: readonly Kind[] = args.kinds ?? KINDS;
        const today = todayIn(clock.now());
        const window = resolveWindow({
          today,
          from: args.from,
          to: args.to,
          days: args.days,
        });
        if ('error' in window) {
          throw new ToolInputError(`carddav-mcp: ${window.error}`);
        }
        const limit = boundedLimit(
          args.limit,
          context.config.maxEntries,
          MAX_MAX_ENTRIES
        );
        const { books } = await resolveBooks(context, args.address_books);

        // Only cards that have one of the dates are worth fetching. The server
        // can answer that much; the rest of the question it cannot.
        const filter: Node = {
          kind: 'or',
          children: kinds.map((kind) => ({
            kind: 'leaf',
            field: kind === 'birthday' ? 'BDAY' : 'ANNIVERSARY',
            op: 'exists',
          })),
        };
        const outcome = await searchCards(
          context.api,
          books,
          filter,
          SUMMARY_PROPS
        );

        const events: Record<string, unknown>[] = [];
        let unusable = 0;
        for (const document of outcome.documents) {
          let card;
          let contact: Record<string, unknown>;
          try {
            card = parseVCard(document.vcf, 'a card in the address book');
            const entry = shapeSummary(
              card,
              document.book,
              document.resourceName,
              document.etag,
              true
            );
            if (entry.is_group === true) continue;
            contact = Object.fromEntries(
              CONTACT_KEYS.filter((key) => entry[key] !== undefined).map(
                (key) => [key, entry[key]]
              )
            );
          } catch {
            unusable += 1;
            continue;
          }
          for (const kind of kinds) {
            const date = readDate(card, PROPERTY[kind]);
            if (date?.month === undefined || date.day === undefined) {
              if (date !== undefined) unusable += 1;
              continue;
            }
            const known = isKnownYear(date.year);
            for (const occurrence of occurrencesIn(
              date.month,
              date.day,
              window
            )) {
              const years =
                known && date.year !== undefined
                  ? occurrence.date.year - date.year
                  : undefined;
              events.push({
                date: formatYmd(occurrence.date),
                kind,
                days_until: toEpochDay(occurrence.date) - toEpochDay(today),
                ...contact,
                year_known: known,
                ...(years !== undefined && years >= 0 ? { years } : {}),
                ...(occurrence.shiftedFrom === undefined
                  ? {}
                  : { shifted_from: occurrence.shiftedFrom }),
              });
            }
          }
        }

        events.sort(
          (left, right) =>
            String(left.date).localeCompare(String(right.date)) ||
            String(left.formatted_name ?? '').localeCompare(
              String(right.formatted_name ?? '')
            ) ||
            String(left.kind).localeCompare(String(right.kind))
        );
        const offset = args.offset ?? 0;
        const { shown, dropped } = applyLimit(events, limit, offset);

        const collected = [...outcome.notes];
        if (dropped > 0) collected.push(limitNote(dropped, limit, offset));
        if (unusable > 0) {
          collected.push(
            `${unusable} card(s) had a date or a card this server could not ` +
              'read as a month and day, and were left out.'
          );
        }
        if (events.length === 0) {
          collected.push(
            `No ${kinds.join(' or ')} falls between ${formatYmd(window.from)} ` +
              `and ${formatYmd(window.to)} in ${books.length} address ` +
              `book${books.length === 1 ? '' : 's'}. Contacts without that ` +
              'date on the card are not counted.'
          );
        }

        return untrustedResult({
          today: formatYmd(today),
          timezone: zoneName(),
          from: formatYmd(window.from),
          to: formatYmd(window.to),
          events: shown,
          count: shown.length,
          total: events.length,
          matched_with: outcome.path,
          ...(collected.length > 0 ? { notes: collected } : {}),
        });
      })
  );
}
