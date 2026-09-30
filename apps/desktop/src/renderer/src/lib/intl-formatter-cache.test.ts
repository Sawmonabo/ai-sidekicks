// The cache: which asks answer with the same object, and how many objects remain after a caller
// passes more locales than it keeps. `wire-figures.time.test.ts` owns the figures themselves.
//
// Every case drives the one process-wide cache, so the bound is asserted last because it evicts.
// Vitest gives each test file its own module registry.

import { describe, expect, it } from "vitest";

import {
  currencyMinorUnitDigits,
  relativeTimeFormatFor,
  countRelativeTimeFormatters,
} from "./intl-formatter-cache.js";
import { formatRelativeTime } from "./wire-figures.js";

/**
 * Language tags to fill the cache past its cap with, one ask each. Written out because the bound
 * case needs tags a runtime resolves to distinct locales, which it asserts before trusting them.
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
    // Asserted by identity: a second construction is a second object, so `toBe` counts them.
    expect(relativeTimeFormatFor("en-US")).toBe(relativeTimeFormatFor("en-US"));
    expect(relativeTimeFormatFor(undefined)).toBe(relativeTimeFormatFor(undefined));
    // Per locale: two locales are two message tables, so sharing one would render the wrong words.
    expect(relativeTimeFormatFor("en-US")).not.toBe(relativeTimeFormatFor("de-DE"));
    // The cached instance is the one the figure is composed through.
    expect(formatRelativeTime("2026-09-01T11:59:30Z", now, "de-DE")).toBe(
      relativeTimeFormatFor("de-DE").format(-30, "second"),
    );
  });

  it("answers two spellings of one locale with one formatter", () => {
    // `en-US` and `en-us` are one locale to `Intl`; the key is what the platform resolved. The
    // first assertion proves it, since the second holds even for two separate objects.
    expect(relativeTimeFormatFor("en-us")).toBe(relativeTimeFormatFor("en-US"));
    expect(new Intl.RelativeTimeFormat("en-us").resolvedOptions().locale).toBe(
      new Intl.RelativeTimeFormat("en-US").resolvedOptions().locale,
    );
    expect(relativeTimeFormatFor("en-us").format(-30, "second")).toBe(
      relativeTimeFormatFor("en-US").format(-30, "second"),
    );
  });

  it("keeps the absent locale as a formatter of its own", () => {
    // Not folded into the host's resolved locale: naming nothing asks for the host default. That
    // formatter is also the one no eviction can reach, which the bound case below depends on.
    expect(relativeTimeFormatFor(undefined)).not.toBe(relativeTimeFormatFor("en-US"));
    expect(relativeTimeFormatFor(undefined)).not.toBe(
      relativeTimeFormatFor(new Intl.RelativeTimeFormat().resolvedOptions().locale),
    );
  });

  it("reads currency precision from the currency and not from the locale", () => {
    // The minor unit belongs to the currency, so asking in two locales answers the same digits.
    expect(currencyMinorUnitDigits("KWD", "en-US")).toBe(currencyMinorUnitDigits("KWD", "de-DE"));
    expect(currencyMinorUnitDigits("KWD", undefined)).toBeGreaterThan(
      currencyMinorUnitDigits("JPY", undefined),
    );
  });

  it("holds no more formatters than its named cap, however many locales are asked for", () => {
    // The bound, driven: after one ask per tag the count is the cap, not the number asked.
    const { cap } = countRelativeTimeFormatters();
    const distinctResolvedLocales = new Set(
      MANY_LANGUAGE_TAGS.map((tag) => new Intl.RelativeTimeFormat(tag).resolvedOptions().locale),
    );
    // Guards against a host whose `Intl` data collapses the corpus below the cap.
    expect(distinctResolvedLocales.size).toBeGreaterThan(cap);

    for (const tag of MANY_LANGUAGE_TAGS) {
      relativeTimeFormatFor(tag);
    }

    expect(countRelativeTimeFormatters().namedLocales).toBeLessThanOrEqual(cap);
    // The absent locale keeps its own formatter, which no eviction reaches.
    expect(relativeTimeFormatFor(undefined)).toBe(relativeTimeFormatFor(undefined));
  });
});
