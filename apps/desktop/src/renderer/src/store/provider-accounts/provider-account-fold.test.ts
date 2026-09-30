// The quota fold, driven directly rather than through a bridge. Consumption does not fall inside
// one window, so a lower same-window reading is held rather than hiding imminent exhaustion; a
// moved reset horizon is a new window; and a reading is keyed by account and limit, not length.

import { describe, expect, it } from "vitest";
import {
  ProviderAccountIdSchema,
  type ProviderAccount,
  type ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import { ProviderAccountFold } from "./provider-account-fold.js";

// Minted through the registered schema rather than cast, so a case cannot file a reading under
// an id the wire would refuse.
const ACCOUNT_ID = ProviderAccountIdSchema.parse("acct-team");
const EARLIER = "2026-01-01T11:00:00.000Z";
const LATER = "2026-01-01T12:00:00.000Z";
const WINDOW_RESET = "2026-01-08T00:00:00.000Z";
const NEXT_WINDOW_RESET = "2026-01-15T00:00:00.000Z";

function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: EARLIER,
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  };
}

function usageWindow(
  overrides: Partial<ProviderAccountUsageWindow> = {},
): ProviderAccountUsageWindow {
  return {
    accountId: ACCOUNT_ID,
    limitId: "weekly-all",
    windowMins: 10_080,
    label: "Weekly, all models",
    usedPercent: 90,
    resetsAt: WINDOW_RESET,
    observedAt: EARLIER,
    observedCredentialGeneration: 1,
    source: "probe",
    ...overrides,
  };
}

/** One key's reading, or a thrown failure naming what the fold holds instead. */
function usedPercentFor(fold: ProviderAccountFold, limitId: string): number {
  const readings = fold.readings();
  const found = readings.find((reading) => reading.limitId === limitId);
  if (found === undefined) {
    throw new Error(
      `no reading for "${limitId}"; the fold holds ${JSON.stringify(readings.map((reading) => reading.limitId))}`,
    );
  }
  return found.usedPercent;
}

describe("ProviderAccountFold — the readings a view renders", () => {
  it("keeps the high-water figure when the wire sends a lower one for the same window", () => {
    const fold = new ProviderAccountFold();
    fold.putAccount(account());
    fold.mergeUsageWindow(usageWindow({ usedPercent: 90, observedAt: EARLIER }));

    expect(fold.mergeUsageWindow(usageWindow({ usedPercent: 20, observedAt: LATER }))).toBe(
      "dropped-below-high-water",
    );
    expect(usedPercentFor(fold, "weekly-all")).toBe(90);
  });

  it("takes the lower figure once the window has reset", () => {
    const fold = new ProviderAccountFold();
    fold.putAccount(account());
    fold.mergeUsageWindow(usageWindow({ usedPercent: 90, observedAt: EARLIER }));

    expect(
      fold.mergeUsageWindow(
        usageWindow({ usedPercent: 20, observedAt: LATER, resetsAt: NEXT_WINDOW_RESET }),
      ),
    ).toBe("stored");
    expect(usedPercentFor(fold, "weekly-all")).toBe(20);
  });

  it("keeps two windows of one length apart under their limit ids", () => {
    // The pair key, and the whole reason the readings are not keyed by duration.
    const fold = new ProviderAccountFold();
    fold.putAccount(account());
    fold.mergeUsageWindow(usageWindow({ usedPercent: 90 }));
    fold.mergeUsageWindow(
      usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus", usedPercent: 30 }),
    );

    expect(usedPercentFor(fold, "weekly-all")).toBe(90);
    expect(usedPercentFor(fold, "weekly-opus")).toBe(30);
  });
});
