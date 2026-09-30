// Most of this file is refusals, each paired with the `Date.parse` reading it replaces, since
// `Date.parse` answering a number for a value RFC 3339 does not admit is the defect being closed.

import { describe, expect, it } from "vitest";

import {
  compareInstants,
  MILLISECONDS_PER_DAY,
  MILLISECONDS_PER_HOUR,
  MILLISECONDS_PER_MINUTE,
  MILLISECONDS_PER_SECOND,
  parseInstant,
} from "./instant.js";

describe("parseInstant — the encoding the wire declares, and nothing wider", () => {
  it("reads a Z-terminated instant", () => {
    const reading = parseInstant("2026-09-01T12:00:00Z");
    expect(reading.kind).toBe("instant");
    expect(reading.epochMilliseconds).toBe(Date.UTC(2026, 8, 1, 12, 0, 0));
    expect(reading.text).toBe("2026-09-01T12:00:00Z");
  });

  // The number is readable only once the arm is narrowed, hence `epochMilliseconds?: undefined`
  // on the malformed arm rather than a `NaN`.
  const epochMillisecondsOf = (text: string): number => {
    const reading = parseInstant(text);
    if (reading.kind === "malformed") {
      throw new Error(`the fixture instant "${text}" is not one`);
    }
    return reading.epochMilliseconds;
  };

  it("reads a numeric offset as the instant it names, not as the digits it shows", () => {
    // This stamp reads later than the Z one below yet is earlier; a text comparison gets it wrong.
    expect(epochMillisecondsOf("2026-09-01T10:00:00+02:00")).toBe(
      epochMillisecondsOf("2026-09-01T09:00:00Z") - 3_600_000,
    );
    expect("2026-09-01T10:00:00+02:00" > "2026-09-01T09:00:00Z").toBe(true);
  });

  it("reads a negative offset and a half-hour offset", () => {
    expect(epochMillisecondsOf("2026-09-01T07:00:00-05:00")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z"),
    );
    expect(epochMillisecondsOf("2026-09-01T17:30:00+05:30")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z"),
    );
  });

  it("keeps sub-second precision", () => {
    expect(epochMillisecondsOf("2026-09-01T12:00:00.250Z")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z") + 250,
    );
    expect(parseInstant("2026-09-01T12:00:00.123456Z").kind).toBe("instant");
  });

  // Each case is a value `Date.parse` reads as a number; the second assertion is the control.
  it.each([
    ["a day that does not exist", "2026-02-30T10:00:00Z"],
    ["February 29 in a common year", "2027-02-29T10:00:00Z"],
    ["the 31st of a thirty-day month", "2026-04-31T10:00:00Z"],
    ["hour 24", "2026-01-01T24:00:00Z"],
    ["a timezone-less local time", "2026-01-01T10:00:00"],
    ["a date with no time at all", "2026-01-01"],
    ["a compact offset with no colon", "2026-01-01T10:00:00+0200"],
  ])("refuses %s, which Date.parse silently accepts", (_label, text) => {
    expect(parseInstant(text).kind).toBe("malformed");
    expect(Number.isNaN(Date.parse(text))).toBe(false);
  });

  it.each([
    ["month 13", "2026-13-01T10:00:00Z"],
    ["second 60", "2026-01-01T10:00:60Z"],
    ["free text", "not an instant"],
    ["the empty string", ""],
  ])("refuses %s", (_label, text) => {
    expect(parseInstant(text).kind).toBe("malformed");
  });

  it("carries the wire's own spelling on both arms, so a refusal can quote it", () => {
    expect(parseInstant("2026-02-30T10:00:00Z").text).toBe("2026-02-30T10:00:00Z");
    expect(parseInstant("2026-09-01T12:00:00Z").text).toBe("2026-09-01T12:00:00Z");
  });

  it("answers an absent number on the malformed arm rather than NaN", () => {
    // Readable without narrowing, and `undefined` rather than `NaN`, which compares false against
    // everything and would make an order depend on where the unreadable value landed.
    const reading = parseInstant("nope");
    expect(reading.epochMilliseconds).toBeUndefined();
    expect(reading.epochMilliseconds).not.toBeNaN();
  });

  it("records the one RFC 3339 spelling this reader narrows away", () => {
    // A leap second is permitted by RFC 3339 section 5.6 and refused here; it fails closed as a
    // row sorted last, never a wrong instant.
    expect(parseInstant("2026-12-31T23:59:60Z").kind).toBe("malformed");
  });

  it("reads the lowercase separators RFC 3339 section 5.6 permits", () => {
    expect(epochMillisecondsOf("2026-09-01t12:00:00z")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z"),
    );
  });

  it("truncates a fraction wider than milliseconds, never rounding it later", () => {
    expect(epochMillisecondsOf("2026-09-01T12:00:00.123456Z")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z") + 123,
    );
    expect(epochMillisecondsOf("2026-09-01T12:00:00.9999Z")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z") + 999,
    );
  });

  it("reads February 29 of a leap year, including a century year the rule keeps", () => {
    expect(parseInstant("2024-02-29T00:00:00Z").kind).toBe("instant");
    expect(parseInstant("2000-02-29T00:00:00Z").kind).toBe("instant");
    expect(parseInstant("1900-02-29T00:00:00Z").kind).toBe("malformed");
  });

  it("reads a two-digit year as itself, not as the twentieth century", () => {
    const yearNinetyNine = new Date(0);
    yearNinetyNine.setUTCFullYear(99, 0, 1);
    yearNinetyNine.setUTCHours(0, 0, 0, 0);
    expect(epochMillisecondsOf("0099-01-01T00:00:00Z")).toBe(yearNinetyNine.getTime());
    // Control: `Date.UTC` alone reads the same digits as 1999.
    expect(epochMillisecondsOf("0099-01-01T00:00:00Z")).not.toBe(Date.UTC(99, 0, 1));
  });

  it.each([
    ["an offset hour past 23", "2026-01-01T10:00:00+24:00"],
    ["an offset minute past 59", "2026-01-01T10:00:00+02:60"],
    ["a space where the T belongs", "2026-01-01 10:00:00Z"],
    ["a year of five digits", "12026-01-01T10:00:00Z"],
  ])("refuses %s", (_label, text) => {
    expect(parseInstant(text).kind).toBe("malformed");
  });
});

