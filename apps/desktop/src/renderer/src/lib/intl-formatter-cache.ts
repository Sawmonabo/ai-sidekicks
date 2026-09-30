// The `Intl` objects the console holds, and the bounds on holding them. Constructing an `Intl`
// formatter resolves a locale and builds a message table while formatting is cheap, so minting per
// call costs a locale resolution per row per tick, and keeping every key grows without bound.
// A sibling of `wire-figures.ts`, which owns the formatting policy and is the only importer.

/**
 * Make room in a cache at its cap by dropping the oldest inserted entry. Insertion order rather
 * than recency, since recency needs a touch on every hit and a wrong drop costs one constructor.
 */
function dropOldestEntry<Key, Value>(cache: Map<Key, Value>, cap: number): void {
  if (cache.size < cap) {
    return;
  }
  const oldest = cache.keys().next();
  if (oldest.done !== true) {
    cache.delete(oldest.value);
  }
}

/**
 * How many named locales the console holds one kind of formatter for. A real session holds one
 * or two; the bound covers a caller passing arbitrary strings, and is far above any real render.
 */
const LOCALE_FORMATTER_CAP = 32;

/** What every `Intl` constructor answers about the locale it settled on. */
interface LocaleResolvingFormatter {
  resolvedOptions(): { readonly locale: string };
}

/**
 * The console's `Intl` instances of one kind, one per resolved locale. A relative time is the
 * most repeated figure (every row with an age re-renders on the reading tick), so the formatter
 * is held, not minted per call. Generic over the formatter; a caller supplies only the mint.
 *
 * Keyed on what `Intl` resolved, so `en-US` and `en-us` share one formatter; the requested
 * spelling has its own map so a repeat ask is a lookup, and both maps share the cap.
 *
 * The absent locale has its own formatter, never a map entry and never folded into the host's
 * resolved tag: it is the hottest key, so eviction must not reach it, and it means the host
 * default. A `""` key would throw.
 */
class LocaleKeyedFormatters<TFormatter extends LocaleResolvingFormatter> {
  readonly #mint: (locale: string | undefined) => TFormatter;
  readonly #byRequestedLocale = new Map<string, TFormatter>();
  readonly #byResolvedLocale = new Map<string, TFormatter>();
  #hostFormatter: TFormatter | undefined;

  public constructor(mint: (locale: string | undefined) => TFormatter) {
    this.#mint = mint;
  }

  /** The formatter for `locale`, minted on first ask and kept. */
  public formatterFor(locale: string | undefined): TFormatter {
    if (locale === undefined) {
      this.#hostFormatter ??= this.#mint(undefined);
      return this.#hostFormatter;
    }
    const remembered = this.#byRequestedLocale.get(locale);
    if (remembered !== undefined) {
      return remembered;
    }
    const minted = this.#mint(locale);
    const resolvedLocale = minted.resolvedOptions().locale;
    const shared = this.#byResolvedLocale.get(resolvedLocale);
    if (shared === undefined) {
      dropOldestEntry(this.#byResolvedLocale, LOCALE_FORMATTER_CAP);
      this.#byResolvedLocale.set(resolvedLocale, minted);
    }
    dropOldestEntry(this.#byRequestedLocale, LOCALE_FORMATTER_CAP);
    const formatter = shared ?? minted;
    this.#byRequestedLocale.set(locale, formatter);
    return formatter;
  }
}

/** The one relative-time style the console renders in. */
const RELATIVE_TIME_STYLE: Intl.RelativeTimeFormatOptions = { numeric: "auto" };

const relativeTimeFormatters = new LocaleKeyedFormatters(
  (locale) => new Intl.RelativeTimeFormat(locale, RELATIVE_TIME_STYLE),
);

/** The one `Intl.RelativeTimeFormat` held for `locale`; two asks answer with the same object. */
export function relativeTimeFormatFor(locale?: string): Intl.RelativeTimeFormat {
  return relativeTimeFormatters.formatterFor(locale);
}

/**
 * The one day-duration style the console renders in. `"long"` because the figure is read as a
 * sentence ("kept for 3 days") and the platform then chooses the singular and plural itself.
 * The unit is `day` only; other units go through `formatDuration`.
 */
const DAY_DURATION_STYLE: Intl.NumberFormatOptions = {
  style: "unit",
  unit: "day",
  unitDisplay: "long",
  maximumFractionDigits: 0,
};

const dayDurationFormatters = new LocaleKeyedFormatters(
  (locale) => new Intl.NumberFormat(locale, DAY_DURATION_STYLE),
);

/** The one `Intl.NumberFormat` held for day durations in `locale`, under the same cap. */
export function dayDurationFormatFor(locale?: string): Intl.NumberFormat {
  return dayDurationFormatters.formatterFor(locale);
}

/**
 * Currency codes whose minor-unit precision is remembered. Real renders use a handful; the bound
 * exists because the code is a wire string and an unbounded cache would grow with it.
 */
const CURRENCY_MINOR_UNIT_CACHE_CAP = 32;

/**
 * How many fractional digits a currency's own minor unit has. Cached because the answer comes
 * from constructing an `Intl.NumberFormat`. Keyed on the code alone, since the minor unit belongs
 * to the currency, not the locale.
 */
class CurrencyMinorUnitRegistry {
  readonly #digitsByCurrencyCode = new Map<string, number>();

  /** Throws `RangeError` for a code `Intl` will not accept; such a code never reaches the cache. */
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
    // The member is optional; an absent reading means the platform names no bound, and 0 lets
    // `Math.max` leave the console's own floor deciding the precision.
    const minorUnitDigits = maximumFractionDigits ?? 0;
    dropOldestEntry(this.#digitsByCurrencyCode, CURRENCY_MINOR_UNIT_CACHE_CAP);
    this.#digitsByCurrencyCode.set(currencyCode, minorUnitDigits);
    return minorUnitDigits;
  }
}

/** The console's one reader of currency precision. */
const currencyMinorUnits = new CurrencyMinorUnitRegistry();

/**
 * How many fractional digits `currency`'s own minor unit has.
 * Throws `RangeError` for a code `Intl` will not accept.
 */
export function currencyMinorUnitDigits(currency: string, locale: string | undefined): number {
  return currencyMinorUnits.digitsFor(currency, locale);
}
