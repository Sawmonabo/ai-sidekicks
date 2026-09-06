// Wire figures: the console's whole formatting policy, in one module.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules: "A figure the wire
// supplies renders verbatim … a quantity the console derives renders through `Intl`
// … the console performs no arithmetic on a wire figure outside `Intl`."
//
// That rule has one amendment, and it is stated here because this module is the
// only place it applies: **byte quantities may be scaled.** `Intl` has no kibibyte
// unit — `Intl.NumberFormat` with `unit: "byte"` and `notation: "compact"` gives
// powers of a thousand, which is the wrong scale for a file size and produces
// figures that disagree with every other tool a developer has open. So exactly one
// function below performs power-of-1024 scaling, renders the scaled NUMBER through
// `Intl.NumberFormat`, and appends a unit label from the closed set
// `B / KiB / MiB / GiB / TiB`.
//
// Everything else stays Intl-only: durations, counts, rates, relative times. And
// byte-for-byte strings from the wire — ids, digests, versions, state names — are
// never transformed at all, not even trimmed, because a truncated id is a wrong id
// and a "prettified" state name is a state the daemon never reported.
//
// The `wire-figure-formatting` tripwire's test asserts by grep that this file is
// the only site in `console/**` doing the scaling. If a component needs a byte
// figure, it calls `formatByteQuantity`.
//
// WHAT IS NOT HERE: the `Intl` instances. Which formatter object is kept alive, on
// which key, and how many there may be is `intl-formatter-cache.ts` beside this file
// — a different question with a different failure mode, and the module that answers
// it holds the two caches this one reads through.
//
// The two time readings below take their instant from `core/instant.ts` rather than
// from `Date.parse`, so DISPLAY and ORDERING read a wire stamp the same way. They did
// not before, and the two disagreements were both invisible: `Date.parse` normalizes
// `2026-02-30T10:00:00Z` into March and reads a timezone-less stamp in the host's
// zone, so a figure rendered here could name an instant no sort would ever agree
// with and no daemon ever sent. An unreadable stamp now renders the same em dash the
// rest of this module uses for a figure it cannot stand behind.

import { parseInstant } from "../core/index.js";
import { currencyMinorUnitDigits, relativeTimeFormatFor } from "./intl-formatter-cache.js";

/**
 * The closed unit set, ascending; the index IS the power of 1024.
 *
 * One declaration, with the union derived from it. A hand-written union beside a
 * hand-repeated array is two closed sets that agree until someone widens one, and
 * nothing in the compiler notices.
 */
export const BYTE_UNIT_LABELS = ["B", "KiB", "MiB", "GiB", "TiB"] as const;

/** Binary prefixes, because that is what the scaling is. */
export type ByteUnitLabel = (typeof BYTE_UNIT_LABELS)[number];

/** The scaling step. Named so the one arithmetic site reads as a decision. */
export const BYTE_UNIT_STEP = 1024;

/** A formatted byte quantity, kept decomposed so a caller can style the unit. */
export interface FormattedByteQuantity {
  /** The scaled number, already through `Intl.NumberFormat`. */
  readonly value: string;
  readonly unit: ByteUnitLabel;
  /** `value` and `unit` joined with a non-breaking space. */
  readonly text: string;
}

/**
 * The one place in the console that scales a byte figure.
 *
 * Whole bytes render with no fraction (`512 B`, never `512.0 B`); scaled units get
 * one fraction digit up to `99.9`, then none, which keeps the column width stable
 * in a ledger without lying about precision.
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
  // The threshold is tested against the number as it will READ, not as it was
  // computed. 102350 B scales to 99.951 — under 100, so the unrounded test picks
  // one fraction digit, and `Intl` then renders it "100.0": a five-character
  // figure in the column this rule exists to hold at four. Rounding first is what
  // makes "one fraction digit up to 99.9, then none" true rather than nearly true.
  const roundedToOneDigit = Math.round(scaled * 10) / 10;
  const fractionDigits = unitIndex === 0 || roundedToOneDigit >= 100 ? 0 : 1;
  const value = new Intl.NumberFormat(locale, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(scaled);
  // A no-break space, written as an escape rather than as the character itself:
  // the literal is indistinguishable from an ordinary space in every editor and
  // every diff, which is why `no-irregular-whitespace` bans it. The character is
  // still wanted: a figure must never wrap away from its unit mid-line.
  return { value, unit, text: `${value}\u00A0${unit}` };
}

/**
 * A string the wire supplied — an id, a digest, a version, a state name.
 *
 * The identity function, and it exists precisely because it is one: a call site
 * that reads `formatWireString(event.kind)` states that no transformation is
 * intended, where a bare `event.kind` invites the next author to add one.
 */
export function formatWireString(value: string): string {
  return value;
}

/** One member of a structured wire value, ready to render as a pair. */
export interface WireDescriptorEntry {
  readonly key: string;
  /** The member's value, as it will be shown. Wire-verbatim for a string. */
  readonly value: string;
}

/**
 * A structured wire value — an approval's `resourceDescriptor`, and anything else
 * the wire types `Record<string, unknown>` — decomposed into renderable pairs.
 *
 * Here rather than at the surface that first needed one, because deciding how a
 * non-string member READS is formatting, and a surface that made that decision for
 * itself would be the second implementation this module exists to prevent. Two
 * rules, and both are about not lying:
 *
 *   • A string member renders verbatim, with no quotes added around it. Quoting it
 *     would put two characters on screen that the daemon never sent, which is
 *     exactly what a mono wire figure promises it will not do.
 *   • Every other member renders as its JSON form — the one serialization that is
 *     total over `unknown`, stable across runs, and reversible by eye. `undefined`
 *     has no JSON form, so the member is named as one the reply left unset rather
 *     than dropped, because a member that vanishes is a member nobody can ask about.
 *
 * Insertion order is kept. The daemon composed this descriptor and the order it
 * composed it in is the order it meant; sorting would be the console re-deciding
 * what the most important part of a request is.
 */
