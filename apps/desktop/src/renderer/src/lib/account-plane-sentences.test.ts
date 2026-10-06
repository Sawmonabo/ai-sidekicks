// What every surface names an account by: the identity its provider reported, the plan in the
// provider's own word, or for a pasted token or API key the name the person gave it beside the
// credential's kind. One email can hold two accounts, so the plan and organization are part of it.
// An account still signing in that nothing names yet is listed nowhere.

import type {
  ProviderAccount,
  ProviderAccountId,
} from "@ai-sidekicks/contracts/provider/account/record";
import { describe, expect, it } from "vitest";

import { listedAccount } from "./account-plane-sentences.js";

function account(overrides: Partial<ProviderAccount>): ProviderAccount {
  return {
    accountId: "pa-0001" as ProviderAccountId,
    provider: "claude",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: false,
    healthState: "authenticated",
    healthObservedAt: "2026-01-01T07:00:00.000Z",
    observedAuthMode: "oauth_subscription",
    loggedInAt: null,
    lastRefreshObservedAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  };
}

/** The label `account` is listed under, or `undefined` where it is not listed. */
function accountLabel(account: ProviderAccount): string | undefined {
  return listedAccount(account)?.label;
}

describe("listedAccount", () => {
  it("names a signed-in account by its reported email, plan word and organization", () => {
    const signedIn = { observedAccountEmail: "sam@example.org" };
    expect(accountLabel(account({ ...signedIn, observedAccountPlan: "max" }))).toBe(
      "sam@example.org · Max",
    );
    expect(
      accountLabel(
        account({
          ...signedIn,
          provider: "codex",
          observedAccountPlan: "team",
          observedAccountOrgName: "Example Inc",
        }),
      ),
    ).toBe("sam@example.org · Business · Example Inc");
    // Codex's `pro` is not Claude Code's: each provider's own word for its own plan.
    expect(
      accountLabel(account({ ...signedIn, provider: "codex", observedAccountPlan: "pro" })),
    ).toBe("sam@example.org · Pro (More)");
    expect(
      accountLabel(account({ ...signedIn, provider: "codex", observedAccountPlan: "edu_max" })),
    ).toBe("sam@example.org · Edu max");
    expect(accountLabel(account({ ...signedIn, observedAccountPlan: "unknown" }))).toBe(
      "sam@example.org",
    );
  });

  it("leaves out an account still signing in that its provider has not named yet", () => {
    // Such an account has no row until its sign-in ends, so no surface draws a blank name.
    expect(listedAccount(account({ observedAccountPlan: "unknown" }))).toBeUndefined();
    expect(listedAccount(account({}))).toBeUndefined();
  });

  it("names a pasted token or API-key account by its typed name and credential kind", () => {
    expect(
      accountLabel(
        account({ provider: "codex", displayLabel: "Work", observedAuthMode: "api_key" }),
      ),
    ).toBe("Work · Codex API key");
    expect(
      accountLabel(account({ displayLabel: "Personal", observedAuthMode: "oauth_token" })),
    ).toBe("Personal · Claude Code token");
  });
});
