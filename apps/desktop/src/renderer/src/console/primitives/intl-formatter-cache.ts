// The `Intl` objects this console HOLDS, and the bounds on holding them.
//
// A SIBLING OF `wire-figures.ts` RATHER THAN A PART OF IT. That module owns the
// formatting policy — which figure renders in which unit, and what an unreadable
// one renders as — and this one owns a different question with a different failure
// mode: which `Intl` instances are kept alive, keyed on what, and how many there
// may be. Constructing an `Intl` formatter resolves a locale and builds a message
// table, which is the expensive half, while formatting with one is cheap; a console
// that mints per call resolves a locale per row per reading tick, and one that
// keeps every key it is handed grows for as long as it is handed new ones. Both
// caches here answer that, with one eviction policy between them.
//
// Reached by its own specifier from `wire-figures.ts` — an intra-family import —
// and on no door: the console's callers ask for a FIGURE, and which instance
// composed it is this family's business.

/**
 * Make room in a cache that is at its cap, by dropping the entry seen longest ago.
 *
 * Insertion order rather than recency: recency needs a touch on every hit to be
 * true, and dropping the wrong entry costs one constructor call the next time it
 * is asked for. Written once because this module holds two caches with this
 * policy, and two copies of an eviction rule drift with nothing reporting it.
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
 * How many named locales this console holds a relative-time formatter for.
 *
 * A window renders in one locale and its callers pass that or nothing, so a real
 * session holds one or two. The bound is for the other case, and it is why this
 * cache no longer calls itself bounded by construction: the parameter is a STRING
 * every family reaches through the primitives door, and "callers pass the host
 * locale" is a claim about callers rather than a property of the cache. The
 * figure is the currency cache's, for its reason — far above any real render.
 */
const RELATIVE_TIME_FORMATTER_CAP = 32;

/**
 * The console's `Intl.RelativeTimeFormat` instances, one per RESOLVED locale.
 *
 * A CLASS WITH A PRIVATE FIELD rather than a module-level `Map`, per
 * `apps/desktop/AGENTS.md` §State and views — and it holds state at all because
 * constructing an `Intl` formatter resolves a locale and builds a message table,
 * which is the expensive half, while formatting with one is cheap. A relative time
 * is the console's most repeated figure: every ledger row carrying an age
 * re-renders on the reading tick, so a formatter minted per call is one locale
 * resolution per row per tick.
 *
 * KEYED ON WHAT `Intl` RESOLVED, not on what the caller wrote. `en-US` and `en-us`
 * are one locale and were two entries holding two formatters that answer
 * identically; the resolved tag is the platform's own answer to "which locale is
 * this". The requested spelling keeps a map of its own so a repeat ask costs a
 * lookup rather than the mint resolving needs, and both maps share the one cap.
 *
 * THE ABSENT LOCALE IS A SLOT OF ITS OWN, never a map entry and never folded into
 * whatever the host resolves to. It is the hottest key by far, so an eviction that
 * could reach it would drop the formatter every row uses; and a caller that asked
 * for nothing is asking for the host default rather than for the tag the host
 * carries today. A `""` key would have been neither — it throws.
 */
class RelativeTimeFormatters {
  readonly #byRequestedLocale = new Map<string, Intl.RelativeTimeFormat>();
  readonly #byResolvedLocale = new Map<string, Intl.RelativeTimeFormat>();
  #hostFormatter: Intl.RelativeTimeFormat | undefined;

  /** How many NAMED locales are held. The host slot is one more and never evicted. */
  public get namedLocaleCount(): number {
    return this.#byResolvedLocale.size;
  }

  /** The formatter for `locale`, minted on first ask and kept. */
  public formatterFor(locale: string | undefined): Intl.RelativeTimeFormat {
    if (locale === undefined) {
      this.#hostFormatter ??= new Intl.RelativeTimeFormat(undefined, RELATIVE_TIME_STYLE);
      return this.#hostFormatter;
    }
    const remembered = this.#byRequestedLocale.get(locale);
    if (remembered !== undefined) {
      return remembered;
    }
    const minted = new Intl.RelativeTimeFormat(locale, RELATIVE_TIME_STYLE);
    const resolvedLocale = minted.resolvedOptions().locale;
    const shared = this.#byResolvedLocale.get(resolvedLocale);
    if (shared === undefined) {
      dropOldestEntry(this.#byResolvedLocale, RELATIVE_TIME_FORMATTER_CAP);
      this.#byResolvedLocale.set(resolvedLocale, minted);
    }
    dropOldestEntry(this.#byRequestedLocale, RELATIVE_TIME_FORMATTER_CAP);
    const formatter = shared ?? minted;
    this.#byRequestedLocale.set(locale, formatter);
    return formatter;
  }
}

/** The one relative-time style the console renders in, stated where both mints read it. */
const RELATIVE_TIME_STYLE: Intl.RelativeTimeFormatOptions = { numeric: "auto" };

const relativeTimeFormatters = new RelativeTimeFormatters();

/**
 * The one `Intl.RelativeTimeFormat` this console holds for `locale`.
 *
 * Exported so the claim is checkable by identity — two asks for one locale answer
 * with the same object, which is what "constructed once" means and the only thing
 * that distinguishes this from the per-call mint it replaced.
 */
export function relativeTimeFormatFor(locale?: string): Intl.RelativeTimeFormat {
  return relativeTimeFormatters.formatterFor(locale);
}

/**
 * How many named locales the relative-time cache holds, and its ceiling.
 *
 * Exported for the reason `relativeTimeFormatFor` is: a bound nothing can count
 * is a sentence in a comment. The host formatter is a slot, not in this figure.
 */
export function relativeTimeFormatterCensus(): {
  readonly namedLocales: number;
  readonly cap: number;
} {
  return {
    namedLocales: relativeTimeFormatters.namedLocaleCount,
    cap: RELATIVE_TIME_FORMATTER_CAP,
  };
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
    dropOldestEntry(this.#digitsByCurrencyCode, CURRENCY_MINOR_UNIT_CACHE_CAP);
    this.#digitsByCurrencyCode.set(currencyCode, minorUnitDigits);
    return minorUnitDigits;
  }
}

/** The console's one reader of currency precision. */
const currencyMinorUnits = new CurrencyMinorUnitRegistry();

/**
 * How many fractional digits `currency`'s own minor unit has.
 *
 * The registry's one door, so its instance stays private to this module the way
 * the relative-time one does. Throws `RangeError` for a code `Intl` will not
 * accept — the throw `formatMoney`'s fallback arm already handles.
 */
export function currencyMinorUnitDigits(currency: string, locale: string | undefined): number {
  return currencyMinorUnits.digitsFor(currency, locale);
}
