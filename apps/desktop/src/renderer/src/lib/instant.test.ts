// Most of this file is refusals, each paired with the `Date.parse` reading it replaces, since
// `Date.parse` answering a number for a value RFC 3339 does not admit is the defect being closed.

import { describe, expect, it } from "vitest";

import { compareInstants, parseInstant } from "./instant.js";

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
    // A negative offset and a half-hour offset.
    expect(epochMillisecondsOf("2026-09-01T07:00:00-05:00")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z"),
    );
    expect(epochMillisecondsOf("2026-09-01T17:30:00+05:30")).toBe(
      epochMillisecondsOf("2026-09-01T12:00:00Z"),
    );
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
});

describe("compareInstants — unreadable last, in both directions", () => {
  const earlier = parseInstant("2026-09-01T09:00:00Z");
  const later = parseInstant("2026-09-01T12:00:00Z");
  const offsetEarlier = parseInstant("2026-09-01T10:00:00+02:00");
  const malformed = parseInstant("nope");

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
});
