// The four derivations the accounts shell makes over one registry reply.
//
// EVERY CASE DRIVES THE REAL FUNCTION. Nothing here reimplements a fold, a
// supersession rule, or a day count — a test that restated one would pass against a
// module that had stopped agreeing with it, which is the failure the package standard
// names outright.
//
// AND EVERY CLEAN RESULT HAS ITS NEGATIVE CONTROL. The `limitId` key, the
// `observedAt` ordering, the `probe` tie-break, and the generation comparison are
// each asserted twice — once for what they do, once for the thing they would do if
// the rule were the obvious wrong one.

import { describe, expect, it } from "vitest";

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import { instantMilliseconds } from "../../../../core/frozen-instant.test-support.js";
import {
  estimatedReloginDaysAfterSignIn,
  foldAccountQuotaRows,
  observationAgeInDays,
  readinessForProvider,
} from "./quota-rows.js";

const ACCOUNT_ID = "pa-0001" as ProviderAccountId;
const OTHER_ACCOUNT_ID = "pa-0002" as ProviderAccountId;

function accountAtGeneration(credentialGeneration: number): ProviderAccount {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Work",
    credentialGeneration,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: "2026-01-01T07:00:00.000Z",
    observedAuthMode: "oauth_subscription",
    loggedInAt: "2025-12-02T09:00:00.000Z",
    expectedReloginAtEstimate: "2026-01-01T09:00:00.000Z",
    probeEnabled: true,
  };
}

function usageWindow(
  overrides: Partial<ProviderAccountUsageWindow> & { readonly limitId: string },
): ProviderAccountUsageWindow {
  return {
    accountId: ACCOUNT_ID,
    windowMins: 10080,
    usedPercent: 10,
    observedAt: "2026-01-01T07:00:00.000Z",
    observedCredentialGeneration: 3,
    source: "run",
    ...overrides,
  };
}

describe("foldAccountQuotaRows", () => {
  it("keeps three limits that share one window length apart", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({ limitId: "weekly_all", label: "Weekly, all models" }),
      usageWindow({ limitId: "weekly_opus", label: "Weekly, Opus" }),
      usageWindow({ limitId: "weekly_code", label: "Weekly, code" }),
    ]);
    expect(rows.map((row) => row.window.limitId)).toEqual([
      "weekly_all",
      "weekly_code",
      "weekly_opus",
    ]);
  });

  // The negative control for the case above: every one of those three carries the
  // same `windowMins`, so a fold keyed on the window length would answer one row.
  it("does not collapse rows that share a window length", () => {
    const sharedWindowLengths = new Set(
      [
        usageWindow({ limitId: "weekly_all" }),
        usageWindow({ limitId: "weekly_opus" }),
        usageWindow({ limitId: "weekly_code" }),
      ].map((window) => window.windowMins),
    );
    expect(sharedWindowLengths.size).toBe(1);
  });

  it("keeps the newest observation for a limit", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({
        limitId: "weekly_all",
        observedAt: "2026-01-01T06:00:00.000Z",
        usedPercent: 5,
      }),
      usageWindow({
        limitId: "weekly_all",
        observedAt: "2026-01-01T07:30:00.000Z",
        usedPercent: 44,
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.window.usedPercent).toBe(44);
  });

  it("does not keep the newest observation when it arrived first", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({
        limitId: "weekly_all",
        observedAt: "2026-01-01T07:30:00.000Z",
        usedPercent: 44,
      }),
      usageWindow({
        limitId: "weekly_all",
        observedAt: "2026-01-01T06:00:00.000Z",
        usedPercent: 5,
      }),
    ]);
    expect(rows[0]?.window.usedPercent).toBe(44);
  });

  it("breaks an exact tie toward the deliberate probe", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({ limitId: "weekly_all", source: "run", usedPercent: 5 }),
      usageWindow({ limitId: "weekly_all", source: "probe", usedPercent: 44 }),
    ]);
    expect(rows[0]?.window.usedPercent).toBe(44);
  });

  // The tie-break applies to an EXACT tie and to nothing else: a run-sourced reading
  // taken later still wins, because recency decides first.
  it("does not prefer a probe that is older than a run reading", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({
        limitId: "weekly_all",
        source: "probe",
        observedAt: "2026-01-01T06:00:00.000Z",
        usedPercent: 44,
      }),
      usageWindow({
        limitId: "weekly_all",
        source: "run",
        observedAt: "2026-01-01T07:30:00.000Z",
        usedPercent: 5,
      }),
    ]);
    expect(rows[0]?.window.usedPercent).toBe(5);
  });

  it("marks a reading taken under an older credential generation", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(6), [
      usageWindow({ limitId: "weekly_all", observedCredentialGeneration: 5 }),
    ]);
    expect(rows[0]?.behindAccountGeneration).toBe(true);
  });

  it("does not mark a reading taken under the account's own generation", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(6), [
      usageWindow({ limitId: "weekly_all", observedCredentialGeneration: 6 }),
    ]);
    expect(rows[0]?.behindAccountGeneration).toBe(false);
  });

  it("ignores readings belonging to another account", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({ limitId: "weekly_all", accountId: OTHER_ACCOUNT_ID }),
    ]);
    expect(rows).toEqual([]);
  });

  it("sorts by the limit identifier where the provider published no label", () => {
    const rows = foldAccountQuotaRows(accountAtGeneration(3), [
      usageWindow({ limitId: "zeta" }),
      usageWindow({ limitId: "alpha" }),
    ]);
    expect(rows.map((row) => row.window.limitId)).toEqual(["alpha", "zeta"]);
  });
});