export function formatWireDescriptor(
  descriptor: Readonly<Record<string, unknown>>,
): readonly WireDescriptorEntry[] {
  return Object.entries(descriptor).map(([key, value]) => ({
    key,
    value: formatDescriptorMember(value),
  }));
}

/** What an `undefined` member reads as. Named, because it is copy and not a value. */
const UNSET_DESCRIPTOR_MEMBER_TEXT = "(no value)";

function formatDescriptorMember(value: unknown): string {
  if (value === undefined) {
    return UNSET_DESCRIPTOR_MEMBER_TEXT;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** A count the console derived. Grouped per locale; never abbreviated. */
export function formatCount(value: number, locale?: string): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat(locale).format(value);
}

/**
 * A duration in milliseconds, as the console's own reading.
 *
 * `Spec-023 §Console Design (Meridian)` §The eight rules fixes two shapes: digital
 * at one minute and above,
 * `1.2 s`-style below it. Sub-second durations render in milliseconds because a run
 * that took 340 ms is not "0.3 s" to anyone debugging it.
 *
 * Digital is composed from `NumberFormat` rather than taken from
 * `Intl.DurationFormat`, and that is a runtime-range decision rather than a
 * preference. `DurationFormat` is absent below Node 23 while this repo's floor is
 * 22.14, so the `console-unit` tier would fail on a Node-22 leg even though
 * Electron 44's Chromium carries the API — and a guarded two-path implementation
 * would render one shape in CI and another in production, which is the single
 * outcome a formatting chokepoint exists to prevent. Every numeral still passes
 * through `Intl`; only the `:` separators are ours, and the padding is
 * `minimumIntegerDigits`, so a locale with its own digits pads in its own digits.
 */
export function formatDuration(milliseconds: number, locale?: string): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    return "—";
  }
  if (milliseconds < 1000) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(milliseconds)} ms`;
  }
  const totalSeconds = milliseconds / 1000;
  if (totalSeconds < 60) {
    return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(totalSeconds)} s`;
  }
  // Truncated, not rounded: a digital reading of 1:00 for 59.6 s claims a boundary
  // the run did not cross.
  const wholeSeconds = Math.floor(totalSeconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const seconds = wholeSeconds % 60;
  const bare = new Intl.NumberFormat(locale, { useGrouping: false });
  const padded = new Intl.NumberFormat(locale, {
    minimumIntegerDigits: 2,
    useGrouping: false,
  });
  return hours > 0
    ? `${bare.format(hours)}:${padded.format(minutes)}:${padded.format(seconds)}`
    : `${bare.format(minutes)}:${padded.format(seconds)}`;
}

/** A rate the console derived, e.g. tokens per second. */
export function formatRate(perSecond: number, unitLabel: string, locale?: string): string {
  if (!Number.isFinite(perSecond) || perSecond < 0) {
    return "—";
  }
  const value = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(perSecond);
  return `${value} ${unitLabel}/s`;
}

/**
 * A relative time, through `Intl.RelativeTimeFormat`.
 *
 * The unit is chosen by magnitude, not by arithmetic on a wire figure: the input is
 * two instants the console holds, and the output is a phrase the platform composes.
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
 * A wall-clock time for a ledger row. Fixed to hours, minutes, seconds so rows
 * align; the date is shown separately by the day divider, never per row.
 */
export function formatClockTime(iso: string, locale?: string): string {
  const instant = parseInstant(iso);
  if (instant.kind === "malformed") {
    return "—";
  }
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(instant.epochMilliseconds);
}

/**
 * A money figure the accountant supplied, in its own currency.
 *
 * Two fractional digits is a FLOOR, not the precision. A currency whose minor
 * unit is finer than a hundredth — KWD, BHD and TND among the thousandths —
 * keeps its own three, because forcing two there drops a digit the daemon sent;
 * a sub-unit amount keeps four, because a token price is not the cent it
 * rounds to. The
 * floor only ever raises: a zero-minor-unit currency renders two digits, which is
 * the console's column rule applied where it costs no precision.
 *
 * Sub-unit is a question about MAGNITUDE, so the test is on the absolute value. A
 * bare `amount < 1` is true of every negative amount, which would render a refund
 * of -123.4567 with four fractional digits beside a charge of 123.4567 with two —
 * two different column widths for one column, and sub-cent precision claimed for a
 * figure whose magnitude is nowhere near a sub-unit one.
 */
export function formatMoney(amount: number, currency: string, locale?: string): string {
  if (!Number.isFinite(amount)) {
    return "—";
  }
  const minimumFractionDigits = 2;
  const floorFractionDigits = Math.abs(amount) < 1 ? 4 : minimumFractionDigits;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits,
      maximumFractionDigits: Math.max(
        floorFractionDigits,
        currencyMinorUnitDigits(currency, locale),
      ),
    }).format(amount);
  } catch {
    // `Intl.NumberFormat` throws `RangeError` for any currency that is not three
    // ASCII letters, and the currency is a wire string this module does not get to
    // validate. Throwing would take the surface down through its error boundary and
    // hide a figure the daemon did send. So the two rules are applied separately
    // when they cannot be applied at once: the amount keeps its `Intl` formatting,
    // and the code the daemon sent renders verbatim beside it. There is no minor
    // unit to honour on this arm — the code `Intl` rejected names no currency — so
    // the floor is the whole precision here.
    return `${new Intl.NumberFormat(locale, { minimumFractionDigits, maximumFractionDigits: floorFractionDigits }).format(amount)}\u00A0${currency}`;
  }
}
