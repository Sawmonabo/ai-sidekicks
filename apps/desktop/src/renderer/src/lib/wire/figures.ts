// Wire figures: the app's whole formatting policy. A figure the wire supplies renders
// verbatim, a quantity the app derives renders through `Intl`, and the app does no
// arithmetic on a wire figure outside `Intl`.
//
// The one exception is byte quantities. `Intl` has no kibibyte unit (`unit: "byte"` with compact
// notation scales by 1000, which disagrees with every other tool), so only `formatByteQuantity`
// scales by powers of 1024, renders the scaled number through `Intl.NumberFormat`, and appends a
// label from `B / KiB / MiB / GiB / TiB`. Durations, counts, rates and relative times stay
// Intl-only. Byte-for-byte wire strings (ids, digests, versions, paths) are never
// transformed, not even trimmed: a truncated id is a wrong id.
//
// Every clock figure and date is written in the machine's own region and 12- or 24-hour clock,
// never the app's UI language: callers pass `clockLocaleFor`'s tag as the `locale`.
//
// The `Intl` instances and their caches live in `intl-formatter-cache.ts`. Time readings take
// their instant from `instant.ts`, not `Date.parse`, so display and ordering read a stamp the same
// way: `Date.parse` normalizes `2026-02-30T10:00:00Z` into March and reads a zone-less stamp
// in the host's zone. An unreadable stamp renders the em dash used for any figure this module
// cannot stand behind.

import type { MachineClock } from "#shared/app-facts.js";
import { MILLISECONDS_PER_DAY, parseInstant } from "../instant.js";
import {
  dateTimeFormatFor,
  dollarFormatFor,
  numberFormatFor,
  type NumberStyle,
  relativeTimeFormatFor,
} from "../intl-formatter-cache.js";

/** What a figure this module cannot stand behind renders as: an em dash, the same everywhere. */
export const UNREADABLE_FIGURE = "—";

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
 * The locale every clock figure and date is written in: the machine's region with its 12- or
 * 24-hour clock folded in as one BCP 47 tag, `en-US-u-hc-h23` for a US Mac set to 24-hour time.
 */
export function clockLocaleFor(clock: MachineClock): string {
  return new Intl.Locale(clock.regionLocale, { hourCycle: clock.hourCycle }).toString();
}

/**
 * The one place in the app that scales a byte figure. Whole bytes render with no fraction
 * (`512 B`); scaled units get one fraction digit up to `99.9`, then none, which keeps column width
 * stable without lying about precision. A negative or non-finite input renders an em dash.
 */
export function formatByteQuantity(byteCount: number, locale?: string): FormattedByteQuantity {
  if (!Number.isFinite(byteCount) || byteCount < 0) {
    return { value: UNREADABLE_FIGURE, unit: "B", text: UNREADABLE_FIGURE };
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
    return UNREADABLE_FIGURE;
  }
  return numberFormatFor("count", locale).format(value);
}

/**
 * A count shortened for a figure that must stay narrow, in the locale's compact notation (`1.2K`,
 * `3.4M`). The full count, `formatCount`, belongs in its hover label. Non-finite is an em dash.
 */
export function formatCompactCount(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return UNREADABLE_FIGURE;
  }
  return numberFormatFor("compactCount", locale).format(value);
}

/**
 * The longest form `formatCompactCount` prints for any whole count up to the largest safe
 * integer, so a box sized for it holds every count without growing: `1000T` in `en-US`. Read from
 * the formatter itself, at each rounding edge of every power of ten.
 */
export function widestCompactCount(locale?: string): string {
  let widest = formatCompactCount(0, locale);
  for (let exponent = 0; exponent <= MAX_SAFE_EXPONENT; exponent += 1) {
    for (const mantissa of COMPACT_ROUNDING_EDGES) {
      const value = Math.min(Math.round(mantissa * 10 ** exponent), Number.MAX_SAFE_INTEGER);
      const figure = formatCompactCount(value, locale);
      if ([...figure].length > [...widest].length) {
        widest = figure;
      }
    }
  }
  return widest;
}

