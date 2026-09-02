// The console's whole formatting policy, pinned.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules splits every figure into
// two classes and fixes what each may do, so the failures worth testing for are not
// "wrong output" but "the wrong class was applied":
//
//   • a byte-for-byte string that got transformed — a trimmed id, a normalized
//     digest — which still renders and is no longer what the daemon said;
//   • a quantity formatted by hand rather than through `Intl`, which reads fine on
//     the author's machine and renders `1.5` to an operator whose locale writes
//     `1,5`;
//   • the one sanctioned exception, byte scaling, drifting off powers of 1024 or
//     past the closed `B / KiB / MiB / GiB / TiB` label set.
//
// Every case below is written against one of those three, and each clean result
// carries the control that would catch it: a locale-blind implementation is caught
// by formatting the same value twice in two locales and requiring the two to
// differ, and a "tidying" identity function is caught by asserting the output is
// NOT what the tidy version would have produced.
//
// `formatClockTime` is asserted by SHAPE rather than by literal, deliberately.
// `Intl.DateTimeFormat` with no `timeZone` renders in the runner's zone, so a
// literal expectation would pin the test to whoever ran it first and fail in CI for
// a reason that has nothing to do with the console.

import { describe, expect, it } from "vitest";

import {
  BYTE_UNIT_LABELS,
  BYTE_UNIT_STEP,
  formatByteQuantity,
  formatClockTime,
  formatCount,
  formatDuration,
  formatMoney,
  formatRate,
  formatRelativeTime,
  formatWireString,
} from "./wire-figures.js";

/** A no-break space, written as an escape for the same reason the module does. */
const NO_BREAK_SPACE = "\u00A0";

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

