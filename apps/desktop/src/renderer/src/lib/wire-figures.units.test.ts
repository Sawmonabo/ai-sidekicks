// The figures whose unit and precision the console decides, not `Intl`. Byte scaling can drift off
// powers of 1024 or past the closed `B / KiB / MiB / GiB / TiB` set. Money needs a floor of two
// fractional digits that never lowers, or a currency with a thousandth minor unit and a token
// price would lose digits the daemon sent. The no-break space is declared here, not read from the
// module, which would pass whichever character it chose.
//
// Money also handles wire input: a currency code `Intl` rejects must still render the amount, the
// per-code minor-unit cache must not answer for another currency, and the sub-unit floor is chosen
// by magnitude so a credit aligns with a charge.

import { describe, expect, it } from "vitest";

import {
  BYTE_UNIT_LABELS,
  BYTE_UNIT_STEP,
  formatByteQuantity,
  formatCentsAsCurrency,
  formatMoney,
} from "./wire-figures.js";

/** A no-break space, written as an escape as the module does. */
const NO_BREAK_SPACE = "\u00A0";

describe("formatByteQuantity — the one sanctioned exception to Intl-only", () => {
  it("scales by powers of 1024, not by powers of 1000", () => {
    expect(formatByteQuantity(1024, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}KiB`);
    expect(formatByteQuantity(1024 * 1024, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}MiB`);
    expect(formatByteQuantity(1024 ** 3, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}GiB`);
    expect(formatByteQuantity(1024 ** 4, "en-US").text).toBe(`1.0${NO_BREAK_SPACE}TiB`);

    // Control: a thousands-based scaler would promote 1000 to "1.0 KB".
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
    // TiB is the last label, so a petabyte-scale figure saturates there and grows its number.
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

    // 102350 B is 99.951 KiB, under the threshold but "100.0" at one fraction digit, which is
    // five characters in a four-character column.
    expect(formatByteQuantity(102350, "en-US").value).toBe("100");
    expect(formatByteQuantity(102350, "en-US").value).not.toBe("100.0");
  });

  it("keeps the number and its unit on one line", () => {
    const quantity = formatByteQuantity(1536, "en-US");
    expect(quantity.text).toBe(`${quantity.value}${NO_BREAK_SPACE}${quantity.unit}`);
    // Control: an ordinary space lets a figure wrap away from its unit.
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
    // A token price is sub-cent, and two digits would round it to "$0.12".
    expect(formatMoney(0.1234, "USD", "en-US")).toBe("$0.1234");
    expect(formatMoney(0.1234, "USD", "en-US")).not.toBe("$0.12");
  });

  it("renders in the wire's own currency rather than a house one", () => {
    expect(formatMoney(1234.5, "EUR", "de-DE")).toBe(`1.234,50${NO_BREAK_SPACE}€`);
    // Two fractional digits even where the currency's default is zero: the floor is the console's.
    expect(formatMoney(12, "JPY", "en-US")).toBe("¥12.00");
  });

  it("keeps the third digit of a currency whose minor unit is a thousandth", () => {
    // Two digits is a floor; a floor that also lowered would render 1.234 KWD as "KWD 1.23". KWD,
    // BHD and TND have a thousandth minor unit.
    expect(formatMoney(1.234, "KWD", "en-US")).toBe(`KWD${NO_BREAK_SPACE}1.234`);
    expect(formatMoney(1.234, "KWD", "en-US")).not.toBe(`KWD${NO_BREAK_SPACE}1.23`);
    expect(formatMoney(1.234, "BHD", "en-US")).toBe(`BHD${NO_BREAK_SPACE}1.234`);
    expect(formatMoney(1.234, "TND", "en-US")).toBe(`TND${NO_BREAK_SPACE}1.234`);
    // The floor still binds where the currency is coarser, so the above is about precision, not
    // padding.
    expect(formatMoney(1.5, "USD", "en-US")).toBe("$1.50");
    expect(formatMoney(1.5, "JPY", "en-US")).toBe("¥1.50");
  });

  it("caches a currency's precision without letting the cache answer for another", () => {
    // Precision is cached per code under a bound, so an evicted entry coming back wrong or one
    // answering for another currency are the failures. Formatting more codes than the cache holds,
    // then re-asserting a three-digit and a two-digit currency, catches either.
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
    // `Intl.NumberFormat` throws `RangeError` on a code that is not three ASCII letters; throwing
    // in a render body would hide a figure the daemon sent, so the code renders beside the amount.
    expect(() => new Intl.NumberFormat("en-US", { style: "currency", currency: "?" })).toThrow(
      RangeError,
    );
    // The minor-unit lookup builds a second formatter with the same currency, so it must sit
    // inside the same `try`.
    expect(() => formatMoney(1.5, "?", "en-US")).not.toThrow();
    expect(formatMoney(1.5, "?", "en-US")).toBe(`1.50${NO_BREAK_SPACE}?`);
    expect(formatMoney(1.5, "not-a-code", "en-US")).toBe(`1.50${NO_BREAK_SPACE}not-a-code`);
  });

  it("chooses the sub-unit floor by magnitude, so a credit aligns with a charge", () => {
    // The sub-unit floor is a question of magnitude. A bare `amount < 1` is true of every negative
    // amount, so a -123.4567 credit would show four digits beside a charge showing two. The witness
    // carries sub-cent digits because the floor raises a cap and never pads, so -123 would prove
    // nothing.
    expect(formatMoney(-123.4567, "USD", "en-US")).toBe("-$123.46");
    expect(formatMoney(123.4567, "USD", "en-US")).toBe("$123.46");
    expect(formatMoney(-123.4567, "USD", "en-US")).not.toBe("-$123.4567");
    // The floor still binds on both signs where the magnitude really is sub-unit. The figure has
    // four sub-unit digits, since -0.25 would read "-$0.25" under either comparison.
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
    // Without the divisor this would read "$123,456.00", a hundred times the figure sent.
    expect(formatCentsAsCurrency(123_456, "en-US")).not.toBe("$123,456.00");
  });

  it("keeps the shared formatter's precision rather than re-deciding it", () => {
    // Below a whole unit `formatMoney` raises its digit ceiling to four; a ceiling is not a pad,
    // so seven cents keeps its two digits...
    expect(formatCentsAsCurrency(7, "en-US")).toBe("$0.07");
    // ...and a figure finer than a cent keeps its digits. The cents adapter adds only a divisor.
    expect(formatCentsAsCurrency(0.5, "en-US")).toBe("$0.005");
  });

  it("carries a figure it cannot render through the shared formatter's own dash", () => {
    expect(formatCentsAsCurrency(Number.NaN, "en-US")).toBe("—");
  });
});