describe("parseInstant — the offset policy the caller's contract declares", () => {
  // Each case reads one text two ways, with `"any-offset"` as the control for the `"utc-only"`
  // refusal.
  it.each([
    ["a positive numeric offset", "2026-09-01T10:00:00+02:00"],
    ["a negative numeric offset", "2026-09-01T07:00:00-05:00"],
    ["a lowercase Z", "2026-09-01T12:00:00z"],
    ["a lowercase T", "2026-09-01t12:00:00Z"],
    ["both separators lowercase", "2026-09-01t12:00:00z"],
  ])("refuses %s under utc-only and reads it under any-offset", (_label, text) => {
    expect(parseInstant(text, "utc-only").kind).toBe("malformed");
    expect(parseInstant(text, "any-offset").kind).toBe("instant");
  });

  it("reads a Z-terminated instant identically under either policy", () => {
    const strict = parseInstant("2026-09-01T12:00:00.250Z", "utc-only");
    expect(strict).toStrictEqual(parseInstant("2026-09-01T12:00:00.250Z", "any-offset"));
    expect(strict.epochMilliseconds).toBe(Date.UTC(2026, 8, 1, 12, 0, 0, 250));
  });

  it("defaults to any-offset, so a caller that names no policy keeps its reading", () => {
    expect(parseInstant("2026-09-01T10:00:00+02:00").kind).toBe("instant");
    expect(parseInstant("2026-09-01T12:00:00z").kind).toBe("instant");
  });

  it("carries the wire's own spelling on a policy refusal, so it can be quoted", () => {
    expect(parseInstant("2026-09-01T10:00:00+02:00", "utc-only").text).toBe(
      "2026-09-01T10:00:00+02:00",
    );
  });

  it("keeps every other refusal a refusal under utc-only too", () => {
    // The policy only narrows: a day that does not exist stays malformed with `Z` and `T`.
    expect(parseInstant("2026-02-30T10:00:00Z", "utc-only").kind).toBe("malformed");
    expect(parseInstant("2026-01-01", "utc-only").kind).toBe("malformed");
  });
});

describe("parseInstant — total against a value that is not a string at all", () => {
  // The parser is handed wire values the console did not validate, so the parameter type says
  // nothing about the value. Each case is its own control: the raw `exec` throws on the value.
  const RFC_3339_SHAPED = /^(\d{4})-/;

  it.each([
    ["a null-prototype object", (): unknown => Object.create(null) as unknown],
    ["a symbol", (): unknown => Symbol("thrown")],
    [
      "an object whose toString throws",
      (): unknown => ({
        toString(): never {
          throw new Error("this stringifier is hostile");
        },
      }),
    ],
  ])("refuses %s, which RegExp.exec throws on", (_label, build) => {
    const value = build();
    expect(() => RFC_3339_SHAPED.exec(value as unknown as string)).toThrow();
    const reading = parseInstant(value as unknown as string);
    expect(reading.kind).toBe("malformed");
    expect(reading.epochMilliseconds).toBeUndefined();
  });

  it.each([
    ["a number", 20_260_101, "20260101"],
    ["null", null, "null"],
    ["undefined", undefined, "undefined"],
    ["a plain object", { when: "now" }, "[object Object]"],
  ])("refuses %s and quotes it as a string", (_label, value, quoted) => {
    const reading = parseInstant(value as unknown as string);
    expect(reading.kind).toBe("malformed");
    // `text` is declared `string` and is what a refusal renders, so it must be a string here too.
    expect(reading.text).toBe(quoted);
    expect(typeof reading.text).toBe("string");
  });

  it("quotes an unrepresentable value with the total stringifier's own sentence", () => {
    expect(parseInstant(Object.create(null) as unknown as string).text).toBe(
      "[unrepresentable value]",
    );
  });
});