/** The highest power of ten at or under the largest safe integer. */
const MAX_SAFE_EXPONENT = Math.floor(Math.log10(Number.MAX_SAFE_INTEGER));

/**
 * Mantissas on either side of where compact notation rounds a figure up a digit or a unit, and the
 * largest safe integer's own, so the widest figure of each power of ten is among them.
 */
const COMPACT_ROUNDING_EDGES: readonly number[] = [
  1, 1.25, 9.49, 9.5, 9.94, 9.95, 99.4, 99.5, 999.4, 999.5, 9.007199254740991,
];

/**
 * A duration in milliseconds: digital (`1:05`, `1:02:03`) at one minute and above, `1.2 s` below
 * it, and milliseconds under a second, since 340 ms is not "0.3 s" to anyone debugging. Every
 * numeral passes through `Intl`; only the `:` separators are ours.
 */
export function formatDuration(milliseconds: number, locale?: string): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return UNREADABLE_FIGURE;
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
 * A duration in milliseconds, in units: `4 ms` under a second, `38 s` under a minute,
 * `6 m 41 s`, and `2 h 5 m 9 s` from an hour. Seconds are truncated, not rounded, so a span never
 * claims a boundary it did not cross. A digital clock is `formatDuration`'s `6:41`, not this.
 */
export function formatUnitDuration(milliseconds: number, locale?: string): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return UNREADABLE_FIGURE;
  }
  const whole = numberFormatFor("wholeNumber", locale);
  if (milliseconds < 1000) {
    return `${whole.format(Math.floor(milliseconds))} ms`;
  }
  const wholeSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const parts = [
    ...(hours > 0 ? [`${whole.format(hours)} h`] : []),
    ...(hours > 0 || minutes > 0 ? [`${whole.format(minutes)} m`] : []),
    `${whole.format(seconds)} s`,
  ];
  return parts.join(" ");
}

/** The units a duration figure is stated in whole, each with the `Intl` style that words it. */
const WHOLE_DURATION_STYLES: Readonly<Record<"day" | "minute", NumberStyle>> = {
  day: "dayDuration",
  minute: "minuteDuration",
};

/**
 * A duration the wire states in whole units, such as a retention window in days or a quota window
 * in minutes, in words: `7 days`, `300 minutes`. The unit is part of the figure, so the whole text
 * comes from `Intl` with `style: "unit"`, which handles the plural and the locale's own word;
 * `formatDuration` would render 7 days as `168:00:00`. A fractional input renders whole.
 * Non-finite and negative inputs render an em dash.
 */
export function formatWholeDuration(
  amount: number,
  unit: keyof typeof WHOLE_DURATION_STYLES,
  locale?: string,
): string {
  if (!Number.isFinite(amount) || amount < 0) {
    return UNREADABLE_FIGURE;
  }
  return numberFormatFor(WHOLE_DURATION_STYLES[unit], locale).format(amount);
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
    return UNREADABLE_FIGURE;
  }
  const deltaMilliseconds = from.epochMilliseconds - nowMilliseconds;
  const step = relativeTimeStepFor(deltaMilliseconds);
  return relativeTimeFormatFor(locale).format(
    Math.round(deltaMilliseconds / step.milliseconds),
    step.unit,
  );
}

/**
 * The first instant after `nowMilliseconds` at which {@link formatRelativeTime} reads differently
 * for `fromIso`, so a view can wake then rather than poll: the next rounding step, or the next
 * change of unit, whichever comes first. An unreadable stamp never changes.
 */
