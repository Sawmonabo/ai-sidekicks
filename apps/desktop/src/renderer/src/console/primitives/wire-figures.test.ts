// The figures the console passes straight through, and the locale property that
// holds every formatter at once.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules splits every figure into
// two classes and fixes what each may do, so the failures worth testing for are not
// "wrong output" but "the wrong class was applied":
//
//   • a byte-for-byte string that got transformed — a trimmed id, a normalized
//     digest — which still renders and is no longer what the daemon said;
//   • a quantity formatted by hand rather than through `Intl`, which reads fine on
//     the author's machine and renders `1.5` to an operator whose locale writes
//     `1,5`.
//
// The three formatters here are the ones that add nothing of their own: a wire
// string comes back the very string it went in as, and a count and a rate are what
// `Intl` makes of the number with a caller-supplied unit. Each clean result carries
// the control that would catch it — a "tidying" identity function is caught by
// asserting the output is NOT what the tidy version would have produced, and a
// locale-blind implementation is caught by the property this file closes on, which
// formats the same value twice in two locales and requires the two to differ. That
// property lives here rather than beside any one formatter because it ranges over
// all six.
//
// The formatters that decide something `Intl` does not have their own files: the
// four time readings, where the UNIT changes rather than the number growing, in
// `wire-figures.time.test.ts`; and the two figures whose unit and precision the
// console picks itself, in `wire-figures.units.test.ts`.

import { describe, expect, it } from "vitest";

import {
  formatByteQuantity,
  formatCount,
  formatDuration,
  formatMoney,
  formatRate,
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
    // The negative control: each of these is a transformation a well-meaning author
    // might add, and each produces a DIFFERENT string from the one asserted above —
    // so the identity assertion is not passing because both sides are the same
    // tidy-up.
    const padded = "  session.created  ";
    expect(formatWireString(padded)).not.toBe(padded.trim());

    const shouty = "RUN.FAILED";
    expect(formatWireString(shouty)).not.toBe(shouty.toLowerCase());

    // "é" as e + combining acute. NFC would collapse it to one codepoint, which is
    // a different byte sequence — and a digest or a path is bytes.
    const decomposed = "worktree/café";
    expect(formatWireString(decomposed)).toBe(decomposed);
    expect(formatWireString(decomposed)).not.toBe(decomposed.normalize("NFC"));
    expect(decomposed.normalize("NFC")).not.toBe(decomposed);
  });
});

describe("formatCount — grouped, never abbreviated", () => {
  it("groups per locale and spells the number out in full", () => {
    expect(formatCount(1234567, "en-US")).toBe("1,234,567");
    // The control: compact notation is the tempting alternative, and §The eight
    // rules admits it "only where the exact figure is one hover away" — which a
    // bare count is not.
    expect(formatCount(1234567, "en-US")).not.toBe(
      new Intl.NumberFormat("en-US", { notation: "compact" }).format(1234567),
    );
  });

  it("renders a dash for a figure that is not a number", () => {
    expect(formatCount(Number.NaN, "en-US")).toBe("—");
    expect(formatCount(Number.POSITIVE_INFINITY, "en-US")).toBe("—");
  });
});

describe("formatRate — a derived rate carries its own unit", () => {
  it("holds one fraction digit and appends the caller's unit", () => {
    expect(formatRate(12.34, "tok", "en-US")).toBe("12.3 tok/s");
    expect(formatRate(0, "tok", "en-US")).toBe("0 tok/s");
  });

  it("renders a dash for a rate it cannot stand behind", () => {
    expect(formatRate(-1, "tok", "en-US")).toBe("—");
    expect(formatRate(Number.NaN, "tok", "en-US")).toBe("—");
  });
});

describe("every formatted quantity is rendered in the caller's locale", () => {
  // One property over six formatters. A hand-rolled `toFixed` implementation, or
  // one that dropped the `locale` parameter on the floor, renders identically in
  // both columns — so requiring the two to differ IS the control, and it fails for
  // exactly the defect §The eight rules' `Intl` requirement exists to prevent.
  const renderings: readonly (readonly [string, string, string])[] = [
    [
      "byte quantity",
      formatByteQuantity(1536, "en-US").text,
      formatByteQuantity(1536, "de-DE").text,
    ],
    ["count", formatCount(1234567, "en-US"), formatCount(1234567, "de-DE")],
    ["duration", formatDuration(1500, "en-US"), formatDuration(1500, "de-DE")],
    ["rate", formatRate(12.34, "tok", "en-US"), formatRate(12.34, "tok", "de-DE")],
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
