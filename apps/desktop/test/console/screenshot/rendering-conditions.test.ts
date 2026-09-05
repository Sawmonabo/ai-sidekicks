// The conditions a reference image was minted under, asserted before one is compared.
//
// A screenshot tier's references are only a gate while the next run renders under the
// same conditions, and `vitest/screenshot-pins.ts` states those conditions in one
// place. Stating them is not the same as enforcing them: a pin the provider silently
// stopped applying — a renamed context option, a provider upgrade, a project that
// forgot to pass the options — would leave every capture in this tier rendering under
// the host's own settings, and the failure that produces is a diff of a few glyphs
// that reads exactly like a real regression.
//
// WHAT WENT WRONG WITHOUT IT. `Intl.DateTimeFormat` with no `timeZone` resolves the
// host's, and `primitives/wire-figures.ts` supplies none — so a surface carrying a
// formatted time captured the machine's offset rather than the console's state, and
// two references of the same surface differed by the hour digits alone. That is not a
// flake: it is a reference that records where it was minted.
//
// SO THE ASSERTION DRIVES THE REAL FORMATTER rather than reading the emulated zone
// back off `resolvedOptions()`. Reading it back would prove the option was applied;
// formatting a fixed instant through the console's own function proves the thing the
// references actually depend on, which is what a surface renders. The two would agree
// today and separate the day a formatter takes a zone of its own.

import { describe, expect, it } from "vitest";

import { formatClockTime } from "../../../src/renderer/src/console/primitives/wire-figures.js";

/** An instant with a distinct hour in every zone this could plausibly run in. */
const FIXED_INSTANT = "2026-09-05T23:41:07.000Z";

describe("screenshot tier — the rendering conditions its references were minted under", () => {
  it("renders a formatted time in the pinned zone", () => {
    // 23:41:07 in UTC, and a different hour in every offset but zero — which is the
    // property that makes this a control rather than a restatement: a host on any
    // other zone fails here, with a sentence naming the zone, instead of minting a
    // reference whose only difference from its sibling is two digits.
    expect(formatClockTime(FIXED_INSTANT)).toBe("23:41:07");
  });

  it("resolves the pinned zone and locale in the page itself", () => {
    // The other half, one layer down: the formatter above could pass on a host whose
    // offset happens to be zero for another reason. These read what the browser
    // context was given, so a pin that stopped being applied is named as such.
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("UTC");
    expect(new Date(FIXED_INSTANT).getTimezoneOffset()).toBe(0);
    expect(Intl.DateTimeFormat().resolvedOptions().locale).toBe("en-US");
  });

  it("negative control: the formatter reads the zone rather than the string", () => {
    // Without this the first claim would pass on a formatter that echoed its input.
    // A second instant twelve hours away renders a different hour, which it could
    // not do if the zone were not being applied to an epoch.
    expect(formatClockTime("2026-09-05T11:41:07.000Z")).toBe("11:41:07");
    expect(formatClockTime(FIXED_INSTANT)).not.toBe(formatClockTime("2026-09-05T11:41:07.000Z"));
  });
});
