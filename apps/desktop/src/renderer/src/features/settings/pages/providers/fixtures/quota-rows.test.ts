// The four derivations the accounts fixture body makes over one account-plane reading. Every
// case drives the real function, so a test never restates a selection, a supersession rule or a
// day count. Which reading is current is the fold's decision (`provider-account-fold.ts`); here,
// the case handing two readings for one limit shows this module makes no such decision.

import { describe, expect, it } from "vitest";

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import type { ProviderAccountReadout } from "../provider-account-readout.js";
import { instantMilliseconds } from "./frozen-instant.test-support.js";
import {
  accountQuotaRowsFrom,
  estimatedReloginDaysAfterSignIn,
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
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
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

/**
 * A reading of the account plane holding exactly these current rows. Composed here so a case
 * asking about ordering need not script a phase and a refusal.
 */
function registryHolding(
  usageWindows: readonly ProviderAccountUsageWindow[],
): ProviderAccountReadout {
  return {
    usageWindows,
    accounts: [],
    accountLabels: new Map(),
    readiness: [],
    newestLoginCompletion: undefined,
    phase: "read",
    readRefusal: undefined,
    unreadableDeliveryCount: 0,
    unreadableRefusal: undefined,
  };
}

describe("accountQuotaRowsFrom", () => {
  it("keeps three limits that share one window length apart", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([
        usageWindow({ limitId: "weekly_all", label: "Weekly, all models" }),
        usageWindow({ limitId: "weekly_opus", label: "Weekly, Opus" }),
        usageWindow({ limitId: "weekly_code", label: "Weekly, code" }),
      ]),
      accountAtGeneration(3),
    );
    expect(rows.map((row) => row.window.limitId)).toEqual([
      "weekly_all",
      "weekly_code",
      "weekly_opus",
    ]);
  });

  // The foil for a second supersession rule: two readings for one limit is an input the
  // readout's contract does not produce (the fold keeps one row per `(accountId, limitId)`), so
  // a module resolving the pair would be answering a question it may not answer.
  it("decides nothing about which of two readings for one limit is current", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([
        usageWindow({
          limitId: "weekly_all",
          observedAt: "2026-01-01T06:00:00.000Z",
          usedPercent: 44,
        }),
        usageWindow({
          limitId: "weekly_all",
          observedAt: "2026-01-01T07:30:00.000Z",
          usedPercent: 5,
        }),
      ]),
      accountAtGeneration(3),
    );
    expect(rows.map((row) => row.window.usedPercent)).toEqual([44, 5]);
  });

  it("marks a reading from an older credential generation, and not the account's own", () => {
    const behind = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "weekly_all", observedCredentialGeneration: 5 })]),
      accountAtGeneration(6),
    );
    expect(behind[0]?.behindAccountGeneration).toBe(true);
    const current = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "weekly_all", observedCredentialGeneration: 6 })]),
      accountAtGeneration(6),
    );
    expect(current[0]?.behindAccountGeneration).toBe(false);
  });

  it("ignores readings belonging to another account", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "weekly_all", accountId: OTHER_ACCOUNT_ID })]),
      accountAtGeneration(3),
    );
    expect(rows).toEqual([]);
  });

  // The ordering is this page's and the reading is the service's, so the selection must not
  // reorder the array it was handed.
  it("leaves the reading's own row order untouched", () => {
    const currentRows = [usageWindow({ limitId: "zeta" }), usageWindow({ limitId: "alpha" })];
    const registry = registryHolding(currentRows);

    accountQuotaRowsFrom(registry, accountAtGeneration(3));

    expect(registry.usageWindows.map((window) => window.limitId)).toEqual(["zeta", "alpha"]);
  });
});

describe("estimatedReloginDaysAfterSignIn", () => {
  // Measured from the anchor, never the clock, so the same pair answers the same number and the
  // figure does not read as a deadline.
  it("measures the interval between the two stamps, however far in the past they sit", () => {
    expect(
      estimatedReloginDaysAfterSignIn("2025-12-02T09:00:00.000Z", "2026-01-01T09:00:00.000Z"),
    ).toBe(30);
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
  it("counts whole days since the observation, and nothing where the stamp cannot be read", () => {
    const now = instantMilliseconds("2026-01-15T07:00:00.000Z");
    expect(observationAgeInDays("2026-01-01T07:00:00.000Z", now)).toBe(14);
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

  it("finds the entry for the provider asked about, and fabricates none", () => {
    expect(readinessForProvider(reply.readiness, "codex")?.state).toBe("indeterminate");
    expect(readinessForProvider([], "claude")).toBeUndefined();
  });
});
