// Wire figures: the app's whole formatting policy. A figure the wire supplies renders
// verbatim, a quantity the app derives renders through `Intl`, and the app does no
// arithmetic on a wire figure outside `Intl`.
//
// The one exception is byte quantities. `Intl` has no kibibyte unit (`unit: "byte"` with compact
// notation scales by 1000, which disagrees with every other tool), so only `formatByteQuantity`
// scales by powers of 1024, renders the scaled number through `Intl.NumberFormat`, and appends a
// label from `B / KiB / MiB / GiB / TiB`. Durations, counts, rates and relative times stay
// Intl-only. Byte-for-byte wire strings (ids, digests, versions, state names) are never
// transformed, not even trimmed: a truncated id is a wrong id.
//
// The `Intl` instances and their caches live in `intl-formatter-cache.ts`. Time readings take
// their instant from `instant.ts`, not `Date.parse`, so display and ordering read a stamp the same
// way: `Date.parse` normalizes `2026-02-30T10:00:00Z` into March and reads a zone-less stamp
// in the host's zone. An unreadable stamp renders the em dash used for any figure this module
// cannot stand behind.

import { parseInstant } from "./instant.js";
import {
  dateTimeFormatFor,
  dollarFormatFor,
  numberFormatFor,
  relativeTimeFormatFor,
} from "./intl-formatter-cache.js";

/** The closed byte-unit set, ascending; the index is the power of 1024. */
export const BYTE_UNIT_LABELS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** One byte-unit label, in binary prefixes because the scaling is by 1024. */
export type ByteUnitLabel = (typeof BYTE_UNIT_LABELS)[number];

/** The byte scaling step. */
export const BYTE_UNIT_STEP = 1024;

/** A formatted byte quantity, kept decomposed so a caller can style the unit. */
export interface FormattedByteQuantity {
  /** The scaled number, already through `Intl.NumberFormat`. */
  readonly value: string;
  readonly unit: ByteUnitLabel;
  /** `value` and `unit` joined with a non-breaking space. */
  readonly text: string;
}

/** One member of a structured wire value, ready to render as a pair. */
export interface WireDescriptorEntry {
  readonly key: string;
  /** The member's value, as it will be shown. Wire-verbatim for a string. */
  readonly value: string;
}

/**
 * The one place in the app that scales a byte figure. Whole bytes render with no fraction
 * (`512 B`); scaled units get one fraction digit up to `99.9`, then none, which keeps column width
 * stable without lying about precision. A negative or non-finite input renders an em dash.
 */
export function formatByteQuantity(byteCount: number, locale?: string): FormattedByteQuantity {
  if (!Number.isFinite(byteCount) || byteCount < 0) {
    return { value: "—", unit: "B", text: "—" };
  }
  let scaled = byteCount;
  let unitIndex = 0;
  while (scaled >= BYTE_UNIT_STEP && unitIndex < BYTE_UNIT_LABELS.length - 1) {
    scaled /= BYTE_UNIT_STEP;
    unitIndex += 1;
  }
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? "B";
  // Test the threshold on the rounded number: 102350 B scales to 99.951, which would pick one
  // fraction digit and render "100.0", a five-character figure in a four-character column.
  const roundedToOneDigit = Math.round(scaled * 10) / 10;
  const fractionDigits = unitIndex === 0 || roundedToOneDigit >= 100 ? 0 : 1;
  const value = numberFormatFor(fractionDigits === 0 ? "wholeNumber" : "oneDecimal", locale).format(
    scaled,
  );
  // A no-break space as an escape (the literal is invisible in diffs and banned by
  // `no-irregular-whitespace`) so a figure never wraps away from its unit.
  return { value, unit, text: `${value}\u00A0${unit}` };
}

/**
 * A string the wire supplied (an id, digest, version or state name). The identity function, so a
 * call site states that no transformation is intended.
 */
export function formatWireString(value: string): string {
  return value;
}

/**
 * A structured wire value (such as an approval's `resourceDescriptor`) decomposed into renderable
 * pairs. A string member renders verbatim with no added quotes; every other member renders as
 * JSON, and `undefined` as a named unset text rather than being dropped. Insertion order is kept,
 * since it is the order the daemon meant.
 */
export function formatWireDescriptor(
  descriptor: Readonly<Record<string, unknown>>,
): readonly WireDescriptorEntry[] {
  return Object.entries(descriptor).map(([key, value]) => ({
    key,
    value: formatDescriptorMember(value),
  }));
}

/** What an `undefined` member reads as; copy, not a value. */
const UNSET_DESCRIPTOR_MEMBER_TEXT = "(no value)";

/** A count the app derived, grouped per locale, never abbreviated. Non-finite is an em dash. */
export function formatCount(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return numberFormatFor("count", locale).format(value);
}

