// Which quota reading this table shows, decided by the node's fold and by nothing here.
//
// `Spec-029 §Per-limit provider quota` states supersession as two rules in one order —
// "newest wins, by observation time — except that a same-window reading never moves
// backward" — and `bridge/quotas/provider-quota-fold.ts` is the console's one
// implementation of it. This page used to fold the rows AGAIN on the way to the table,
// with the exception missing: a later reading below the high-water mark replaced the
// higher one on its timestamp alone, so this table could show 20% for a window the
// canonical feed was holding at 90% and the composer's chip was still reporting.
//
// SO THE CASES BELOW DRIVE THE WHOLE PATH AND NOT A FUNCTION. The frames go down the
// node's real tail into the real fold, and what is asserted is the cell a person reads.
// That is the only way the claim can be made from here at all: the fold is a `bridge/`
// module and a settings suite reaches another family through its door, which publishes
// the readout rather than the fold — and it is the better test regardless, because the
// defect was a SECOND rule downstream of the first rather than a wrong rule inside it.

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProviderAccountUsageWindow } from "@ai-sidekicks/contracts";

import {
  bridgeHoldingTheTail,
  quotaRowText,
  registryAccountAt,
  renderSettledShell,
} from "./accounts-shell-mount.test-support.js";

afterEach(() => {
  cleanup();
});

/** The deck's weekly limit on its default account, at 88% and resetting on the 5th. */
const WEEKLY_LIMIT_ID = "weekly_all";
const WEEKLY_RESETS_AT = "2026-01-05T00:00:00.000Z";

/** A reading for that limit, on the account the shell opens with selected. */
function weeklyReading(overrides: Partial<ProviderAccountUsageWindow>): ProviderAccountUsageWindow {
  return {
    accountId: registryAccountAt(0).accountId,
    limitId: WEEKLY_LIMIT_ID,
    windowMins: 10080,
    label: "Weekly",
    usedPercent: 88,
    resetsAt: WEEKLY_RESETS_AT,
    observedAt: "2026-01-01T09:00:00.000Z",
    observedCredentialGeneration: 3,
    source: "run",
    ...overrides,
  };
}

describe("the quota table's supersession", () => {
  it("keeps the high-water figure when the tail sends a lower one for the same window", async () => {
    // The fold reports a below-high-water reading ONCE per reading's life, on the
    // console's diagnostic band — and the deck's own registry reply already spends that
    // line, since it ships a superseded row on purpose. So the spy is here to keep the
    // run's output honest and is asserted on nowhere: a count taken here would be
    // reporting the deck's drop under this case's name.
    const highWaterDrop = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const plane = bridgeHoldingTheTail();
    const container = await renderSettledShell(plane.bridge);
    expect(quotaRowText(container, WEEKLY_LIMIT_ID)).toContain("88%");

    act(() => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: registryAccountAt(0).accountId,
        window: weeklyReading({ usedPercent: 20, observedAt: "2026-01-01T10:00:00.000Z" }),
      });
    });

    expect(quotaRowText(container, WEEKLY_LIMIT_ID)).toContain("88%");
    expect(quotaRowText(container, WEEKLY_LIMIT_ID)).not.toContain("20%");
    highWaterDrop.mockRestore();
  });

  // THE NEGATIVE CONTROL. A lower figure under a MOVED reset horizon is a window that
  // has reset, which is the ordinary case and must render — otherwise the case above
  // would hold for a table that simply never took a second reading at all.
  it("takes the lower figure once the window itself has reset", async () => {
    const plane = bridgeHoldingTheTail();
    const container = await renderSettledShell(plane.bridge);

    act(() => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: registryAccountAt(0).accountId,
        window: weeklyReading({
          usedPercent: 20,
          resetsAt: "2026-01-12T00:00:00.000Z",
          observedAt: "2026-01-01T10:00:00.000Z",
        }),
      });
    });

    expect(quotaRowText(container, WEEKLY_LIMIT_ID)).toContain("20%");
  });

  // And the second negative control, for the ordering the guard sits in front of: a
  // HIGHER same-window reading is seated on its timestamp like any other, so the guard
  // is a floor on consumption rather than a freeze on the row.
  it("takes a higher figure inside the same window", async () => {
    const plane = bridgeHoldingTheTail();
    const container = await renderSettledShell(plane.bridge);

    act(() => {
      plane.deliver({
        kind: "usage_window_updated",
        accountId: registryAccountAt(0).accountId,
        window: weeklyReading({ usedPercent: 94, observedAt: "2026-01-01T10:00:00.000Z" }),
      });
    });

    expect(quotaRowText(container, WEEKLY_LIMIT_ID)).toContain("94%");
  });
});
