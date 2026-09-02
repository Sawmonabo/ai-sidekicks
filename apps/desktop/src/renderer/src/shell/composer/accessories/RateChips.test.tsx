// The band rule, which decides both whether a chip exists and what colour it is.
//
// One function answers both questions, so one test drives both: a reading in the
// healthy band earns no element at all, and the two bands that do render earn the
// two tones and no third. A chip that appeared in the healthy band would be the
// composer shouting about a quota nobody needs to think about; a chip that stayed
// amber below 20% would be the console under-reporting the one it does.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RATE_CHIP_TONES, RateChips, rateChipToneFor } from "./RateChips.js";
import type { FoldedRateLimitReading } from "./usage-readings.js";

const NOW_MILLISECONDS = Date.parse("2026-01-01T00:00:00.000Z");

function reading(overrides: Partial<FoldedRateLimitReading> = {}): FoldedRateLimitReading {
  return {
    providerAccountId: "account-one",
    limitId: "weekly",
    accountLabel: "Team",
    limitLabel: "weekly",
    usedPercent: 90,
    resetsAt: undefined,
    observedAt: "2026-01-01T00:00:00.000Z",
    credentialGeneration: undefined,
    sequence: 1,
    isStale: false,
    ...overrides,
  };
}

describe("rateChipToneFor — the healthy band is the hidden band", () => {
  it("earns no tone at exactly half remaining", () => {
    expect(rateChipToneFor(reading({ usedPercent: 50 }))).toBeUndefined();
  });

  it("earns caution between the two thresholds", () => {
    expect(rateChipToneFor(reading({ usedPercent: 51 }))).toBe("caution");
    expect(rateChipToneFor(reading({ usedPercent: 80 }))).toBe("caution");
  });

  it("earns urgent below a fifth remaining", () => {
    expect(rateChipToneFor(reading({ usedPercent: 81 }))).toBe("urgent");
  });

  it("negative control: the tone set is closed at the two that render", () => {
    // A third tone added here without a band to earn it would leave this list
    // longer than the set of answers the function can give.
    const answered = new Set(
      [0, 25, 50, 51, 79, 80, 81, 100]
        .map((usedPercent) => rateChipToneFor(reading({ usedPercent })))
        .filter((tone) => tone !== undefined),
    );
    expect([...answered].sort()).toStrictEqual([...RATE_CHIP_TONES].sort());
  });
});

describe("RateChips — what reaches the screen", () => {
  it("renders nothing when every quota is healthy", () => {
    const { container } = render(
      <RateChips readings={[reading({ usedPercent: 10 })]} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    // Nothing at all, not an empty list: the absence of a chip is never a health
    // reading, and an empty container is the only render that claims nothing.
    expect(container.querySelector(".meridian-rate-chips")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("drops the healthy reading and keeps the order it was given", () => {
    // Order is the FOLD's — `foldRateLimitReadings` sorts by account then limit, and
    // this component renders what it is handed. Asserting a re-sort here would be
    // asserting a second ordering rule, which is exactly what must not exist: a chip
    // that moved when its own number moved is a chip a person has to re-find.
    const { container } = render(
      <RateChips
        readings={[
          reading({ limitId: "a", limitLabel: "hourly", accountLabel: "Ada", usedPercent: 60 }),
          reading({ limitId: "c", limitLabel: "daily", accountLabel: "Ada", usedPercent: 5 }),
          reading({ limitId: "b", limitLabel: "weekly", accountLabel: "Zed", usedPercent: 95 }),
        ]}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const tones = [...container.querySelectorAll(".meridian-rate-chip")].map((chip) =>
      chip.getAttribute("data-tone"),
    );
    expect(tones).toStrictEqual(["caution", "urgent"]);
  });

  it("shows a countdown only where the wire carried a reset instant", () => {
    const { container } = render(
      <RateChips
        readings={[
          reading({ limitId: "a", limitLabel: "a", usedPercent: 90 }),
          reading({
            limitId: "b",
            limitLabel: "b",
            usedPercent: 90,
            resetsAt: "2026-01-01T02:00:00.000Z",
          }),
        ]}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    const derived = container.querySelectorAll(".meridian-figure--derived");
    expect(derived).toHaveLength(1);
    expect(derived[0]?.textContent).toContain("resets");
  });

  it("marks a stale reading and leaves a fresh one unmarked", () => {
    const { container } = render(
      <RateChips
        readings={[reading({ usedPercent: 90, isStale: true })]}
        nowMilliseconds={NOW_MILLISECONDS}
      />,
    );
    expect(container.querySelector('.meridian-rate-chip svg[role="img"]')).not.toBeNull();

    const fresh = render(
      <RateChips readings={[reading({ usedPercent: 90 })]} nowMilliseconds={NOW_MILLISECONDS} />,
    );
    expect(fresh.container.querySelector('.meridian-rate-chip svg[role="img"]')).toBeNull();
  });
});
