// A dollar figure reads to four decimals at or below $0.50, so a spend of a fraction of a cent
// never reads as nothing spent; a finished duration reads in units, never as a raw millisecond
// figure for a span of minutes; and a clock figure carries its day in front unless it is today,
// counted on the machine's own calendar.

import { describe, expect, it } from "vitest";

import { dayClockChangesAt, formatDayClock, formatMoney, formatUnitDuration } from "./figures.js";

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
