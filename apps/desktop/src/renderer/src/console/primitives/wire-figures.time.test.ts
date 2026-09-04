// The four time readings: the unit changes rather than the number growing.
//
// `Spec-023 §Console Design (Meridian)` §The eight rules puts every quantity through
// `Intl`, and these four are where that rule has a second half — WHICH unit the
// figure is read in is itself a decision, and each of them makes it differently:
// `formatDuration` switches at fixed boundaries and pads the borrowed fields once it
// is digital, `formatRelativeTime` picks by magnitude and lets the platform compose
// the words, `formatClockTime` fixes its fields and drops the date entirely because
// the day divider carries it, and `formatDateTime` keeps the date for a surface that
// has no divider to carry it. So the interesting cases are the boundaries, and each
// one is asserted a millisecond either side of itself.
//
// `formatClockTime` is asserted by SHAPE rather than by literal, deliberately.
// `Intl.DateTimeFormat` with no `timeZone` renders in the runner's zone, so a
// literal expectation would pin the test to whoever ran it first and fail in CI for
// a reason that has nothing to do with the console. `formatDateTime` is read the same
// way, for the same reason.

import { describe, expect, it } from "vitest";

import {
  formatClockTime,
  formatDateTime,
  formatDuration,
  formatRelativeTime,
  wireInstantRank,
} from "./wire-figures.js";

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

describe("formatDateTime — the reading for a surface with no day divider", () => {
  // Two instants three days apart at the same wall-clock time, in January so no
  // zone this runner might be in shifts between them. The pair is the point: the
  // defect this formatter exists for is two figures that read identically.
  const firstInstant = "2026-01-05T13:04:05Z";
  const threeDaysLater = "2026-01-08T13:04:05Z";

  it("distinguishes two instants that differ only in the day", () => {
    expect(formatDateTime(threeDaysLater, "en-US")).not.toBe(formatDateTime(firstInstant, "en-US"));
  });

  it("negative control: the date-free clock reading renders both the same", () => {
    // This is the whole finding. Without it the assertion above would pass over a
    // formatter that differed for some other reason, and it would not say why the
    // ledger's own formatter cannot serve this surface.
    expect(formatClockTime(threeDaysLater, "en-US")).toBe(formatClockTime(firstInstant, "en-US"));
  });

  it("carries a calendar date and a wall-clock time, in a pinned locale", () => {
    // Pinned so the assertion is about the fields rather than the runner's
    // preferences; the zone is still the runner's, so the day is read out of the
    // rendered string rather than asserted as a literal.
    const rendered = formatDateTime(firstInstant, "en-US");
    expect(rendered).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{2}:\d{2}$/u);
  });

  it("is 24-hour, like the clock reading it sits beside", () => {
    expect(formatDateTime(firstInstant, "en-US")).not.toMatch(/AM|PM/u);
  });

  it("renders the same dash as its neighbours for an instant it cannot parse", () => {
    expect(formatDateTime("not an instant", "en-US")).toBe("—");
    expect(formatDateTime("", "en-US")).toBe("—");
  });
});

describe("wireInstantRank — one instant has many spellings", () => {
  it("ranks by the instant and not by the string", () => {
    // The whole reason this reading is shared. `10:00+02:00` is an hour EARLIER than
    // `09:00Z` and sorts AFTER it in every lexical comparison, so a surface ordering
    // rows by their stamps as text names the older row as newest.
    const earlier = "2026-09-01T10:00:00.000+02:00";
    const later = "2026-09-01T09:00:00.000Z";
    expect(wireInstantRank(earlier)).toBeLessThan(wireInstantRank(later));
    expect(earlier > later).toBe(true);
  });

  it("gives two spellings of one instant one rank", () => {
    expect(wireInstantRank("2026-09-01T11:00:00.000+02:00")).toBe(
      wireInstantRank("2026-09-01T09:00:00.000Z"),
    );
  });

  it("ranks an absent and an unreadable stamp below every readable one, and equally", () => {
    // Equally, and not as `NaN`: a comparison against `NaN` is false in both
    // directions, so an unreadable stamp would take a different place at each end
    // of a fold. `-Infinity` gives it one place.
    expect(wireInstantRank(undefined)).toBe(Number.NEGATIVE_INFINITY);
    expect(wireInstantRank("not an instant")).toBe(Number.NEGATIVE_INFINITY);
    expect(wireInstantRank("")).toBe(Number.NEGATIVE_INFINITY);
    expect(wireInstantRank("2026-09-01T09:00:00.000Z")).toBeGreaterThan(
      wireInstantRank("not an instant"),
    );
  });

  it("negative control: two different instants do not share a rank", () => {
    // Without this, the cases above would pass over a reading that answered one
    // number for everything it was given.
    expect(wireInstantRank("2026-09-01T09:00:00.000Z")).not.toBe(
      wireInstantRank("2026-09-01T10:00:00.000Z"),
    );
  });
});
