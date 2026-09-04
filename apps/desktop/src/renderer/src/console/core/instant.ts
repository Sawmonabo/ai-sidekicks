// One reading of a wire instant, for the whole console.
//
// Before this module the console read an RFC 3339 stamp four different ways, and
// three of them were wrong in a way nothing caught:
//
//   • COMPARED AS TEXT. An RFC 3339 instant may carry a numeric offset as readily
//     as `Z`, so one instant has many spellings and two spellings sort by neither:
//     `2026-01-01T10:00:00+02:00` is an hour EARLIER than `2026-01-01T09:00:00Z`
//     and sorts AFTER it in every lexical comparison — `localeCompare`, `<`, `>`.
//     A list ordered that way showed the wrong row as newest.
//   • PARSED WITH `Date.parse` AND NOTHING ELSE. That function is not a validator.
//     It reads a timezone-less `2026-01-01T10:00:00` in the HOST's zone, a
//     date-only `2026-01-01` in UTC, and it NORMALIZES a date that does not exist:
//     `2026-02-30T10:00:00Z` becomes March 2 and `2026-01-01T24:00:00Z` becomes the
//     next day. Each answers a number, so the `Number.isNaN` guard every call site
//     wrote passes and a surface renders an instant the wire never sent.
//   • VALIDATED FIELD BY FIELD AT ONE CALL SITE. Correct where it was written, and
//     invisible to the three sites that were not.
//
// So there is one parse, one comparison, and one place the rule is stated.
//
// THE LIBRARY QUESTION, ANSWERED BY MEASUREMENT.
//
//   • `Temporal` — absent. `typeof globalThis.Temporal` is `"undefined"` on Node
//     22.14 (this repo's floor), and still `"undefined"` on Node 24.18 (measured
//     2026-09-04). The `console-unit` tier runs under Node, not under Electron's
//     V8, so a `Temporal`-based parser would fail the tier that gates every console
//     PR even where Electron's Chromium carried the API. That is the same
//     runtime-range finding `primitives/wire-figures.ts` records for
//     `Intl.DurationFormat`, and it has the same consequence: a guarded two-path
//     implementation would read one way in CI and another in production, which is
//     the single outcome a chokepoint exists to prevent.
//   • `@js-temporal/polyfill` — declined. It ships the whole Temporal object model
//     to buy one predicate, and the console's bundle budget is a gate rather than a
//     preference (`Spec-023 §Console Design (Meridian)`).
//   • `date-fns` `parseISO` — declined, and on correctness rather than on size. It
//     is documented to accept what this console must refuse: a date-only value and
//     a timezone-less value both parse, and the second is read in the host's zone —
//     the exact leniency that made `Date.parse` unusable here.
//   • `zod` (`z.iso.datetime`) — declined, on placement rather than on capability.
//     It validates the calendar and the clock correctly, but the console admits a
//     schema library at exactly one door — `bridge/`, where a daemon reply is parsed
//     against the method's registered shape — and `core/` is the DAG floor, which
//     takes no library at all. A wire SHAPE needs a registry row; an ENCODING of one
//     scalar needs twenty lines, written below, and those lines are also what let
//     this reader follow RFC 3339 §5.6 exactly where zod narrows it (the lowercase
//     `t` / `z` separators that section permits and zod refuses).
//
// ONE NARROWING THIS READER KEEPS, recorded rather than discovered later. RFC 3339
// §5.6 permits a leap second (`23:59:60Z`); the platform's epoch cannot represent
// one, so it reads as malformed here. Nothing this console talks to emits one, and
// it fails CLOSED — an em dash and a row sorted last, never a wrong instant.

import { lossyStringify } from "../../../../shared/wire-errors.js";

/**
 * RFC 3339 §5.6 `date-time`, and nothing wider: `full-date`, a `T` (either case,
 * as that section's note permits), `partial-time` with an optional fraction of any
 * width, then `time-offset` as `Z` (either case) or a signed `HH:MM`.
 *
 * What the groups do NOT admit is the whole design: no date-only value, no
 * timezone-less time, no compact `+0200` offset, no space separator. Each is a form
 * `Date.parse` reads, and each names either no instant or the host's own zone.
 *
 * The grammar checks the digit groups; the calendar and clock checks in
 * {@link parseInstant} check that the digits name a day and a time that exist.
 */
const RFC_3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$/;

const MILLISECONDS_PER_MINUTE = 60_000;

/** Days in `month` of `year`, with the Gregorian leap rule stated in full. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Epoch milliseconds of a UTC calendar date and time the caller has validated. */
function epochMillisecondsOfUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
): number {
  // `Date.UTC` reads a two-digit year as 1900 + year; `setUTCFullYear` does not.
  // Composing at a fixed leap year first keeps a February 29 in year 0004 intact
  // while the year is moved into place.
  const composed = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millisecond));
  composed.setUTCFullYear(year);
  return composed.getTime();
}

/** A stamp this console could read. */
export interface Instant {
  readonly kind: "instant";
  /** Epoch milliseconds. The only number any caller may do arithmetic on. */
  readonly epochMilliseconds: number;
  /** The wire's own spelling, kept so a refusal can quote what it was given. */
  readonly text: string;
}

