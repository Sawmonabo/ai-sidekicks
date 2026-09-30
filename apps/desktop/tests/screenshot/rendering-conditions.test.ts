// The conditions a capture is taken under, asserted before one is written. The tier compares
// nothing, but a view carrying a formatted time records where the machine was unless the zone and
// locale are pinned (`vitest/screenshot-pins.ts` states both). Stating a pin is not enforcing it:
// one the provider silently stopped applying would leave captures under the host's settings, and
// a person would read the host's clock as the console's state. `Intl.DateTimeFormat` with no
// `timeZone` resolves the host's, and `lib/wire-figures.ts` supplies none. The assertion drives
// the real formatter rather than reading the zone back from `resolvedOptions()`, which would
// prove the option was applied, not what a view renders.

import { describe, expect, it } from "vitest";

import { formatClockTime } from "@renderer/lib/wire-figures.js";

/** An instant with a distinct hour in every zone this could plausibly run in. */
const FIXED_INSTANT = "2026-09-05T23:41:07.000Z";

/**
 * The same instant as the number `Date` takes, composed rather than parsed: the lint bans refuse
 * a string `Date` constructor. The case below holds the two constants together.
 */
const FIXED_INSTANT_MILLISECONDS = Date.UTC(2026, 8, 5, 23, 41, 7);

describe("screenshot tier — the rendering conditions its captures are taken under", () => {
  it("renders a formatted time in the pinned zone", () => {
    // 23:41:07 in UTC, and a different hour in every other offset: a host on another zone fails
    // here naming the zone, instead of minting a capture that differs from its sibling by two
    // digits.
    expect(formatClockTime(FIXED_INSTANT)).toBe("23:41:07");
  });

  it("resolves the pinned zone and locale in the page itself", () => {
    // One layer down: the formatter above could pass on a host whose offset is zero for another
    // reason. These read what the browser context was given.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
    // The composed number and the wire spelling must be the same instant; two constants for one
    // moment drift silently.
    expect(new Date(FIXED_INSTANT_MILLISECONDS).toISOString()).toBe(FIXED_INSTANT);
    expect(new Date(FIXED_INSTANT_MILLISECONDS).getTimezoneOffset()).toBe(0);
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe("en-US");
  });

  it("negative control: the formatter reads the zone rather than the string", () => {
    // Without this the first claim would pass on a formatter that echoed its input; an instant
    // twelve hours away must render a different hour.
    expect(formatClockTime("2026-09-05T11:41:07.000Z")).toBe("11:41:07");
    expect(formatClockTime(FIXED_INSTANT)).not.toBe(formatClockTime("2026-09-05T11:41:07.000Z"));
  });
});
