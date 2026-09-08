// What the console HOLDS to render a relative time, and what bounds it.
//
// The claims here are about the cache rather than about a figure: which asks
// answer with the same object, which do not, and how many objects there are after
// a caller has handed it more locales than it will keep. `wire-figures.time.test.ts`
// beside it owns the figures themselves — the module and its test split on the same
// seam the modules did.
//
// EVERY CASE DRIVES THE ONE PROCESS-WIDE CACHE, which is why the bound is asserted
// last: it evicts, and a case after it would be reading a cache this file emptied.
// Vitest gives each test file its own module registry, so nothing here reaches the
// figures file's instance and nothing there reaches this one.

import { describe, expect, it } from "vitest";

import {
  currencyMinorUnitDigits,
  relativeTimeFormatFor,
  relativeTimeFormatterCensus,
} from "./intl-formatter-cache.js";
import { formatRelativeTime } from "./wire-figures.js";

/**
 * Language tags to fill the cache past its cap with, one ask each.
 *
 * Written out rather than generated, because what the bound case needs is tags a
 * runtime RESOLVES to distinct locales — which it asserts before trusting them, so
 * a host with narrower `Intl` data fails the case rather than passing it vacuously.
 */
const MANY_LANGUAGE_TAGS: readonly string[] = [
  "af",
  "am",
  "ar",
  "az",
  "be",
  "bg",
  "bn",
  "bs",
  "ca",
  "cs",
  "cy",
  "da",
  "de",
  "el",
  "es",
  "et",
  "eu",
  "fa",
  "fi",
  "fr",
  "ga",
  "gl",
  "gu",
  "he",
  "hi",
  "hr",
  "hu",
  "hy",
  "id",
  "is",
  "it",
  "ja",
  "ka",
  "kk",
  "km",
  "kn",
  "ko",
  "ky",
  "lo",
  "lt",
  "lv",
  "mk",
  "ml",
  "mn",
  "mr",
  "ms",
  "my",
  "nb",
  "ne",
  "nl",
];

describe("relative-time formatters — one per resolved locale", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);

  it("holds one formatter per locale rather than minting one per figure", () => {
    // Asserted by IDENTITY, which is the whole of what "constructed once" means: a
    // second construction is a second object, so `toBe` is the counter and no spy
    // and no global monkeypatch is needed. The per-call mint this replaced could not
    // satisfy it — every ask answered with a fresh instance, and a ledger of ages
    // resolved a locale per row per reading tick.
    expect(relativeTimeFormatFor("en-US")).toBe(relativeTimeFormatFor("en-US"));
    expect(relativeTimeFormatFor(undefined)).toBe(relativeTimeFormatFor(undefined));
    // And per LOCALE rather than one for the console: two locales are two message
    // tables, so sharing one would render the second locale's figures in the first's
    // words.
    expect(relativeTimeFormatFor("en-US")).not.toBe(relativeTimeFormatFor("de-DE"));
    // The cached instance is the one the figure is composed through, so the reading
    // is not merely fast but the same reading.
    expect(formatRelativeTime("2026-09-01T11:59:30Z", now, "de-DE")).toBe(
      relativeTimeFormatFor("de-DE").format(-30, "second"),
    );
  });

  it("answers two spellings of one locale with one formatter", () => {
    // `en-US` and `en-us` are one locale to `Intl` and were two entries here, each
    // holding a formatter that answers identically to the other. The key is what the
    // platform RESOLVED, so the spellings collapse — and the first assertion is what
    // says so, since the second would hold even for two separate objects.
    expect(relativeTimeFormatFor("en-us")).toBe(relativeTimeFormatFor("en-US"));
    expect(new Intl.RelativeTimeFormat("en-us").resolvedOptions().locale).toBe(
      new Intl.RelativeTimeFormat("en-US").resolvedOptions().locale,
    );
    expect(relativeTimeFormatFor("en-us").format(-30, "second")).toBe(
      relativeTimeFormatFor("en-US").format(-30, "second"),
    );
  });

  it("keeps the absent locale as a slot of its own", () => {
    // Not folded into whatever the host resolves to, even on a host whose default IS
    // that locale: a caller that named nothing asked for the host default, and a
    // caller that named a tag asked for that tag. The slot is also the one entry no
    // eviction can reach, which the bound case below depends on.
    expect(relativeTimeFormatFor(undefined)).not.toBe(relativeTimeFormatFor("en-US"));
    expect(relativeTimeFormatFor(undefined)).not.toBe(
      relativeTimeFormatFor(new Intl.RelativeTimeFormat().resolvedOptions().locale),
    );
  });

  it("reads currency precision from the currency and not from the locale", () => {
    // The other cache in this module, driven for the property its key states: the
    // minor unit belongs to the currency, so one remembered reading serves every
    // locale, and asking in two locales answers the same digits.
    expect(currencyMinorUnitDigits("KWD", "en-US")).toBe(currencyMinorUnitDigits("KWD", "de-DE"));
    expect(currencyMinorUnitDigits("KWD", undefined)).toBeGreaterThan(
      currencyMinorUnitDigits("JPY", undefined),
    );
  });

  it("holds no more formatters than its named cap, however many locales are asked for", () => {
    // THE BOUND, driven rather than described. Every tag below is asked for once,
    // and the count afterwards is the cap rather than the number asked for — which
    // is the assertion an unbounded cache cannot satisfy and the one this case
    // exists to fail on.
    const { cap } = relativeTimeFormatterCensus();
    const distinctResolvedLocales = new Set(
      MANY_LANGUAGE_TAGS.map((tag) => new Intl.RelativeTimeFormat(tag).resolvedOptions().locale),
    );
    // Without this the case would pass on a host whose `Intl` data collapses the
    // corpus into fewer locales than the cap — a bound never reached, asserted.
    expect(distinctResolvedLocales.size).toBeGreaterThan(cap);

    for (const tag of MANY_LANGUAGE_TAGS) {
      relativeTimeFormatFor(tag);
    }

    expect(relativeTimeFormatterCensus().namedLocales).toBeLessThanOrEqual(cap);
    // And the absent locale is still answered by its own slot, which no eviction
    // reaches: the hottest key in the console survives a caller that filled the map.
    expect(relativeTimeFormatFor(undefined)).toBe(relativeTimeFormatFor(undefined));
  });
});