/**
 * A duration in milliseconds: digital (`1:05`, `1:02:03`) at one minute and above, `1.2 s` below
 * it, and milliseconds under a second, since 340 ms is not "0.3 s" to anyone debugging. Every
 * numeral passes through `Intl`; only the `:` separators are ours.
 */
export function formatDuration(milliseconds: number, locale?: string): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "—";
  }
  if (milliseconds < 1000) {
    return `${numberFormatFor("wholeNumber", locale).format(milliseconds)} ms`;
  }
  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) {
    return `${numberFormatFor("upToOneDecimal", locale).format(totalSeconds)} s`;
  }
  // Truncated, not rounded: 1:00 for 59.6 s would claim a boundary the run did not cross.
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const bare = numberFormatFor("bareDigits", locale);
  const padded = numberFormatFor("twoDigits", locale);
  return hours > 0
    ? `${bare.format(hours)}:${padded.format(minutes)}:${padded.format(seconds)}`
    : `${bare.format(minutes)}:${padded.format(seconds)}`;
}

/**
 * A duration the wire states in whole days (a retention window). The unit is part of the figure,
 * so the whole text comes from `Intl` with `style: "unit"`, which handles the plural and the
 * locale's own word; `formatDuration` would render 7 days as `168:00:00`. A fractional input
 * renders whole. Non-finite and negative inputs render an em dash.
 */
export function formatDayDuration(days: number, locale?: string): string {
  if (!Number.isFinite(days) || days < 0) {
    return "—";
  }
  return numberFormatFor("dayDuration", locale).format(days);
}

/**
 * A relative time through `Intl.RelativeTimeFormat`. The unit is chosen by magnitude from two
 * instants the app holds; an unreadable stamp renders an em dash.
 */
export function formatRelativeTime(
  fromIso: string,
  nowMilliseconds: number,
  locale?: string,
): string {
  const from = parseInstant(fromIso);
  if (from.kind === "malformed") {
    return "—";
  }
  const deltaSeconds = (from.epochMilliseconds - nowMilliseconds) / 1000;
  const relativeTimeFormat = relativeTimeFormatFor(locale);
  const absoluteSeconds = Math.abs(deltaSeconds);
  if (absoluteSeconds < 60) {
    return relativeTimeFormat.format(Math.round(deltaSeconds), "second");
  }
  if (absoluteSeconds < 3600) {
    return relativeTimeFormat.format(Math.round(deltaSeconds / 60), "minute");
  }
  if (absoluteSeconds < 86400) {
    return relativeTimeFormat.format(Math.round(deltaSeconds / 3600), "hour");
  }
  return relativeTimeFormat.format(Math.round(deltaSeconds / 86400), "day");
}

/**
 * A wall-clock time for a transcript row, on the machine's own clock (`2:20:05 PM`), with
 * seconds; the date is shown separately by the day divider, never per row.
 */
export function formatClockTime(iso: string, locale?: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return "—";
  }
  return dateTimeFormatFor("clockTime", locale).format(instant.epochMilliseconds);
}

/**
 * An instant a person acts on: the calendar day and the wall-clock time. Unlike the date-free
 * `formatClockTime`, it is for views with no day divider, where a bare clock would make instants
 * days apart look identical. The field list is explicit, not a `dateStyle` preset, so the width
 * stays scannable while order and separators stay the locale's; there are no seconds, on the same
 * clock as its neighbor.
 */
export function formatDateTime(iso: string, locale?: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return "—";
  }
  return dateTimeFormatFor("dateTime", locale).format(instant.epochMilliseconds);
}

/** A calendar day with no time, with the same day fields as {@link formatDateTime}. */
export function formatDate(iso: string, locale?: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return "—";
  }
  return dateTimeFormatFor("date", locale).format(instant.epochMilliseconds);
}

/**
 * A ratio as a percentage through `Intl`. The input is a fraction, as `Intl`'s percent style
 * takes, so a caller holding a 0-to-100 figure divides at the call site. Negative and non-finite
 * inputs render an em dash.
 */
export function formatPercent(fraction: number, locale?: string): string {
  if (!Number.isFinite(fraction) || fraction < 0) {
    return "—";
  }
  return numberFormatFor("percent", locale).format(fraction);
}

/** The largest amount that still reads to four decimals. */
const FOUR_DECIMAL_CEILING_DOLLARS = 0.5;

/**
 * A dollar figure as every surface reads it: two decimals above $0.50 and four at or below it,
 * so a sub-cent spend never reads as nothing, and a spend of nothing reads `$0.00`. The amount
 * is in US dollars and is rounded once, half up.
 */
export function formatMoney(amount: number): string {
  if (!Number.isFinite(amount)) {
    return "—";
  }
  const fractionDigits = amount === 0 || amount > FOUR_DECIMAL_CEILING_DOLLARS ? 2 : 4;
  return dollarFormatFor(fractionDigits).format(amount);
}

function formatDescriptorMember(value: unknown): string {
  if (value === undefined) {
    return UNSET_DESCRIPTOR_MEMBER_TEXT;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}