export function relativeTimeChangesAt(fromIso: string, nowMilliseconds: number): number {
  const from = parseInstant(fromIso);
  if (from.kind === "malformed") {
    return Number.POSITIVE_INFINITY;
  }
  const deltaMilliseconds = from.epochMilliseconds - nowMilliseconds;
  const step = relativeTimeStepFor(deltaMilliseconds);
  const shown = Math.round(deltaMilliseconds / step.milliseconds);
  // As time passes the gap shrinks, and `Math.round` keeps `shown` until it falls below
  // `shown - 0.5` steps; one millisecond past that it reads the next figure.
  const roundingChangesAt = from.epochMilliseconds - (shown - 0.5) * step.milliseconds + 1;
  return Math.min(roundingChangesAt, relativeTimeUnitChangesAt(deltaMilliseconds, nowMilliseconds));
}

/**
 * A wall-clock time for a transcript row, on the machine's own clock (`2:20:05 PM`), with
 * seconds; the date is shown separately by the day divider, never per row.
 */
export function formatClockTime(iso: string, locale: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return UNREADABLE_FIGURE;
  }
  return dateTimeFormatFor("clockTime", locale).format(instant.epochMilliseconds);
}

/**
 * An instant on the machine's own clock with its day in front unless it is today: `2:20 PM`,
 * `Yesterday 5:31 PM`, `Tomorrow 2:00 AM`, `Mon 9:58 AM` within the week either side, and past
 * that the date, `Sep 12, 2:00 AM`, with the year when it is not this one. The day is counted on
 * this machine's calendar from `nowMilliseconds`, so the same instant reads differently tomorrow;
 * {@link dayClockChangesAt} says when.
 */
export function formatDayClock(iso: string, nowMilliseconds: number, locale: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return UNREADABLE_FIGURE;
  }
  const atMilliseconds = instant.epochMilliseconds;
  const days = calendarDaysBetween(nowMilliseconds, atMilliseconds);
  if (days === 0) {
    return dateTimeFormatFor("clockMinute", locale).format(atMilliseconds);
  }
  if (Math.abs(days) === 1) {
    const dayWord = relativeTimeFormatFor(locale).format(days, "day");
    const clock = dateTimeFormatFor("clockMinute", locale).format(atMilliseconds);
    return `${dayWord.charAt(0).toLocaleUpperCase(locale)}${dayWord.slice(1)} ${clock}`;
  }
  if (Math.abs(days) < DAYS_PER_WEEK) {
    return dateTimeFormatFor("weekdayClockMinute", locale).format(atMilliseconds);
  }
  const isThisYear =
    new Date(atMilliseconds).getFullYear() === new Date(nowMilliseconds).getFullYear();
  return dateTimeFormatFor(isThisYear ? "monthDayClockMinute" : "dateTime", locale).format(
    atMilliseconds,
  );
}

/**
 * The next local midnight after `nowMilliseconds`, when every {@link formatDayClock} figure may
 * read differently, so a view can wake then rather than poll.
 */
export function dayClockChangesAt(nowMilliseconds: number): number {
  const now = new Date(nowMilliseconds);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime();
}

/**
 * An instant a person acts on: the calendar day and the wall-clock time. Unlike the date-free
 * `formatClockTime`, it is for views with no day divider, where a bare clock would make instants
 * days apart look identical. The field list is explicit, not a `dateStyle` preset, so the width
 * stays scannable while order and separators stay the locale's; there are no seconds, on the same
 * clock as its neighbor.
 */
export function formatDateTime(iso: string, locale: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return UNREADABLE_FIGURE;
  }
  return dateTimeFormatFor("dateTime", locale).format(instant.epochMilliseconds);
}

/**
 * The time an instant stands for, as a hover label reads it: {@link formatDateTime} on the
 * machine's own clock with its zone, `Oct 7, 2026, 7:28 PM EDT`. A relative time and every other
 * timestamp carry it in their hover label; the exact stamp the daemon sent is read in the
 * inspector.
 */
