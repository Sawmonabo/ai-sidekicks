// The three time readings: the unit changes rather than the number growing.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules puts every quantity through
// `Intl`, and these three are where that rule has a second half — WHICH unit the
// figure is read in is itself a decision, and each of them makes it differently:
// `formatDuration` switches at fixed boundaries and pads the borrowed fields once it
// is digital, `formatRelativeTime` picks by magnitude and lets the platform compose
// the words, and `formatClockTime` fixes its fields and drops the date entirely
// because the day divider carries it. So the interesting cases are the boundaries,
// and each one is asserted a millisecond either side of itself.
//
// `formatClockTime` is asserted by SHAPE rather than by literal, deliberately.
// `Intl.DateTimeFormat` with no `timeZone` renders in the runner's zone, so a
// literal expectation would pin the test to whoever ran it first and fail in CI for
// a reason that has nothing to do with the console.
//
// Both readers take their instant from `core/instant.ts`, so both refuse what that
// module refuses. The `Date.parse` leniency cases are asserted here as well as in
// that module's own test, because "the parser refuses it" and "the FIGURE refuses
// it" are two claims and only the second is what a person sees. The instants these
// tests need are built with `Date.UTC` rather than parsed, so the test never asks a
// second parser what the module under test is for.

import { describe, expect, it } from "vitest";

import { formatClockTime, formatDuration, formatRelativeTime } from "./wire-figures.js";

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

describe("formatRelativeTime — the platform composes the phrase", () => {
  const now = Date.UTC(2026, 8, 1, 12, 0, 0);

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

  it("reads a numeric offset as the instant it names", () => {
    // 10:00+02:00 is 08:00Z, four hours before `now`. Rendering the digits rather
    // than the instant would read "2 hours ago".
    expect(formatRelativeTime("2026-09-01T10:00:00+02:00", now, "en-US")).toBe("4 hours ago");
  });

  it("refuses the stamps Date.parse would have rendered a figure for", () => {
    // The negative control for the whole repoint: each of these produced a rendered
    // figure before, and the second assertion is why — `Date.parse` answers a number
    // for all three, normalizing a day that does not exist and reading a
    // timezone-less stamp in whatever zone the runner happens to be in.
    for (const text of ["2026-02-30T10:00:00Z", "2026-01-01T24:00:00Z", "2026-09-01T10:00:00"]) {
      expect(formatRelativeTime(text, now, "en-US")).toBe("—");
      expect(Number.isNaN(Date.parse(text))).toBe(false);
    }
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
      }).format(Date.UTC(2026, 8, 1, 13, 4, 5)),
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

  it("refuses a day that does not exist rather than rendering the day after it", () => {
    expect(formatClockTime("2026-02-30T10:00:00Z", "en-US")).toBe("—");
    expect(Number.isNaN(Date.parse("2026-02-30T10:00:00Z"))).toBe(false);
  });
});
