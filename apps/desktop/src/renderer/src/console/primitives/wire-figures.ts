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
  const fromMilliseconds = Date.parse(fromIso);
  if (Number.isNaN(fromMilliseconds)) {
    return "—";
  }
  const deltaSeconds = (fromMilliseconds - nowMilliseconds) / 1000;
  const relativeTimeFormat = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
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
  const milliseconds = Date.parse(iso);
  if (Number.isNaN(milliseconds)) {
    return "—";
  }
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(milliseconds);
}

/** A money figure the accountant supplied, in its own currency. */
export function formatMoney(amount: number, currency: string, locale?: string): string {
  if (!Number.isFinite(amount)) {
    return "—";
  }
  const fractionDigits = {
    minimumFractionDigits: 2,
    maximumFractionDigits: amount < 1 ? 4 : 2,
  };
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, ...fractionDigits }).format(
      amount,
    );
  } catch {
    // `Intl.NumberFormat` throws `RangeError` for any currency that is not three
    // ASCII letters, and the currency is a wire string this module does not get to
    // validate. Throwing would take the surface down through its error boundary and
    // hide a figure the daemon did send. So the two rules are applied separately
    // when they cannot be applied at once: the amount keeps its `Intl` formatting,
    // and the code the daemon sent renders verbatim beside it.
    return `${new Intl.NumberFormat(locale, fractionDigits).format(amount)}\u00A0${currency}`;
  }
}