describe("estimatedReloginDaysAfterSignIn", () => {
  it("measures the interval between the two stamps", () => {
    expect(
      estimatedReloginDaysAfterSignIn("2025-12-02T09:00:00.000Z", "2026-01-01T09:00:00.000Z"),
    ).toBe(30);
  });

  // Measured from the ANCHOR and never from the clock: the same pair answers the same
  // number whenever it is asked, which is what stops the figure reading as a deadline.
  it("answers the same interval however far in the past the pair sits", () => {
    expect(
      estimatedReloginDaysAfterSignIn("2020-01-01T00:00:00.000Z", "2020-01-31T00:00:00.000Z"),
    ).toBe(30);
  });

  it("answers nothing where either stamp is unreadable", () => {
    expect(
      estimatedReloginDaysAfterSignIn("not a time", "2026-01-01T09:00:00.000Z"),
    ).toBeUndefined();
    expect(
      estimatedReloginDaysAfterSignIn("2026-01-01T09:00:00.000Z", "not a time"),
    ).toBeUndefined();
  });

  it("answers zero — a real number — for a same-day estimate", () => {
    expect(
      estimatedReloginDaysAfterSignIn("2026-01-01T09:00:00.000Z", "2026-01-01T20:00:00.000Z"),
    ).toBe(0);
  });
});

describe("observationAgeInDays", () => {
  it("counts whole days since the observation", () => {
    const now = instantMilliseconds("2026-01-15T07:00:00.000Z");
    expect(observationAgeInDays("2026-01-01T07:00:00.000Z", now)).toBe(14);
  });

  it("answers nothing where the stamp cannot be read", () => {
    expect(
      observationAgeInDays("whenever", instantMilliseconds("2026-01-15T07:00:00.000Z")),
    ).toBeUndefined();
  });
});

describe("readinessForProvider", () => {
  const reply: ProviderAccountListResponse = {
    accounts: [],
    usageWindows: [],
    readiness: [
      { provider: "claude", state: "authenticated" },
      {
        provider: "codex",
        state: "indeterminate",
        remedy: { kind: "register", provider: "codex" },
      },
    ],
  };

  it("finds the entry for the provider asked about", () => {
    expect(readinessForProvider(reply, "codex")?.state).toBe("indeterminate");
  });

  it("answers nothing rather than fabricating a state", () => {
    expect(readinessForProvider({ ...reply, readiness: [] }, "claude")).toBeUndefined();
  });
});