/**
 * A stamp this console could not read.
 *
 * `epochMilliseconds` is declared here as `undefined` rather than omitted, and that
 * is the whole ergonomic design: TypeScript lets a property be read off a union only
 * when every member declares it, so `parseInstant(iso).epochMilliseconds` types as
 * `number | undefined` with no narrowing ceremony at the call sites that only want
 * the number, while a caller that must tell the two apart still narrows on `kind`.
 * One export serves both, so no second accessor exists to drift from this one.
 */
export interface MalformedInstant {
  readonly kind: "malformed";
  readonly epochMilliseconds?: undefined;
  /** What was given. Never widened into prose here — the caller writes the sentence. */
  readonly text: string;
}

/** What {@link parseInstant} answers. Closed at two arms. */
export type InstantReading = Instant | MalformedInstant;

/**
 * Read one wire instant.
 *
 * TWO CONJUNCTS, IN THIS ORDER, and neither alone is the reading. The grammar
 * answers WHETHER the text is spelled in the encoding the wire declares; the
 * calendar and clock checks then answer whether the digits name a day and a time
 * that exist. Only a value past both is composed into a number, so there is no
 * `Date.parse` here to normalize a day that does not exist into the next one.
 *
 * A fraction wider than milliseconds is TRUNCATED, never rounded: `.9999Z` reads
 * as `.999`, so a reading is never later than the instant the wire named.
 *
 * TOTAL, and the runtime guard is what makes that true rather than the type. A
 * non-string reaching here past the type is the reachable case — this reader is fed
 * wire values the console did not itself validate — and it does NOT simply "match no
 * grammar": `RegExp.prototype.exec` runs `ToString` on its argument first, which
 * THROWS for a null-prototype object, for a symbol, and for any hostile or merely
 * broken `toString`. So the guard runs before the grammar, and it is the only reason
 * the totality claim holds.
 *
 * Such a value is refused like any other malformed one, and the malformed arm quotes
 * what it was given — `text` is declared `string` and is what a refusal renders, so
 * the spelling comes through {@link lossyStringify}, which is total for the same
 * reason this function has to be.
 */
export function parseInstant(text: string): InstantReading {
  if (typeof text !== "string") {
    return { kind: "malformed", text: lossyStringify(text) };
  }
  const match = RFC_3339_DATE_TIME.exec(text);
  if (match === null) {
    return { kind: "malformed", text };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const utcMarker = match[8];
  const offsetSign = match[9];
  const offsetHour = Number(match[10] ?? "0");
  const offsetMinute = Number(match[11] ?? "0");

  const calendarHolds = month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  // Second 60 — the leap second — is the one narrowing the module header records.
  const clockHolds = hour <= 23 && minute <= 59 && second <= 59;
  const offsetHolds = utcMarker !== undefined || (offsetHour <= 23 && offsetMinute <= 59);
  if (!calendarHolds || !clockHolds || !offsetHolds) {
    return { kind: "malformed", text };
  }

  const millisecond = Number(fraction.slice(0, 3).padEnd(3, "0"));
  const localEpochMilliseconds = epochMillisecondsOfUtc(
    year,
    month,
    day,
    hour,
    minute,
    second,
    millisecond,
  );
  // An offset names how far AHEAD of UTC the local clock reads, so the instant is
  // the local reading minus the offset: `10:00+02:00` is `08:00Z`.
  const offsetMilliseconds =
    utcMarker !== undefined
      ? 0
      : (offsetSign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * MILLISECONDS_PER_MINUTE;
  return { kind: "instant", epochMilliseconds: localEpochMilliseconds - offsetMilliseconds, text };
}

/** Which end of the order the newest instant belongs at. */
export type InstantOrder = "oldest-first" | "newest-first";

/**
 * Order two readings.
 *
 * MALFORMED SORTS LAST IN BOTH DIRECTIONS, and that is why this takes the direction
 * as an argument instead of leaving the caller to reverse it. A comparator that only
 * ascends is reversed by swapping its arguments — which reverses where the
 * unreadable values land too, so the same list puts them last when sorted one way
 * and FIRST when sorted the other. A numeric sentinel has the identical defect from
 * the other side: `-Infinity` is least, so it is last ascending and first
 * descending. Handling the arm before the numeric comparison is what makes "a row
 * whose stamp we could not read never displaces one we could" true in both
 * directions.
 *
 * Two unreadable readings TIE, deliberately: they carry no information to order by,
 * so the caller's next sort key decides, exactly as it does for two equal instants.
 *
 * Takes readings rather than strings so a sort parses once per row instead of twice
 * per comparison — the decorate-then-sort shape, and the reason this allocates
 * nothing on the comparison path.
 */
export function compareInstants(
  left: InstantReading,
  right: InstantReading,
  order: InstantOrder = "oldest-first",
): number {
  if (left.kind === "malformed") {
    return right.kind === "malformed" ? 0 : 1;
  }
  if (right.kind === "malformed") {
    return -1;
  }
  const ascending = left.epochMilliseconds - right.epochMilliseconds;
  // `Math.sign` rather than the difference itself: epoch milliseconds are far inside
  // the safe-integer range so the subtraction is exact, but a comparator that
  // returns a magnitude invites a caller to read one, and the only contract `sort`
  // has is the sign.
  return Math.sign(order === "newest-first" ? -ascending : ascending);
}
