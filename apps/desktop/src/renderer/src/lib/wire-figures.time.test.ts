// The time readings choose which unit a figure is read in: `formatDuration` switches at fixed
// boundaries, `formatRelativeTime` by magnitude, `formatClockTime` drops the date, and
// `formatDayDuration` asks `Intl` for the word. The cases are the boundaries, asserted either side.
//
// `formatClockTime` is asserted by shape, since `Intl.DateTimeFormat` without a `timeZone` renders
// in the runner's zone. The readers take their instant from `instant.ts` and refuse what it
// refuses; the `Date.parse` leniency cases are repeated here because the figure refusing is what a
// person sees. Instants are built with `Date.UTC` so no second parser is involved.

import { describe, expect, it } from "vitest";

import {
  formatClockTime,
  formatDayDuration,
  formatDuration,
  formatRelativeTime,
} from "./wire-figures.js";

describe("formatDuration — the unit changes rather than the number growing", () => {
  it("keeps sub-second durations in milliseconds", () => {
    // "340 ms", not "0.3 s".
    expect(formatDuration(340, "en-US")).toBe("340 ms");
    expect(formatDuration(999, "en-US")).toBe("999 ms");
    expect(formatDuration(0, "en-US")).toBe("0 ms");
  });

  it("changes unit at each boundary rather than letting the number run", () => {
    expect(formatDuration(1000, "en-US")).toBe("1 s");
    expect(formatDuration(1500, "en-US")).toBe("1.5 s");
    expect(formatDuration(59_000, "en-US")).toBe("59 s");
  });

  // The digital reading starts at one minute; one millisecond below, the shape is still seconds.
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
    // 119.6 s has not become the next minute.
    expect(formatDuration(119_600, "en-US")).toBe("1:59");
    // Negative control: rounding would read "2:00".
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
    // `numeric: "auto"` turns the day boundary into a word; the hour on the other side is still
    // counted.
    expect(formatRelativeTime("2026-08-31T12:00:00Z", now, "en-US")).toBe("yesterday");
  });

  it("renders a dash for an instant it cannot parse", () => {
    expect(formatRelativeTime("not an instant", now, "en-US")).toBe("—");
    expect(formatRelativeTime("", now, "en-US")).toBe("—");
  });

  it("reads a numeric offset as the instant it names", () => {
    // 10:00+02:00 is 08:00Z, four hours before `now`; reading the digits would give "2 hours ago".
    expect(formatRelativeTime("2026-09-01T10:00:00+02:00", now, "en-US")).toBe("4 hours ago");
  });

  it("refuses the stamps Date.parse would have rendered a figure for", () => {
    // Negative control: `Date.parse` answers a number for all three, normalizing a day that does
    // not exist and reading a zone-less stamp in the runner's zone.
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
    // Control: en-US with the same fields and no `hour12: false` does carry a day period, so the
    // assertion above tests the option, not the locale.
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
    // A stubbed formatter passes neither: one second apart differs, and so does the seconds field.
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

describe("formatDayDuration — the locale decides the word, never the call site", () => {
  it("declines the plural at one day and takes it at three", () => {
    // `${formatCount(days)} days` would render the ungrammatical `1 days`; `Intl` knows the
    // locale's plural rule.
    expect(formatDayDuration(1, "en-US")).toBe("1 day");
    expect(formatDayDuration(3, "en-US")).toBe("3 days");
    // Control: concatenation would answer `1 days`, which no locale-aware formatter can.
    expect(formatDayDuration(1, "en-US")).not.toBe("1 days");
  });

  it("names the unit in the locale's own words rather than in English", () => {
    // A literal `days` would be English in every locale. Asserted against the platform's own
    // composition, not a hand-written German string, so the case pins the route through `Intl`.
    expect(formatDayDuration(3, "de-DE")).toBe(
      new Intl.NumberFormat("de-DE", {
        style: "unit",
        unit: "day",
        unitDisplay: "long",
        maximumFractionDigits: 0,
      }).format(3),
    );
    expect(formatDayDuration(3, "de-DE")).not.toBe("3 days");
    expect(formatDayDuration(3, "de-DE")).not.toBe(formatDayDuration(3, "en-US"));
  });

  it("groups a large day count the way every other console figure does", () => {
    expect(formatDayDuration(1000, "en-US")).toBe("1,000 days");
  });

  it("renders whole days, because that is what the wire states", () => {
    // A fraction would be arithmetic on a wire figure, so the reading is whole and `Intl` rounds.
    expect(formatDayDuration(7.4, "en-US")).toBe("7 days");
  });

  it("renders a dash rather than a figure it cannot stand behind", () => {
    for (const notADayCount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatDayDuration(notADayCount, "en-US")).toBe("—");
    }
  });
});
