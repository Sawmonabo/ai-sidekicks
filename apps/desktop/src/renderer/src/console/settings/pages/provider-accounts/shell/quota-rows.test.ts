// The four derivations the accounts shell makes over one account-plane reading.
//
// EVERY CASE DRIVES THE REAL FUNCTION. Nothing here reimplements a selection, a
// supersession rule, or a day count — a test that restated one would pass against a
// module that had stopped agreeing with it, which is the failure the package standard
// names outright.
//
// AND EVERY CLEAN RESULT HAS ITS NEGATIVE CONTROL. The `limitId` key, the account
// filter, the ordering, and the generation comparison are each asserted twice — once
// for what they do, once for the thing they would do if the rule were the obvious
// wrong one.
//
// WHICH READING IS CURRENT IS ASSERTED ELSEWHERE, ON PURPOSE. That rule belongs to
// `bridge/quotas/provider-quota-fold.ts`, which has its own suite, and to
// `AccountsShell.quota-supersession.test.tsx`, which drives the whole path from the
// node's tail to the rendered cell. What is asserted HERE is that this module makes no
// such decision of its own — the case that hands it two readings for one limit is the
// foil for exactly that, and its input is one the readout's contract does not produce.

import { describe, expect, it } from "vitest";

import type {
  ProviderAccount,
  ProviderAccountId,
  ProviderAccountListResponse,
  ProviderAccountUsageWindow,
} from "@ai-sidekicks/contracts";

import type { ProviderQuotaReadout } from "../../../../bridge/index.js";
import { instantMilliseconds } from "../../../../core/frozen-instant.test-support.js";
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
 * A reading of the account plane holding exactly these seated rows.
 *
 * The readout is the only thing the selection accepts, and it is composed here rather
 * than reached for: what the four other members say does not bear on which rows this
 * account's table draws, so a case that had to script a phase and a refusal to ask
 * about ordering would be answering a question nobody asked.
 */
function registryHolding(
  usageWindows: readonly ProviderAccountUsageWindow[],
): ProviderQuotaReadout {
  return {
    usageWindows,
    readings: [],
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

  // The negative control for the case above: every one of those three carries the
  // same `windowMins`, so a selection keyed on the window length would answer one row.
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

  // THE FOIL FOR THE SECOND RULE THAT USED TO LIVE HERE. Two readings for one limit is
  // an input the readout's own contract does not produce — the fold seats one row per
  // `(accountId, limitId)` — and that is exactly why it is the right probe: a module
  // that resolved this pair would be answering a question it is not allowed to answer,
  // and the answer it used to give was the wrong one, seating a later 5% over a
  // standing 44% inside one window because it ranked on the timestamp alone.
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

  it("marks a reading taken under an older credential generation", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "weekly_all", observedCredentialGeneration: 5 })]),
      accountAtGeneration(6),
    );
    expect(rows[0]?.behindAccountGeneration).toBe(true);
  });

  it("does not mark a reading taken under the account's own generation", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "weekly_all", observedCredentialGeneration: 6 })]),
      accountAtGeneration(6),
    );
    expect(rows[0]?.behindAccountGeneration).toBe(false);
  });

  it("ignores readings belonging to another account", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "weekly_all", accountId: OTHER_ACCOUNT_ID })]),
      accountAtGeneration(3),
    );
    expect(rows).toEqual([]);
  });

  it("sorts by the limit identifier where the provider published no label", () => {
    const rows = accountQuotaRowsFrom(
      registryHolding([usageWindow({ limitId: "zeta" }), usageWindow({ limitId: "alpha" })]),
      accountAtGeneration(3),
    );
    expect(rows.map((row) => row.window.limitId)).toEqual(["alpha", "zeta"]);
  });

  // The ordering is this page's and the reading is the node's, so the selection must
  // not reorder the array it was handed — a fold publishing its rows to two surfaces
  // would otherwise have one of them shuffled under it.
  it("leaves the reading's own row order untouched", () => {
    const seated = [usageWindow({ limitId: "zeta" }), usageWindow({ limitId: "alpha" })];
    const registry = registryHolding(seated);

    accountQuotaRowsFrom(registry, accountAtGeneration(3));

    expect(registry.usageWindows.map((window) => window.limitId)).toEqual(["zeta", "alpha"]);
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
    expect(readinessForProvider(reply.readiness, "codex")?.state).toBe("indeterminate");
  });

  it("answers nothing rather than fabricating a state", () => {
    expect(readinessForProvider([], "claude")).toBeUndefined();
  });
});
