// A cost names the account that paid by its label, and never by its id: a payer the read registry
// no longer carries reads as a removed account, and before the read, or while the registry carries
// the payer with no name yet, the cost stands alone.

import type {
  ProviderAccount,
  ProviderAccountId,
} from "@ai-sidekicks/contracts/provider/account/record";
import type { WorkflowCost } from "@ai-sidekicks/contracts/workflow/run/step/record";
import { describe, expect, it } from "vitest";

import { joinFigureSentence } from "#renderer/lib/figure-sentence.js";
import { costWithPayer, readPayer } from "./cost.js";

const COST: WorkflowCost = {
  usdMicros: 7_300_000,
  providerAccountId: "pa-0001" as ProviderAccountId,
};

const PAYER: ProviderAccount = {
  accountId: COST.providerAccountId,
  provider: "claude",
  credentialGeneration: 1,
  billingMode: "subscription",
  isDefault: true,
  healthState: "authenticated",
  healthObservedAt: "2026-01-01T07:00:00.000Z",
  observedAuthMode: "oauth_subscription",
  observedAccountEmail: "sam@example.com",
  observedAccountPlan: "max",
  loggedInAt: null,
  lastRefreshObservedAt: null,
  expectedReloginAtEstimate: null,
  probeEnabled: true,
  windowStartEnabled: true,
  wakeForWindowStartEnabled: false,
  memoryImport: null,
};

function costRead(accounts: readonly ProviderAccount[] | undefined): string {
  return joinFigureSentence(
    costWithPayer(COST, (providerAccountId) => readPayer(accounts, providerAccountId)),
  );
}

describe("costWithPayer over the registry as read", () => {
  it("names a carried payer by its label, a removed one in words, and never by its id", () => {
    expect(costRead([PAYER])).toBe("$7.30 · sam@example.com · Max");
    // The registry was read and no longer carries the account.
    expect(costRead([])).toBe("$7.30 · Removed account");
    // Before the registry is read nothing is known about the payer, so the cost stands alone.
    expect(costRead(undefined)).toBe("$7.30");
    // Carried, but put again before its provider named it: not removed, and no name to draw.
    const unnamed = { ...PAYER, observedAccountEmail: undefined, observedAccountPlan: undefined };
    expect(costRead([unnamed])).toBe("$7.30");
  });
});
