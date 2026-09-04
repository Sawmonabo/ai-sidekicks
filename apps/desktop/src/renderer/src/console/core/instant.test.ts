// The parser's job is what it REFUSES, so most of this file is refusals — each one
// paired with the `Date.parse` reading it replaces, because `Date.parse` answering a
// number for a value RFC 3339 does not admit is the whole defect this module exists
// to close. Those pairings are the negative controls: every one of them fails
// against the old code, which had no validator at all.

import { describe, expect, it } from "vitest";

import { compareInstants, parseInstant } from "./instant.js";

describe("parseInstant — the encoding the wire declares, and nothing wider", () => {
  it("reads a Z-terminated instant", () => {
    const reading = parseInstant("2026-09-01T12:00:00Z");
    expect(reading.kind).toBe("instant");
    expect(reading.epochMilliseconds).toBe(Date.UTC(2026, 8, 1, 12, 0, 0));
    expect(reading.text).toBe("2026-09-01T12:00:00Z");
  });

  // Arithmetic needs the number, and the number is only readable once the arm is
  // narrowed — the type doing the guard's job, which is why the malformed arm carries
  // `epochMilliseconds?: undefined` rather than a `NaN`.
  const epochMillisecondsOf = (text: string): number => {
    const reading = parseInstant(text);
    if (reading.kind === "malformed") {
      throw new Error(`the fixture instant "${text}" is not one`);
    }
    return reading.epochMilliseconds;
  };

  it("reads a numeric offset as the instant it names, not as the digits it shows", () => {
    // The defect in one line: this stamp READS later than the Z one below and IS
    // earlier. Anything that compared the two as text had them backwards.
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

  // Each case below is a value `Date.parse` reads as a NUMBER. The second assertion
  // in each is the negative control: it is what the console rendered before.
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
    // The property is readable without narrowing, and it is `undefined` and not
    // `NaN` — the one number that compares false against everything including
    // itself, so a caller that forgot a guard would get an order that depends on
    // which side the unreadable value landed on.
    const reading = parseInstant("nope");
    expect(reading.epochMilliseconds).toBeUndefined();
    expect(reading.epochMilliseconds).not.toBeNaN();
  });

  it("records the two RFC 3339 spellings this validator narrows away", () => {
    // Both are permitted by RFC 3339 §5.6 and refused here, and both fail CLOSED —
    // an em dash and a row sorted last, never a wrong instant. Asserted so the
    // narrowing is a decision on the record rather than a surprise in a bug report.
    expect(parseInstant("2026-12-31T23:59:60Z").kind).toBe("malformed");
    expect(parseInstant("2026-09-01t12:00:00z").kind).toBe("malformed");
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
    // `10:00+02:00` is 08:00Z, so it precedes `09:00Z`. The control is the lexical
    // comparison the console used to make, which answers the opposite.
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
    // The negative control for the whole module: the same two lists ordered as TEXT.
    // Both put the offset stamp on the wrong side of `09:00Z`, and the descending
    // one puts the unreadable value first.
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
    // Days apart and milliseconds apart answer the same number: the only contract
    // `Array.prototype.sort` has is the sign, and returning a magnitude invites a
    // caller to read one.
    expect(compareInstants(parseInstant("2020-01-01T00:00:00Z"), later)).toBe(-1);
    expect(compareInstants(parseInstant("2026-09-01T11:59:59.999Z"), later)).toBe(-1);
  });
});
