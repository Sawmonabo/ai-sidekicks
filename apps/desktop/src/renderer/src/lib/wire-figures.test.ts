// The pass-through figures, and the locale property that holds every formatter at once. The
// failures worth testing are the wrong class applied: a wire string that got transformed (a
// trimmed id, a normalized digest), or a quantity formatted by hand instead of through `Intl`
// (`1.5` to a locale that writes `1,5`). Each case carries the control that catches it; the
// closing property formats one value in two locales and requires them to differ. Time readings
// are in `wire-figures.time.test.ts`, byte and money figures in `wire-figures.units.test.ts`.

import { describe, expect, it } from "vitest";

import {
  formatByteQuantity,
  formatCount,
  formatDuration,
  formatMoney,
  formatRelativeTime,
  formatWireString,
} from "./wire-figures.js";

describe("formatWireString — a wire string is never transformed, not even helpfully", () => {
  it("returns the very same string it was given", () => {
    // Real shapes: a padded state name, a digest, a version, a provider label.
    for (const wireValue of [
      "  run.awaiting_approval  ",
      "b3:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "claude-opus-4-6-20260214",
      "",
    ]) {
      expect(formatWireString(wireValue)).toBe(wireValue);
    }
  });

  it("does not trim, case-fold, or unicode-normalize", () => {
    // Negative control: each is a tidy-up an author might add and each yields a different string,
    // so the identity assertion is not passing because both sides are tidied.
    const padded = "  session.created  ";
    expect(formatWireString(padded)).not.toBe(padded.trim());

    const shouty = "RUN.FAILED";
    expect(formatWireString(shouty)).not.toBe(shouty.toLowerCase());

    // "é" as e + combining acute; NFC would collapse it to a different byte sequence.
    const decomposed = "worktree/café";
    expect(formatWireString(decomposed)).toBe(decomposed);
    expect(formatWireString(decomposed)).not.toBe(decomposed.normalize("NFC"));
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
  });
});

describe("formatCount — grouped, never abbreviated", () => {
  it("groups per locale and spells the number out in full", () => {
    expect(formatCount(1234567, "en-US")).toBe("1,234,567");
    // Control: compact notation is the tempting alternative but hides the exact figure.
    expect(formatCount(1234567, "en-US")).not.toBe(
      new Intl.NumberFormat("en-US", { notation: "compact" }).format(1234567),
    );
  });

  it("renders a dash for a figure that is not a number", () => {
    expect(formatCount(Number.NaN, "en-US")).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY, "en-US")).toBe("—");
  });
});

describe("every formatted quantity is rendered in the caller's locale", () => {
  // One property over five formatters: a hand-rolled `toFixed`, or one that dropped `locale`,
  // renders identically in both columns, so requiring the two to differ is the control.
  const renderings: readonly (readonly [string, string, string])[] = [
    [
      "byte quantity",
      formatByteQuantity(1536, "en-US").text,
      formatByteQuantity(1536, "de-DE").text,
    ],
    ["count", formatCount(1234567, "en-US"), formatCount(1234567, "de-DE")],
    ["duration", formatDuration(1500, "en-US"), formatDuration(1500, "de-DE")],
    ["money", formatMoney(1234.5, "EUR", "en-US"), formatMoney(1234.5, "EUR", "de-DE")],
    [
      "relative time",
      formatRelativeTime("2026-08-29T12:00:00Z", Date.UTC(2026, 8, 1, 12, 0, 0), "en-US"),
      formatRelativeTime("2026-08-29T12:00:00Z", Date.UTC(2026, 8, 1, 12, 0, 0), "de-DE"),
    ],
  ];

  it.each(renderings)("%s reads differently in en-US and de-DE", (_label, english, german) => {
    expect(english).not.toBe(german);
    expect(german).not.toBe("");
  });
});