export function formatZonedDateTime(iso: string, locale: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return UNREADABLE_FIGURE;
  }
  return dateTimeFormatFor("zonedDateTime", locale).format(instant.epochMilliseconds);
}

/** A calendar day with no time, with the same day fields as {@link formatDateTime}. */
export function formatDate(iso: string, locale: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return UNREADABLE_FIGURE;
  }
  return dateTimeFormatFor("date", locale).format(instant.epochMilliseconds);
}

/**
 * The percent behind `formatPercent(percent / 100)` with every digit the wire sent, for a hover
 * label; `undefined` where the rounded text already shows it whole or shows no figure.
 */
export function exactPercentLabel(percent: number, locale?: string): string | undefined {
  const rounded = formatPercent(percent / 100, locale);
  if (rounded === UNREADABLE_FIGURE) {
    return undefined;
  }
  const exact = numberFormatFor("exactPercent", locale).format(percent / 100);
  return exact === rounded ? undefined : exact;
}

/**
 * A ratio as a percentage through `Intl`. The input is a fraction, as `Intl`'s percent style
 * takes, so a caller holding a 0-to-100 figure divides at the call site. Negative and non-finite
 * inputs render an em dash.
 */
export function formatPercent(fraction: number, locale?: string): string {
  if (!Number.isFinite(fraction) || fraction < 0) {
    return UNREADABLE_FIGURE;
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
    return UNREADABLE_FIGURE;
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

/** The units a relative time is written in, each used while the gap is under its threshold. */
const RELATIVE_TIME_STEPS = [
  { unit: "second", milliseconds: 1_000, belowMilliseconds: 60_000 },
  { unit: "minute", milliseconds: 60_000, belowMilliseconds: 3_600_000 },
  { unit: "hour", milliseconds: 3_600_000, belowMilliseconds: 86_400_000 },
] as const;

/** The unit a gap of a day or more is written in. */
const RELATIVE_TIME_DAY_STEP = { unit: "day", milliseconds: 86_400_000 } as const;

function relativeTimeStepFor(deltaMilliseconds: number): {
  readonly unit: Intl.RelativeTimeFormatUnit;
  readonly milliseconds: number;
} {
  const gap = Math.abs(deltaMilliseconds);
  return RELATIVE_TIME_STEPS.find((step) => gap < step.belowMilliseconds) ?? RELATIVE_TIME_DAY_STEP;
}

/**
 * When the unit {@link relativeTimeStepFor} picks next changes as time passes: a past instant's
 * gap grows into the next threshold, and a future one's shrinks below the threshold under it.
 */
function relativeTimeUnitChangesAt(deltaMilliseconds: number, nowMilliseconds: number): number {
  const gap = Math.abs(deltaMilliseconds);
  if (deltaMilliseconds <= 0) {
    const threshold = RELATIVE_TIME_STEPS.find((step) => gap < step.belowMilliseconds);
    return threshold === undefined
      ? Number.POSITIVE_INFINITY
      : nowMilliseconds + threshold.belowMilliseconds - gap;
  }
  const below = RELATIVE_TIME_STEPS.findLast((step) => gap >= step.belowMilliseconds);
  return below === undefined
    ? Number.POSITIVE_INFINITY
    : nowMilliseconds + gap - below.belowMilliseconds + 1;
}

/** How many days a week holds: an instant within one either side of today is named by weekday. */
const DAYS_PER_WEEK = 7;

/** How many calendar days on this machine's clock `to` falls after `from`; negative before it. */
function calendarDaysBetween(fromMilliseconds: number, toMilliseconds: number): number {
  const from = new Date(fromMilliseconds);
  const to = new Date(toMilliseconds);
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime();
  const toDay = new Date(to.getFullYear(), to.getMonth(), to.getDate()).getTime();
  // Rounded, because a day that crosses a daylight-saving change is 23 or 25 hours long.
  return Math.round((toDay - fromDay) / MILLISECONDS_PER_DAY);
}
