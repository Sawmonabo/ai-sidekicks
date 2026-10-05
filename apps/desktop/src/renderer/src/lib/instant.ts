// One reading of a wire instant for the whole app. An RFC 3339 instant has many spellings that
// sort by neither text order nor `Date.parse`: `2026-01-01T10:00:00+02:00` is earlier than
// `2026-01-01T09:00:00Z` yet sorts after it as text. `Date.parse` is no validator: it reads a
// timezone-less time in the host's zone and normalizes a day that does not exist (`2026-02-30`).
//
// No library: `Temporal` is absent on this repo's Node 24 floor and the `renderer` tier runs
// under Node; the polyfill's weight is a bundle-budget cost; `date-fns` `parseISO` accepts
// date-only and timezone-less values; `zod` is admitted only in `services/` and narrows the
// lowercase `t` and `z` that RFC 3339 section 5.6 permits.
//
// A leap second (`23:59:60Z`) reads as malformed because the platform's epoch cannot represent it;
// it fails closed, as an em dash and a row sorted last, never a wrong instant.

import { lossyStringify } from "./wire-errors.js";

/**
 * RFC 3339 section 5.6 `date-time`, and nothing wider: `full-date`, a `T` (either case),
 * `partial-time` with an optional fraction of any width, then `Z` (either case) or a signed
 * `HH:MM` offset. It admits no date-only value, timezone-less time, compact `+0200` offset or
 * space separator, each of which `Date.parse` reads as no instant or the host's zone.
 *
 * It checks digit groups only; {@link parseInstant} checks the calendar, the clock and the
 * {@link InstantOffsetPolicy}. A `"utc-only"` reader narrows this one pattern, never a second.
 */
const RFC_3339_DATE_TIME = new RegExp(
  String.raw`^(\d{4})-(\d{2})-(\d{2})([Tt])(\d{2}):(\d{2}):(\d{2})` +
    String.raw`(?:\.(\d+))?(?:([Zz])|([+-])(\d{2}):(\d{2}))$`,
);

/**
 * Milliseconds in a second. The app does arithmetic only on epoch milliseconds, so every
 * duration is a multiple of these factors; each is derived from the one before it so a wrong
 * factor is a wrong multiplier, not a mistyped magnitude.
 */
export const MILLISECONDS_PER_SECOND = 1_000;
/** Milliseconds in a minute. */
export const MILLISECONDS_PER_MINUTE: number = 60 * MILLISECONDS_PER_SECOND;
/** Milliseconds in an hour. */
export const MILLISECONDS_PER_HOUR: number = 60 * MILLISECONDS_PER_MINUTE;
/** Milliseconds in a day, ignoring daylight-saving shifts. */
export const MILLISECONDS_PER_DAY: number = 24 * MILLISECONDS_PER_HOUR;

/** A stamp this app could read. */
export interface Instant {
  readonly kind: "instant";
  /** Epoch milliseconds. The only number any caller may do arithmetic on. */
  readonly epochMilliseconds: number;
  /** The wire's own spelling, kept so a refusal can quote it. */
  readonly text: string;
}

/**
 * A stamp this app could not read.
 *
 * `epochMilliseconds` is declared `undefined` rather than omitted so it can be read off the
 * union as `number | undefined` without narrowing; a caller that must tell the arms apart
 * narrows on `kind`.
 */
export interface MalformedInstant {
  readonly kind: "malformed";
  readonly epochMilliseconds?: undefined;
  /** What was given; the caller writes any sentence about it. */
  readonly text: string;
}

/** What {@link parseInstant} answers. */
export type InstantReading = Instant | MalformedInstant;

/**
 * Which of RFC 3339's spellings the caller's wire contract declares; the two contracts the
 * app reads declare different encodings.
 *
 *   - `"any-offset"`: `Z` or `z`, a signed `HH:MM` offset, and either case of `T`. The default.
 *   - `"utc-only"`: `Z` and `T`, exactly, so a producer's encoding change is reported instead of
 *     absorbed.
 */
export type InstantOffsetPolicy = "any-offset" | "utc-only";

/** Which end of the order the newest instant belongs at. */
export type InstantOrder = "oldest-first" | "newest-first";

/**
 * Read one wire instant. Total: it never throws, whatever it is given.
 *
 * A value must pass the grammar, then the calendar and clock checks, then `offsetPolicy`,
 * before it is composed into a number; there is no `Date.parse` to normalize a day that does
 * not exist. A fraction wider than milliseconds is truncated, never rounded, so a reading is
 * never later than the wire's instant.
 *
 * The runtime `typeof` guard runs first because the input is wire data the app did not
 * validate, and `RegExp.prototype.exec` throws on a null-prototype object, a symbol or a broken
 * `toString`. Such a value is malformed, and its `text` comes from {@link lossyStringify}.
 */
export function parseInstant(
  text: string,
  offsetPolicy: InstantOffsetPolicy = "any-offset",
): InstantReading {
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
  const separator = match[4];
  const hour = Number(match[5]);
  const minute = Number(match[6]);
  const second = Number(match[7]);
  const fraction = match[8] ?? "";
  const utcMarker = match[9];
  const offsetSign = match[10];
  const offsetHour = Number(match[11] ?? "0");
  const offsetMinute = Number(match[12] ?? "0");

  const calendarHolds = month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
  // Second 60, the leap second, is refused (see the header).
  const clockHolds = hour <= 23 && minute <= 59 && second <= 59;
  const offsetHolds = utcMarker !== undefined || (offsetHour <= 23 && offsetMinute <= 59);
  // Covers both narrowings of a UTC-only contract: an offset leaves `utcMarker` undefined, and
  // a lowercase `z` is not `Z`.
  const policyHolds = offsetPolicy === "any-offset" || (utcMarker === "Z" && separator === "T");
  if (!calendarHolds || !clockHolds || !offsetHolds || !policyHolds) {
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
  // The offset is how far ahead of UTC the local clock reads: `10:00+02:00` is `08:00Z`.
  const offsetMilliseconds =
    utcMarker !== undefined
      ? 0
      : (offsetSign === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * MILLISECONDS_PER_MINUTE;
  return { kind: "instant", epochMilliseconds: localEpochMilliseconds - offsetMilliseconds, text };
}

/**
 * Order two readings; malformed readings sort last in both directions.
 *
 * `order` is an argument because swapping arguments to reverse a sort would also move the
 * unreadable values to the front. Two malformed readings tie, so the caller's next sort key
 * decides. It takes readings so a sort parses once per row, not twice per comparison.
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
  // `sort` only defines the sign, so return the sign rather than a magnitude.
  return Math.sign(order === "newest-first" ? -ascending : ascending);
}

/** Days in `month` of `year`, by the Gregorian leap rule. */
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
  // `Date.UTC` reads a two-digit year as 1900 + year; `setUTCFullYear` does not. Composing at a
  // fixed leap year first keeps February 29 of year 0004 intact.
  const composed = new Date(Date.UTC(2000, month - 1, day, hour, minute, second, millisecond));
  composed.setUTCFullYear(year);
  return composed.getTime();
}