describe("compareInstants — unreadable last, in both directions", () => {
  const earlier = parseInstant("2026-09-01T09:00:00Z");
  const later = parseInstant("2026-09-01T12:00:00Z");
  const offsetEarlier = parseInstant("2026-09-01T10:00:00+02:00");
  const malformed = parseInstant("nope");
  const alsoMalformed = parseInstant("");

  it("orders oldest first by default", () => {
    expect(compareInstants(earlier, later)).toBe(-1);
    expect(compareInstants(later, earlier)).toBe(1);
    expect(compareInstants(earlier, earlier)).toBe(0);
  });

  it("orders newest first on request", () => {
    expect(compareInstants(earlier, later, "newest-first")).toBe(1);
    expect(compareInstants(later, earlier, "newest-first")).toBe(-1);
  });

  it("orders an offset stamp by its instant, where text ordering has it backwards", () => {
    // `10:00+02:00` is 08:00Z, so it precedes `09:00Z`; a lexical comparison says the opposite.
    expect(compareInstants(offsetEarlier, earlier)).toBe(-1);
    expect(offsetEarlier.text.localeCompare(earlier.text)).toBeGreaterThan(0);
  });

  it("keeps an unreadable stamp last whichever way the list is sorted", () => {
    expect(compareInstants(malformed, later)).toBe(1);
    expect(compareInstants(later, malformed)).toBe(-1);
    expect(compareInstants(malformed, later, "newest-first")).toBe(1);
    expect(compareInstants(later, malformed, "newest-first")).toBe(-1);
  });

  it("ties two unreadable stamps, so the caller's next key decides", () => {
    expect(compareInstants(malformed, alsoMalformed)).toBe(0);
    expect(compareInstants(malformed, alsoMalformed, "newest-first")).toBe(0);
  });

  it("sorts a whole list, unreadable stamps last at both ends", () => {
    const readings = [malformed, later, earlier, offsetEarlier];
    const oldestFirst = [...readings].sort((left, right) => compareInstants(left, right));
    const newestFirst = [...readings].sort((left, right) =>
      compareInstants(left, right, "newest-first"),
    );
    expect(oldestFirst.map((reading) => reading.text)).toStrictEqual([
      "2026-09-01T10:00:00+02:00",
      "2026-09-01T09:00:00Z",
      "2026-09-01T12:00:00Z",
      "nope",
    ]);
    expect(newestFirst.map((reading) => reading.text)).toStrictEqual([
      "2026-09-01T12:00:00Z",
      "2026-09-01T09:00:00Z",
      "2026-09-01T10:00:00+02:00",
      "nope",
    ]);
    // Control for the module: ordered as text, the offset stamp lands on the wrong side of `09:00Z`
    // and the descending list puts the unreadable value first.
    expect(
      [...readings]
        .sort((left, right) => left.text.localeCompare(right.text))
        .map((reading) => reading.text),
    ).not.toStrictEqual(oldestFirst.map((reading) => reading.text));
    expect(
      [...readings]
        .sort((left, right) => right.text.localeCompare(left.text))
        .map((reading) => reading.text),
    ).not.toStrictEqual(newestFirst.map((reading) => reading.text));
  });

  it("answers only a sign, never a magnitude", () => {
    // Days apart and milliseconds apart answer the same number: `sort` only defines the sign.
    expect(compareInstants(parseInstant("2020-01-01T00:00:00Z"), later)).toBe(-1);
    expect(compareInstants(parseInstant("2026-09-01T11:59:59.999Z"), later)).toBe(-1);
  });
});

describe("the millisecond unit factors", () => {
  it("names the magnitude of each unit, independently of the chain that derives it", () => {
    // The factors are arithmetic over one base; the magnitudes are literals here so a wrong
    // multiplier fails in this file.
    expect(MILLISECONDS_PER_SECOND).toBe(1_000);
    expect(MILLISECONDS_PER_MINUTE).toBe(60_000);
    expect(MILLISECONDS_PER_HOUR).toBe(3_600_000);
    expect(MILLISECONDS_PER_DAY).toBe(86_400_000);
  });

  it("agrees with the platform's own calendar arithmetic", () => {
    // Control for a chain that is consistent and wrong (a base of 100 satisfies every ratio):
    // `Date.UTC` is the independent instrument, measured across a day boundary.
    expect(Date.UTC(2026, 8, 2) - Date.UTC(2026, 8, 1)).toBe(MILLISECONDS_PER_DAY);
    expect(Date.UTC(2026, 8, 1, 1) - Date.UTC(2026, 8, 1, 0)).toBe(MILLISECONDS_PER_HOUR);
    expect(Date.UTC(2026, 8, 1, 0, 1) - Date.UTC(2026, 8, 1, 0, 0)).toBe(MILLISECONDS_PER_MINUTE);
    expect(Date.UTC(2026, 8, 1, 0, 0, 1) - Date.UTC(2026, 8, 1, 0, 0, 0)).toBe(
      MILLISECONDS_PER_SECOND,
    );
  });
});
