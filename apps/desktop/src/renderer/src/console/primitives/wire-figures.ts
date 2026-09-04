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
 * A proportion, as a percentage.
 *
 * The input is a FRACTION and not a percentage, because that is what
 * `Intl.NumberFormat`'s percent style takes — a caller holding a 0-to-100 wire
 * figure divides at the call site, which is one visible division rather than a
 * hidden convention this function would have to be read to discover.
 *
 * It lives here for the reason every other formatter does: the `%` sign is a unit
 * label, and `formatRate` is beside it precisely because a unit composed at a call
 * site is a second formatter. Out-of-range and non-finite inputs answer the same em
 * dash as its siblings rather than rendering a percentage nobody can act on.
 */
export function formatPercent(fraction: number, locale?: string): string {
  if (!Number.isFinite(fraction) || fraction < 0) {
    return "—";
  }
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(fraction);
}

/**
 * One wire instant as epoch milliseconds, or `undefined` where the platform cannot
 * read it.
 *
 * The single reading of a wire timestamp, private to this module and published only
 * through {@link wireInstantRank}. `Date.parse` answers `NaN` for a string it cannot
 * read, and `NaN` is the one number that compares false against everything including
 * itself — so a caller that forgot the guard would not get a wrong figure, it would
 * get a comparison whose answer depends on which side the unreadable value landed
 * on. Answering an absence instead makes the guard the type's own.
 */
function readWireInstant(iso: string): number | undefined {
  const milliseconds = Date.parse(iso);
  return Number.isNaN(milliseconds) ? undefined : milliseconds;
}

/**
 * A wire instant as a comparable rank. Newest is greatest; unknown is least.
 *
 * THE STAMPS ARE PARSED AND NOT COMPARED AS TEXT. An ISO-8601 instant may carry a
 * numeric offset as readily as `Z`, so one instant has many spellings and two
 * spellings sort by neither: `10:00+02:00` is an hour EARLIER than `09:00Z` and
 * sorts after it in every lexical comparison. A surface that ordered rows by their
 * stamps as strings therefore showed the wrong one as newest.
 *
 * Absent and unreadable answer the same `-Infinity`, which puts such a row below
 * every readable stamp while leaving it reachable when it is the only row there is —
 * and, unlike `NaN`, gives it one place in the order rather than a different one at
 * each end of a fold.
 */
export function wireInstantRank(iso: string | undefined): number {
  const milliseconds = iso === undefined ? undefined : readWireInstant(iso);
  return milliseconds ?? Number.NEGATIVE_INFINITY;
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
  const fromMilliseconds = readWireInstant(fromIso);
  if (fromMilliseconds === undefined) {
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
  const milliseconds = readWireInstant(iso);
  if (milliseconds === undefined) {
    return "—";
  }
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(milliseconds);
}

/**
 * An instant a person acts on: the calendar day AND the wall-clock time.
 *
 * `formatClockTime` beside it is deliberately date-free, and the reason is stated
 * there — a ledger row aligns under a day divider that carries the date once. A
 * surface with no divider has no such carrier, and rendering a bare clock reading
 * there makes two instants days apart identical on screen. That is the whole
 * distinction between the two: not precision, but whether anything else on the
 * surface says which day it is.
 *
 * The field list is explicit rather than a `dateStyle` preset, so the reading stays
 * scannable at one width while the ORDER and the separators remain the locale's
 * own. Seconds are absent because the instants this answers for — an expiry, a
 * deadline — are not read to the second, and the same 24-hour clock as its
 * neighbour so two figures on one surface do not disagree about the format.
 */
export function formatDateTime(iso: string, locale?: string): string {
  const milliseconds = readWireInstant(iso);
  if (milliseconds === undefined) {
    return "—";
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(milliseconds);
}

/**
 * Currency codes whose minor-unit precision the formatter remembers.
 *
 * A receipt spans the currencies its paying accounts bill in — a handful, never
 * dozens — so the bound sits far above any real render and exists for the other
 * case: the code is a WIRE string, and a cache keyed on one that nothing bounds
 * grows for as long as the wire cares to send codes nobody asked for.
 */
const CURRENCY_MINOR_UNIT_CACHE_CAP = 32;

/**
 * How many fractional digits a currency's own minor unit has.
 *
 * A class holding its own map rather than a module-level one, and a cache at all
 * because the answer is obtained by CONSTRUCTING an `Intl.NumberFormat` and
 * reading back what it resolved — cheap once per code, wasteful once per ledger
 * row.
 *
 * Keyed on the code alone even though the probe takes a locale: the minor unit is
 * a property of the currency, not of the locale rendering it, so one remembered
 * reading serves every locale the console renders in.
 */
class CurrencyMinorUnitRegistry {
  readonly #digitsByCurrencyCode = new Map<string, number>();

  /**
   * Throws `RangeError` for a code `Intl` will not accept — the same throw
   * `formatMoney`'s fallback arm already handles, which is why the call sits
   * inside that `try` and why an unusable code never reaches the cache.
   */
  public digitsFor(currency: string, locale: string | undefined): number {
    const currencyCode = currency.toUpperCase();
    const remembered = this.#digitsByCurrencyCode.get(currencyCode);
    if (remembered !== undefined) {
      return remembered;
    }
    const { maximumFractionDigits } = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode,
    }).resolvedOptions();
    // The member is optional on the resolved-options type, and an absent reading
    // is not "zero digits" — it is the platform declining to name a bound at all.
    // Reading it as 0 is what makes it mean that: `Math.max` then leaves the
    // console's own floor deciding the precision, exactly as it did before this
    // lookup existed.
    const minorUnitDigits = maximumFractionDigits ?? 0;
    if (this.#digitsByCurrencyCode.size >= CURRENCY_MINOR_UNIT_CACHE_CAP) {
      // Insertion order, so what is dropped is the code seen longest ago. Recency
      // would need a touch on every hit to be true, and the cost of dropping the
      // wrong one is a single constructor call the next time it is asked for.
      const oldestCurrencyCode = this.#digitsByCurrencyCode.keys().next();
      if (oldestCurrencyCode.done !== true) {
        this.#digitsByCurrencyCode.delete(oldestCurrencyCode.value);
      }
    }
    this.#digitsByCurrencyCode.set(currencyCode, minorUnitDigits);
    return minorUnitDigits;
  }
}

/** The console's one reader of currency precision. */
const currencyMinorUnits = new CurrencyMinorUnitRegistry();

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
        currencyMinorUnits.digitsFor(currency, locale),
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
