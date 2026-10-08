// A dollar figure reads to four decimals at or below $0.50, so a spend of a fraction of a cent
// never reads as nothing spent; a finished duration reads in units, never as a raw millisecond
// figure for a span of minutes; and a clock figure carries its day in front unless it is today,
// counted on the machine's own calendar. A compact count is shortened by the platform's own
// notation, and its widest form is what the platform prints at a rounding edge. A time's hover
// title is the time on the machine's own calendar and clock, with its zone. A row's age reads one
// count in one unit, and its view wakes exactly when that reading changes.

import { describe, expect, it } from "vitest";

import {
  ageChangesAt,
  dayClockChangesAt,
  formatAge,
  formatCompactCount,
  formatDayClock,
  formatMoney,
  formatUnitDuration,
  formatZonedDateTime,
  widestCompactCount,
} from "./figures.js";

describe("formatMoney", () => {
  it("reads four decimals at or below $0.50 and two above, and nothing spent as $0.00", () => {
    expect(formatMoney(0.0018)).toBe("$0.0018");
    expect(formatMoney(0.0213)).toBe("$0.0213");
    expect(formatMoney(0.5)).toBe("$0.5000");
    expect(formatMoney(0.51)).toBe("$0.51");
    expect(formatMoney(11.6)).toBe("$11.60");
    expect(formatMoney(1204.5)).toBe("$1,204.50");
    expect(formatMoney(0)).toBe("$0.00");
  });
});

describe("formatCompactCount", () => {
  it("shortens a count in compact notation, and its widest form is the platform's own", () => {
    expect(formatCompactCount(9, "en-US")).toBe("9");
    expect(formatCompactCount(1_250, "en-US")).toBe("1.3K");
    expect(formatCompactCount(3_400_000, "en-US")).toBe("3.4M");
    expect(formatCompactCount(123_456_789_012, "en-US")).toBe("123B");
    expect(widestCompactCount("en-US")).toBe("1000T");
  });
});

describe("formatUnitDuration", () => {
  it("reads milliseconds only under a second, then seconds, minutes and hours", () => {
    expect(formatUnitDuration(4)).toBe("4 ms");
    expect(formatUnitDuration(38_900)).toBe("38 s");
    expect(formatUnitDuration(401_000)).toBe("6 m 41 s");
    expect(formatUnitDuration(7_509_000)).toBe("2 h 5 m 9 s");
  });
});

describe("formatDayClock", () => {
  // Built on this machine's own calendar, so the case reads the same in every zone.
  const now = new Date(2026, 8, 30, 14, 20).getTime();
  const at = (month: number, day: number, hour: number, minute: number, year = 2026): string => {
    const instant = new Date(0);
    instant.setFullYear(year, month, day);
    instant.setHours(hour, minute, 0, 0);
    return instant.toISOString();
  };

  it("puts the day in front unless it is today, by weekday within the week, then by date", () => {
    expect(formatDayClock(at(8, 30, 8, 30), now, "en-US")).toBe("8:30 AM");
    expect(formatDayClock(at(8, 29, 19, 48), now, "en-US")).toBe("Yesterday 7:48 PM");
    expect(formatDayClock(at(9, 1, 2, 0), now, "en-US")).toBe("Tomorrow 2:00 AM");
    expect(formatDayClock(at(8, 28, 9, 58), now, "en-US")).toBe("Mon 9:58 AM");
    expect(formatDayClock(at(8, 23, 9, 58), now, "en-US")).toBe("Sep 23, 9:58 AM");
    expect(formatDayClock(at(11, 31, 23, 5, 2025), now, "en-US")).toBe("Dec 31, 2025, 11:05 PM");
  });

  it("changes its day words at the machine's next midnight", () => {
    const midnight = new Date(2026, 9, 1).getTime();
    expect(dayClockChangesAt(now)).toBe(midnight);
    expect(formatDayClock(at(8, 30, 8, 30), midnight, "en-US")).toBe("Yesterday 8:30 AM");
  });
});

describe("formatZonedDateTime", () => {
  it("writes the instant on the machine's own calendar and clock and names the zone", () => {
    // Built on this machine's own calendar, so the case reads the same in every zone.
    const instant = new Date(2026, 9, 7, 19, 28).toISOString();
    expect(formatZonedDateTime(instant, "en-US")).toMatch(/^Oct 7, 2026, 7:28 PM \S+$/u);
  });
});

describe("formatAge", () => {
  const FROM = "2026-10-01T12:00:00.000Z";
  const FROM_MILLISECONDS = Date.UTC(2026, 9, 1, 12);
  const MINUTE = 60_000;
  const DAY = 24 * 60 * MINUTE;

  it("reads now under a minute, then one whole count in one unit with no ago", () => {
    const ages = [
      [-5 * MINUTE, "now"],
      [59_999, "now"],
      [MINUTE, "1m"],
      [59 * MINUTE, "59m"],
      [60 * MINUTE, "1h"],
      [DAY - 1, "23h"],
      [DAY, "1d"],
      [7 * DAY, "1w"],
      [29 * DAY, "4w"],
      [30 * DAY, "1mo"],
      [364 * DAY, "12mo"],
      [365 * DAY, "1y"],
      [3 * 365 * DAY, "3y"],
    ] as const;
    expect(ages.map(([gap]) => formatAge(FROM, FROM_MILLISECONDS + gap))).toStrictEqual(
      ages.map(([, reading]) => reading),
    );
  });

  it("wakes exactly when the age would next read differently", () => {
    for (const gap of [0, 30 * MINUTE + 1, 23 * 60 * MINUTE, 6 * DAY, 28 * DAY, 200 * DAY]) {
      const now = FROM_MILLISECONDS + gap;
      const changesAt = ageChangesAt(FROM, now);
      expect(formatAge(FROM, changesAt - 1)).toBe(formatAge(FROM, now));
      expect(formatAge(FROM, changesAt)).not.toBe(formatAge(FROM, now));
    }
  });
});
