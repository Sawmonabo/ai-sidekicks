// The quota fold, driven directly rather than through a bridge. Consumption does not fall inside
// one window, so a lower same-window reading is held rather than hiding imminent exhaustion; a
// moved reset horizon is a new window; a reading is keyed by account, limit and length together;
// and an account is listed only while its provider names it.

import { describe, expect, it } from "vitest";
import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { ProviderId } from "@ai-sidekicks/contracts/provider/id";

import { providerSectionOf } from "#renderer/store/providers/name.js";
import { providerSectionsFixture } from "#renderer/store/providers/sections.test-support.js";
import { ProviderAccountFold } from "./fold.js";

const ACCOUNT_ID = "acct-team" as ProviderAccountId;
const CLAUDE = "claude" as ProviderId;
const EARLIER = "2026-01-01T11:00:00.000Z";
const LATER = "2026-01-01T12:00:00.000Z";
const WINDOW_RESET = "2026-01-08T00:00:00.000Z";
const NEXT_WINDOW_RESET = "2026-01-15T00:00:00.000Z";

/**
 * One registry row. A cast, because overrides may move it to the other health arm, which a spread
 * over the union cannot narrow to.
 */
function account(overrides: Partial<ProviderAccount> = {}): ProviderAccount {
  return {
    accountId: ACCOUNT_ID,
    provider: CLAUDE,
    observedAccountEmail: "sam@example.com",
    observedAccountPlan: "team",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: EARLIER,
    observedAuthMode: "oauthSubscription",
    signedInAt: null,
    signInNeededAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  } as ProviderAccount;
}

/** Record `listed` in `fold` under its provider's fixture section. */
function putAccount(fold: ProviderAccountFold, listed: ProviderAccount): void {
  fold.putAccount(listed, providerSectionOf(providerSectionsFixture(), listed.provider));
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
function usedPercentFor(fold: ProviderAccountFold, limitId: string, windowMins = 10_080): number {
  const readings = fold.readings();
  const found = readings.find(
    (reading) => reading.limitId === limitId && reading.windowMins === windowMins,
  );
  if (found === undefined) {
    throw new Error(
      `no reading for "${limitId}" over ${String(windowMins)} minutes; the fold holds ` +
        JSON.stringify(readings.map((reading) => [reading.limitId, reading.windowMins])),
    );
  }
  return found.usedPercent;
}

describe("ProviderAccountFold — the readings a view renders", () => {
  it("keeps the high-water figure when the wire sends a lower one for the same window", () => {
    const fold = new ProviderAccountFold();
    putAccount(fold, account());
    fold.mergeUsageWindow(usageWindow({ usedPercent: 90, observedAt: EARLIER }));

    expect(fold.mergeUsageWindow(usageWindow({ usedPercent: 20, observedAt: LATER }))).toBe(
      "dropped-below-high-water",
    );
    expect(usedPercentFor(fold, "weekly-all")).toBe(90);
  });

  it("takes the lower figure once the window has reset", () => {
    const fold = new ProviderAccountFold();
    putAccount(fold, account());
    fold.mergeUsageWindow(usageWindow({ usedPercent: 90, observedAt: EARLIER }));

    expect(
      fold.mergeUsageWindow(
        usageWindow({ usedPercent: 20, observedAt: LATER, resetsAt: NEXT_WINDOW_RESET }),
      ),
    ).toBe("stored");
    expect(usedPercentFor(fold, "weekly-all")).toBe(20);
  });

  it("keeps two limits of one length apart under their limit ids", () => {
    // Two limits sharing a window length, so the length alone cannot be the key.
    const fold = new ProviderAccountFold();
    putAccount(fold, account());
    fold.mergeUsageWindow(usageWindow({ usedPercent: 90 }));
    fold.mergeUsageWindow(
      usageWindow({ limitId: "weekly-opus", label: "Weekly, Opus", usedPercent: 30 }),
    );

    expect(usedPercentFor(fold, "weekly-all")).toBe(90);
    expect(usedPercentFor(fold, "weekly-opus")).toBe(30);
  });

  it("keeps both windows a provider files under one limit id", () => {
    // One limit with a five-hour and a weekly window, so the limit id alone cannot be the key.
    const fold = new ProviderAccountFold();
    putAccount(fold, account({ provider: "codex" as ProviderId }));
    fold.mergeUsageWindow(usageWindow({ limitId: "codex", windowMins: 300, usedPercent: 67 }));
    fold.mergeUsageWindow(usageWindow({ limitId: "codex", windowMins: 10_080, usedPercent: 12 }));

    expect(usedPercentFor(fold, "codex", 300)).toBe(67);
    expect(usedPercentFor(fold, "codex", 10_080)).toBe(12);
  });
});

describe("ProviderAccountFold — the accounts a view lists", () => {
  it("lists an account only while its provider has named it", () => {
    // Before its provider reports an identity the account has no name, so it has no row.
    const fold = new ProviderAccountFold();
    const signingIn = account();
    delete signingIn.observedAccountEmail;
    delete signingIn.observedAccountPlan;
    putAccount(fold, signingIn);
    fold.mergeUsageWindow(usageWindow());
    expect(fold.accounts()).toEqual([]);
    expect(fold.accountLabels().size).toBe(0);
    expect(fold.readings()).toEqual([]);

    putAccount(fold, account());
    expect(fold.accounts().map((listed) => listed.label)).toEqual(["sam@example.com · Team"]);

    // Put again without its name, the account leaves the list instead of keeping its old row.
    putAccount(fold, signingIn);
    expect(fold.accounts()).toEqual([]);
  });
});