describe("formatByteQuantity — the one sanctioned exception to Intl-only", () => {
  it("scales by powers of 1024, not by powers of 1000", () => {
    expect(formatByteQuantity(1024, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}KiB`);
    expect(formatByteQuantity(1024 * 1024, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}MiB`);
    expect(formatByteQuantity(1024 ** 3, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}GiB`);
    expect(formatByteQuantity(1024 ** 4, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}TiB`);

    // The control: a thousands-based scaler would have promoted 1000 to "1.0 KB"
    // and would NOT still be reporting plain bytes here. This is the exact figure
    // that disagrees with every other tool a developer has open when it is wrong.
    expect(formatByteQuantity(1000, "en-US")).toStrictEqual({
      value: "1,000",
      unit: "B",
      text: `1,000${NO_BREAK_SPACE}B`,
    });
    expect(BYTE_UNIT_STEP).toBe(1024);
  });

  it("promotes exactly at the step and not before it", () => {
    expect(formatByteQuantity(1023, "en-US").unit).toBe("B");
    expect(formatByteQuantity(1024, "en-US").unit).toBe("KiB");
    expect(formatByteQuantity(1024 * 1024 - 1, "en-US").unit).toBe("KiB");
    expect(formatByteQuantity(1024 * 1024, "en-US").unit).toBe("MiB");
  });

  it("never labels a figure outside the closed unit set", () => {
    // Sweep past the top of the set. TiB is the last label, so a petabyte-scale
    // figure has to saturate there and grow its NUMBER rather than invent "PiB".
    const units = [0, 1, 2, 3, 4, 5, 6].map((power) => formatByteQuantity(1024 ** power).unit);
    for (const unit of units) {
      expect(BYTE_UNIT_LABELS).toContain(unit);
    }
    expect(units).toStrictEqual(["B", "KiB", "MiB", "GiB", "TiB", "TiB", "TiB"]);
    expect(formatByteQuantity(1024 ** 5, "en-US").text).toBe(`1,024${NO_BREAK_SPACE}TiB`);
  });

  it("gives whole bytes no fraction and scaled units one, up to 99.9", () => {
    expect(formatByteQuantity(512, "en-US").value).toBe("512");
    expect(formatByteQuantity(102300, "en-US").value).toBe("99.9");
    expect(formatByteQuantity(102400, "en-US").value).toBe("100");

    // The boundary that the unrounded test got wrong: 102350 B is 99.951 KiB, which
    // is under the threshold but READS as "100.0" at one fraction digit — five
    // characters in a column this rule holds at four.
    expect(formatByteQuantity(102350, "en-US").value).toBe("100");
    expect(formatByteQuantity(102350, "en-US").value).not.toBe("100.0");
  });

  it("keeps the number and its unit on one line", () => {
    const quantity = formatByteQuantity(1536, "en-US");
    expect(quantity.text).toBe(`${quantity.value}${NO_BREAK_SPACE}${quantity.unit}`);
    // The control: an ordinary space is indistinguishable by eye and lets a figure
    // wrap away from its unit mid-line.
    expect(quantity.text).not.toBe(`${quantity.value} ${quantity.unit}`);
  });

  it("renders a dash rather than a number it cannot stand behind", () => {
    for (const notAByteCount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatByteQuantity(notAByteCount, "en-US")).toStrictEqual({
        value: "—",
        unit: "B",
        text: "—",
      });
    }
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

describe("formatDuration — the unit changes rather than the number growing", () => {
  it("keeps sub-second durations in milliseconds", () => {
    // "340 ms" and not "0.3 s": a run that took 340 ms is not "0.3 s" to anyone
    // debugging it.
    expect(formatDuration(340, "en-US")).toBe("340 ms");
    expect(formatDuration(999, "en-US")).toBe("999 ms");
    expect(formatDuration(0, "en-US")).toBe("0 ms");
  });

  it("changes unit at each boundary rather than letting the number run", () => {
    expect(formatDuration(1000, "en-US")).toBe("1 s");
    expect(formatDuration(1500, "en-US")).toBe("1.5 s");
    expect(formatDuration(59_000, "en-US")).toBe("59 s");
  });

  // `Spec-023 §Console Design (Meridian)` §The eight rules: digital at one minute
  // and above. The boundary is
  // the interesting part — one millisecond below it the shape is still `59 s`.
  it("switches to a digital reading at exactly one minute", () => {
    expect(formatDuration(59_999, "en-US")).toBe("60 s");
    expect(formatDuration(60_000, "en-US")).toBe("1:00");
    expect(formatDuration(90_000, "en-US")).toBe("1:30");
    expect(formatDuration(599_000, "en-US")).toBe("9:59");
    expect(formatDuration(3_599_000, "en-US")).toBe("59:59");
  });

  it("grows to hours only past an hour, and pads every borrowed field", () => {
    expect(formatDuration(3_600_000, "en-US")).toBe("1:00:00");
    expect(formatDuration(3_661_000, "en-US")).toBe("1:01:01");
    expect(formatDuration(5_400_000, "en-US")).toBe("1:30:00");
    // Ten hours is four digits wide, not five: only the borrowed fields pad.
    expect(formatDuration(36_000_000, "en-US")).toBe("10:00:00");
  });

  it("truncates the digital reading rather than rounding it", () => {
    // 59.6 s of a minute has not become the next minute.
    expect(formatDuration(119_600, "en-US")).toBe("1:59");
    // The negative control for the same rule: rounding would read "2:00".
    expect(formatDuration(119_600, "en-US")).not.toBe("2:00");
  });

  it("renders a dash for a duration it cannot stand behind", () => {
    expect(formatDuration(-1, "en-US")).toBe("—");
    expect(formatDuration(Number.NaN, "en-US")).toBe("—");
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

describe("formatRelativeTime — the platform composes the phrase", () => {
  const now = Date.parse("2026-09-01T12:00:00Z");

  it("picks its unit by magnitude and lets Intl write the words", () => {
    expect(formatRelativeTime("2026-09-01T12:00:00Z", now, "en-US")).toBe("now");
    expect(formatRelativeTime("2026-09-01T11:59:30Z", now, "en-US")).toBe("30 seconds ago");
    expect(formatRelativeTime("2026-09-01T12:00:30Z", now, "en-US")).toBe("in 30 seconds");
    expect(formatRelativeTime("2026-09-01T11:58:30Z", now, "en-US")).toBe("1 minute ago");
    expect(formatRelativeTime("2026-08-31T13:00:00Z", now, "en-US")).toBe("23 hours ago");
    expect(formatRelativeTime("2026-08-29T12:00:00Z", now, "en-US")).toBe("3 days ago");
  });

  it("switches unit exactly at each magnitude boundary", () => {
    expect(formatRelativeTime("2026-09-01T11:01:00Z", now, "en-US")).toBe("59 minutes ago");
    expect(formatRelativeTime("2026-09-01T11:00:00Z", now, "en-US")).toBe("1 hour ago");
    // `numeric: "auto"` is what turns the day boundary into a word rather than a
    // count — the control for it is that the hour on the other side of the same
    // boundary is still counted.
    expect(formatRelativeTime("2026-08-31T12:00:00Z", now, "en-US")).toBe("yesterday");
  });

  it("renders a dash for an instant it cannot parse", () => {
    expect(formatRelativeTime("not an instant", now, "en-US")).toBe("—");
    expect(formatRelativeTime("", now, "en-US")).toBe("—");
  });
});

describe("formatClockTime — a fixed-width 24-hour reading, no date", () => {
  const instant = "2026-09-01T13:04:05Z";

  it("renders hours, minutes, and seconds, zero-padded", () => {
    expect(formatClockTime(instant, "en-US")).toMatch(/^\d{2}:\d{2}:\d{2}$/u);
  });

  it("is 24-hour, in a locale whose default is not", () => {
    const rendered = formatClockTime(instant, "en-US");
    expect(rendered).not.toMatch(/AM|PM/u);
    // The control: en-US with the same fields and no `hour12: false` DOES carry a
    // day period, so the assertion above is testing the option rather than the
    // locale.
    expect(
      new Intl.DateTimeFormat("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(Date.parse(instant)),
    ).toMatch(/AM|PM/u);
  });

  it("carries no date, because the day divider carries it", () => {
    const rendered = formatClockTime(instant, "en-US");
    expect(rendered).not.toContain("/");
    expect(rendered).not.toContain(",");
    expect(rendered.replaceAll(":", "")).toHaveLength(6);
  });

  it("is a reading of the instant rather than a constant", () => {
    // One second apart differs; one hour and one second apart differs in more than
    // the seconds field. A stubbed formatter passes neither.
    const oneSecondLater = formatClockTime("2026-09-01T13:04:06Z", "en-US");
    expect(oneSecondLater).not.toBe(formatClockTime(instant, "en-US"));
    expect(oneSecondLater.slice(0, 5)).toBe(formatClockTime(instant, "en-US").slice(0, 5));
    expect(formatClockTime("2026-09-01T14:04:05Z", "en-US").slice(0, 2)).not.toBe(
      formatClockTime(instant, "en-US").slice(0, 2),
    );
  });

  it("renders a dash for an instant it cannot parse", () => {
    expect(formatClockTime("nope", "en-US")).toBe("—");
  });
});

describe("formatMoney — the wire's own precision, and never fewer than two digits", () => {
  it("pads to two fractional digits and keeps four below a unit", () => {
    expect(formatMoney(12, "USD", "en-US")).toBe("$12.00");
    expect(formatMoney(0.5, "USD", "en-US")).toBe("$0.50");
    expect(formatMoney(1234.5, "USD", "en-US")).toBe("$1,234.50");
    // A sub-cent figure is exactly where a token price lives, and two digits would
    // round it to "$0.12" — a number the daemon never sent.
    expect(formatMoney(0.1234, "USD", "en-US")).toBe("$0.1234");
    expect(formatMoney(0.1234, "USD", "en-US")).not.toBe("$0.12");
  });

  it("renders in the wire's own currency rather than a house one", () => {
    expect(formatMoney(1234.5, "EUR", "de-DE")).toBe(`1.234,50${NO_BREAK_SPACE}€`);
    // Two fractional digits even where the currency's own default is zero: the rule
    // is about the console's column, not about the currency's convention.
    expect(formatMoney(12, "JPY", "en-US")).toBe("¥12.00");
  });

  it("keeps the third digit of a currency whose minor unit is a thousandth", () => {
    // Two digits is a FLOOR, and a floor that also LOWERS is a cap. KWD, BHD and
    // TND are three of the currencies whose minor unit is a thousandth, so
    // capping at two renders 1.234 KWD as "KWD 1.23" — a figure the daemon never
    // sent, dropped by the very rule that exists to stop a sub-cent price being
    // rounded away.
    expect(formatMoney(1.234, "KWD", "en-US")).toBe(`KWD${NO_BREAK_SPACE}1.234`);
    expect(formatMoney(1.234, "KWD", "en-US")).not.toBe(`KWD${NO_BREAK_SPACE}1.23`);
    expect(formatMoney(1.234, "BHD", "en-US")).toBe(`BHD${NO_BREAK_SPACE}1.234`);
    expect(formatMoney(1.234, "TND", "en-US")).toBe(`TND${NO_BREAK_SPACE}1.234`);
    // The floor still binds where the currency's own precision is coarser, which
    // is what makes the assertions above about precision rather than about the
    // console having stopped padding.
    expect(formatMoney(1.5, "USD", "en-US")).toBe("$1.50");
    expect(formatMoney(1.5, "JPY", "en-US")).toBe("¥1.50");
  });

  it("caches a currency's precision without letting the cache answer for another", () => {
    // The precision is read once per code and remembered under a bound, so the
    // failures worth pinning are an evicted entry coming back wrong and a
    // remembered one answering for the wrong currency. Formatting far more
    // distinct codes than the cache holds and then re-asserting both a
    // three-digit and a two-digit currency catches either.
    for (let letter = 0; letter < 26; letter += 1) {
      for (const suffix of ["AA", "BB"]) {
        formatMoney(1.5, `${String.fromCharCode("A".charCodeAt(0) + letter)}${suffix}`, "en-US");
      }
    }

    expect(formatMoney(1.234, "KWD", "en-US")).toBe(`KWD${NO_BREAK_SPACE}1.234`);
    expect(formatMoney(1.5, "USD", "en-US")).toBe("$1.50");
    expect(formatMoney(12, "JPY", "en-US")).toBe("¥12.00");
  });

  it("still shows the figure when the currency code is one Intl rejects", () => {
    // `Intl.NumberFormat` throws `RangeError` on anything that is not three ASCII
    // letters, and the currency is a wire string. Throwing inside a render body
    // would blank the surface through its error boundary and hide a figure the
    // daemon did send, so the amount keeps its `Intl` formatting and the code
    // renders verbatim beside it.
    expect(() => new Intl.NumberFormat("en-US", { style: "currency", currency: "?" })).toThrow(
      RangeError,
    );
    // The minor-unit lookup constructs a SECOND formatter with the same currency,
    // so it throws in the same place; it sits inside the same `try` for exactly
    // that reason, and this is the assertion that says so.
    expect(() => formatMoney(1.5, "?", "en-US")).not.toThrow();
    expect(formatMoney(1.5, "?", "en-US")).toBe(`1.50${NO_BREAK_SPACE}?`);
    expect(formatMoney(1.5, "not-a-code", "en-US")).toBe(`1.50${NO_BREAK_SPACE}not-a-code`);
  });

  it("chooses the sub-unit floor by magnitude, so a credit aligns with a charge", () => {
    // The sub-unit floor asks whether the figure HAS a sub-unit part, which is a
    // question about magnitude. A bare `amount < 1` answers yes for every negative
    // amount, so a -123.4567 credit rendered four fractional digits beside a
    // 123.4567 charge rendering two — the misalignment the floor exists to
    // prevent, in the one column where a refund and a charge sit on adjacent rows.
    //
    // The witness carries sub-cent digits deliberately. The floor raises a CAP and
    // never pads, so a whole-unit -123 reads "-$123.00" under either comparison
    // and would witness nothing.
    expect(formatMoney(-123.4567, "USD", "en-US")).toBe("-$123.46");
    expect(formatMoney(123.4567, "USD", "en-US")).toBe("$123.46");
    expect(formatMoney(-123.4567, "USD", "en-US")).not.toBe("-$123.4567");
    // And the floor still binds on both signs where the magnitude really is
    // sub-unit, which is what makes the assertions above about the comparison
    // rather than about the floor having been dropped. The figure carries four
    // significant sub-unit digits, because the floor raises the CAP and never
    // pads: a -0.25 credit reads "-$0.25" whichever comparison is in force, so it
    // would witness nothing.
    expect(formatMoney(-0.1234, "USD", "en-US")).toBe("-$0.1234");
    expect(formatMoney(0.1234, "USD", "en-US")).toBe("$0.1234");
  });

  it("renders a dash for an amount that is not a number", () => {
    expect(formatMoney(Number.NaN, "USD", "en-US")).toBe("—");
    expect(formatMoney(Number.POSITIVE_INFINITY, "USD", "en-US")).toBe("—");
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
      formatRelativeTime("2026-08-29T12:00:00Z", Date.parse("2026-09-01T12:00:00Z"), "en-US"),
      formatRelativeTime("2026-08-29T12:00:00Z", Date.parse("2026-09-01T12:00:00Z"), "de-DE"),
    ],
  ];

  it.each(renderings)("%s reads differently in en-US and de-DE", (_label, english, german) => {
    expect(english).not.toBe(german);
    expect(german).not.toBe("");
  });
});
