// The two figures whose unit and precision the console decides, not `Intl`.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules puts every quantity through
// `Intl`, and these two are where obeying that literally is not enough. `Intl` has
// no 1024 scale and no opinion about which of five labels a byte count should wear,
// so byte scaling is the rule's one sanctioned exception — and the ways it goes
// wrong are drifting off powers of 1024, or past the closed
// `B / KiB / MiB / GiB / TiB` set. `Intl` does know a currency's minor unit, but its
// answer is not the console's: the column needs a FLOOR of two fractional digits,
// and a floor that also lowered would be a cap that drops the third digit of a
// currency whose minor unit is a thousandth and the sub-cent digits of a token
// price — two figures the daemon did send.
//
// Both compose their result the same way once the number is formatted, pairing it
// with the unit across a no-break space so the two cannot wrap apart mid-line. That
// separator is the one value this file declares for itself rather than reading off
// the module it is holding, which would pass whichever character that module chose.
//
// Money carries three further failures that are all about a value arriving from the
// wire rather than from the console. The currency CODE is a wire string, and
// `Intl.NumberFormat` throws `RangeError` on anything that is not three ASCII
// letters, so a code it rejects has to leave the amount rendered and the code
// verbatim rather than blanking the surface through an error boundary. The minor
// unit is read once per code and remembered under a bound, so an evicted entry
// coming back wrong and a remembered one answering for another currency are both
// reachable. And the sub-unit floor asks whether the figure HAS a sub-unit part,
// which is a question about magnitude — so a credit has to align with the charge on
// the row above it.

import { describe, expect, it } from "vitest";

import {
  BYTE_UNIT_LABELS,
  BYTE_UNIT_STEP,
  formatByteQuantity,
  formatCentsAsCurrency,
  formatMoney,
} from "./wire-figures.js";

/** A no-break space, written as an escape for the same reason the module does. */
const NO_BREAK_SPACE = "\u00A0";

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

describe("formatCentsAsCurrency — the wire counts in cents and a person reads money", () => {
  it("scales the wire's cents into the currency unit", () => {
    expect(formatCentsAsCurrency(123_456, "en-US")).toBe("$1,234.56");
    expect(formatCentsAsCurrency(0, "en-US")).toBe("$0.00");
  });

  it("negative control: it does not render the cents figure as though it were dollars", () => {
    // Without the divisor this would read "$123,456.00" — a figure a hundred times
    // the one the daemon sent, and the single most expensive way to be wrong here.
    expect(formatCentsAsCurrency(123_456, "en-US")).not.toBe("$123,456.00");
  });

  it("keeps the shared formatter's precision rather than re-deciding it", () => {
    // Below a whole unit `formatMoney` raises its fractional-digit ceiling to four.
    // A ceiling is not a pad, so seven cents keeps its own two digits...
    expect(formatCentsAsCurrency(7, "en-US")).toBe("$0.07");
    // ...and a figure finer than a cent keeps the digits it arrived with instead of
    // being rounded to the cent it is near, which is why that ceiling is raised.
    // This module supplies a divisor and no precision policy at all.
    expect(formatCentsAsCurrency(0.5, "en-US")).toBe("$0.005");
  });

  it("carries a figure it cannot render through the shared formatter's own dash", () => {
    expect(formatCentsAsCurrency(Number.NaN, "en-US")).toBe("—");
  });
});
