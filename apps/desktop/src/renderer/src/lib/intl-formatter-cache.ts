// The `Intl` objects the app holds, and the bounds on holding them. Constructing an `Intl`
// formatter resolves a locale and builds a message table while formatting is cheap, so every
// figure is formatted through a held instance, one per named style and locale, under a cap.
// A sibling of `wire/figures.ts`, which owns the formatting policy and is the only importer.

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
 * How many named locales the app holds one style of formatter for. A real session holds one
 * or two; the bound covers a caller passing arbitrary strings, and is far above any real render.
 */
const LOCALE_FORMATTER_CAP = 32;

/** What every `Intl` constructor answers about the locale it settled on. */
interface LocaleResolvingFormatter {
  resolvedOptions(): { readonly locale: string };
}

/**
 * The app's `Intl` instances of one style, one per resolved locale. Generic over the formatter;
 * a caller supplies only the mint.
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

/** The one relative-time style the app renders in. */
const RELATIVE_TIME_STYLE: Intl.RelativeTimeFormatOptions = { numeric: "auto" };

const relativeTimeFormatters = new LocaleKeyedFormatters(
  (locale) => new Intl.RelativeTimeFormat(locale, RELATIVE_TIME_STYLE),
);

/** One named number style. */
export type NumberStyle =
  | "count"
  | "compactCount"
  | "percent"
  | "wholeNumber"
  | "oneDecimal"
  | "upToOneDecimal"
  | "bareDigits"
  | "twoDigits"
  | "dayDuration";

/** The one `Intl.RelativeTimeFormat` held for `locale`; two asks answer with the same object. */
export function relativeTimeFormatFor(locale?: string): Intl.RelativeTimeFormat {
  return relativeTimeFormatters.formatterFor(locale);
}

/**
 * Every number style a figure renders in, by name. `dayDuration` is `"long"` because the figure is
 * read as a sentence ("kept for 3 days") and the platform then chooses the singular and plural.
 */
const NUMBER_STYLES: Readonly<Record<NumberStyle, Intl.NumberFormatOptions>> = {
  count: {},
  compactCount: { notation: "compact" },
  percent: { style: "percent", maximumFractionDigits: 0 },
  wholeNumber: { minimumFractionDigits: 0, maximumFractionDigits: 0 },
  oneDecimal: { minimumFractionDigits: 1, maximumFractionDigits: 1 },
  upToOneDecimal: { maximumFractionDigits: 1 },
  bareDigits: { useGrouping: false },
  twoDigits: { minimumIntegerDigits: 2, useGrouping: false },
  dayDuration: { style: "unit", unit: "day", unitDisplay: "long", maximumFractionDigits: 0 },
};

/** One named date or time style. */
export type DateTimeStyle =
  | "clockTime"
  | "clockMinute"
  | "weekdayClockMinute"
  | "monthDayClockMinute"
  | "dateTime"
  | "zonedDateTime"
  | "date";

/**
 * Every date and time style a figure renders in, by name. The hour is `numeric` with no
 * `hour12`, so the clock the locale tag carries decides between `2:20 PM` and `14:20`.
 */
const DATE_TIME_STYLES: Readonly<Record<DateTimeStyle, Intl.DateTimeFormatOptions>> = {
  clockTime: { hour: "numeric", minute: "2-digit", second: "2-digit" },
  clockMinute: { hour: "numeric", minute: "2-digit" },
  weekdayClockMinute: { weekday: "short", hour: "numeric", minute: "2-digit" },
  monthDayClockMinute: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  dateTime: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  zonedDateTime: {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  },
  date: { year: "numeric", month: "short", day: "numeric" },
};

const numberFormatters = new Map<NumberStyle, LocaleKeyedFormatters<Intl.NumberFormat>>();
const dateTimeFormatters = new Map<DateTimeStyle, LocaleKeyedFormatters<Intl.DateTimeFormat>>();

/** The one `Intl.NumberFormat` held for `style` in `locale`; two asks answer with one object. */
export function numberFormatFor(style: NumberStyle, locale?: string): Intl.NumberFormat {
  let formatters = numberFormatters.get(style);
  if (formatters === undefined) {
    formatters = new LocaleKeyedFormatters(
      (requested) => new Intl.NumberFormat(requested, NUMBER_STYLES[style]),
    );
    numberFormatters.set(style, formatters);
  }
  return formatters.formatterFor(locale);
}

/** The one `Intl.DateTimeFormat` held for `style` in `locale`; two asks answer with one object. */
export function dateTimeFormatFor(style: DateTimeStyle, locale: string): Intl.DateTimeFormat {
  let formatters = dateTimeFormatters.get(style);
  if (formatters === undefined) {
    formatters = new LocaleKeyedFormatters(
      (requested) => new Intl.DateTimeFormat(requested, DATE_TIME_STYLES[style]),
    );
    dateTimeFormatters.set(style, formatters);
  }
  return formatters.formatterFor(locale);
}

/** How many decimals a dollar figure carries: to the cent, or to the hundredth of a cent. */
type DollarFractionDigits = 2 | 4;

/**
 * The two dollar formats, held because every cost row renders one. Fixed to US dollars in
 * `en-US`, so a figure reads `$`, a period for the decimals and commas between thousands on
 * every machine, whatever its own locale.
 */
const DOLLAR_FORMATS: Readonly<Record<DollarFractionDigits, Intl.NumberFormat>> = {
  2: dollarFormat(2),
  4: dollarFormat(4),
};

/** The one `Intl.NumberFormat` held for dollar figures at this many decimals. */
export function dollarFormatFor(fractionDigits: DollarFractionDigits): Intl.NumberFormat {
  return DOLLAR_FORMATS[fractionDigits];
}

function dollarFormat(fractionDigits: DollarFractionDigits): Intl.NumberFormat {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}
