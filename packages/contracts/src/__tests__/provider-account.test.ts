// `providerAccount.*`: the closed enums, the tolerant observation boundary beside the closed
// wire union, the account record, readiness and its remedy union, the quota-window reading,
// the list read, and the registry-change notification.
import { describe, expect, it } from "vitest";

import {
  BILLING_MODES,
  CREDENTIAL_GENERATION_MIN,
  CredentialGenerationSchema,
  PROVIDER_ACCOUNT_PLAN_MAX_LEN,
  PROVIDER_AUTH_MODES,
  PROVIDER_NAMES,
  PROVIDER_QUOTA_DEFAULT_LIMIT_ID,
  ProviderAccountListRequestSchema,
  ProviderAccountListResponseSchema,
  ProviderAccountMemoryImportOutcomeSchema,
  ProviderAccountNotificationSchema,
  ProviderAccountSchema,
  ProviderAccountSubscribeRequestSchema,
  ProviderAccountUsageWindowSchema,
  ProviderAuthModeSchema,
  ProviderNameSchema,
  ProviderReadinessSchema,
  ProviderRemedySchema,
  normalizeObservedProviderAuthMode,
} from "../provider-account.js";

const ACCOUNT_ID = "acct_01J8XYZ";
const OTHER_ACCOUNT_ID = "acct_01J8ABC";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";

function validAccount(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    provider: "claude",
    displayLabel: "Personal",
    credentialGeneration: 1,
    billingMode: "subscription",
    isDefault: true,
    healthState: "authenticated",
    healthObservedAt: TIMESTAMP,
    observedAuthMode: "oauth_subscription",
    loggedInAt: TIMESTAMP,
    lastRefreshObservedAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
    ...overrides,
  };
}

function validUsageWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accountId: ACCOUNT_ID,
    limitId: PROVIDER_QUOTA_DEFAULT_LIMIT_ID,
    windowMins: 10080,
    usedPercent: 41.5,
    observedAt: TIMESTAMP,
    observedCredentialGeneration: 1,
    source: "probe",
    ...overrides,
  };
}

describe("provider-account enums", () => {
  it("declares the provider set closed at exactly the two pinned providers", () => {
    expect([...PROVIDER_NAMES]).toEqual(["claude", "codex"]);
    expect(ProviderNameSchema.safeParse("claude").success).toBe(true);
    expect(ProviderNameSchema.safeParse("codex").success).toBe(true);
    // An account's provider selects the driver, the credential-home layout, and
    // the quota vocabulary, so an unrecognized value has no safe reading.
    expect(ProviderNameSchema.safeParse("gemini").success).toBe(false);
    expect(ProviderNameSchema.safeParse("Claude").success).toBe(false);
  });

  it("discriminates all three billing modes and keeps `unknown` distinct", () => {
    expect([...BILLING_MODES]).toEqual(["subscription", "metered", "unknown"]);
    for (const billingMode of BILLING_MODES) {
      expect(ProviderAccountSchema.safeParse(validAccount({ billingMode })).success).toBe(true);
    }
    // `unknown` is a distinct value: never folded into `metered`, never an omission.
    expect(ProviderAccountSchema.safeParse(validAccount({ billingMode: "free" })).success).toBe(
      false,
    );
    const withoutBillingMode = validAccount();
    delete withoutBillingMode["billingMode"];
    expect(ProviderAccountSchema.safeParse(withoutBillingMode).success).toBe(false);
  });
});

describe("ProviderAuthMode — closed on the wire, tolerant at the observation boundary", () => {
  it("keeps the wire union closed", () => {
    for (const authMode of PROVIDER_AUTH_MODES) {
      expect(ProviderAuthModeSchema.safeParse(authMode).success).toBe(true);
    }
    // The daemon produces every value on the wire, so one outside the union is a defect and
    // must fail loudly; the observation boundary's tolerance does not reach here.
    expect(ProviderAuthModeSchema.safeParse("magic_link").success).toBe(false);
    expect(ProviderAuthModeSchema.safeParse(null).success).toBe(false);
  });

  it("maps an unrecognized provider-reported mode onto `unknown` rather than throwing", () => {
    // A vendor adding a mode must lower an observation's precision, not fail it.
    expect(normalizeObservedProviderAuthMode("device_grant")).toBe("unknown");
    expect(normalizeObservedProviderAuthMode("OAUTH_SUBSCRIPTION")).toBe("unknown");
    expect(normalizeObservedProviderAuthMode(42)).toBe("unknown");
    expect(normalizeObservedProviderAuthMode({ mode: "oauth_token" })).toBe("unknown");
    expect(() => normalizeObservedProviderAuthMode(Symbol("x"))).not.toThrow();
  });

  it("recognizes every union member, trimming the provider's own whitespace", () => {
    for (const authMode of PROVIDER_AUTH_MODES) {
      expect(normalizeObservedProviderAuthMode(authMode)).toBe(authMode);
      expect(normalizeObservedProviderAuthMode(`  ${authMode}\n`)).toBe(authMode);
    }
  });

  it("distinguishes NOT OBSERVED from OBSERVED-BUT-UNRECOGNIZED", () => {
    // An absent report recorded as `unknown` would claim the provider named a mode.
    expect(normalizeObservedProviderAuthMode(null)).toBeNull();
    expect(normalizeObservedProviderAuthMode(undefined)).toBeNull();
    // A present but empty field names no mode, the same as no field.
    expect(normalizeObservedProviderAuthMode("")).toBeNull();
    expect(normalizeObservedProviderAuthMode("   ")).toBeNull();
  });
});

describe("CredentialGeneration", () => {
  it("floors at the generation an account is born at and rejects everything below it", () => {
    expect(CREDENTIAL_GENERATION_MIN).toBe(1);
    expect(CredentialGenerationSchema.safeParse(1).success).toBe(true);
    expect(CredentialGenerationSchema.safeParse(9001).success).toBe(true);
    // Generation 0 would order before a freshly registered account, so a fabricated reading
    // would look newer than the account it describes.
    expect(CredentialGenerationSchema.safeParse(0).success).toBe(false);
    expect(CredentialGenerationSchema.safeParse(-1).success).toBe(false);
    // A fractional generation compares unequal to every stored value.
    expect(CredentialGenerationSchema.safeParse(1.5).success).toBe(false);
    expect(CredentialGenerationSchema.safeParse(Number.NaN).success).toBe(false);
    expect(CredentialGenerationSchema.safeParse("1").success).toBe(false);
  });
});

describe("ProviderAccount record", () => {
  it("accepts the full record and the subset-reported identity trio", () => {
    expect(ProviderAccountSchema.safeParse(validAccount()).success).toBe(true);
    // Each provider-reported member is optional on its own; an absent one stays absent.
    expect(
      ProviderAccountSchema.safeParse(validAccount({ observedAccountEmail: "a@example.test" }))
        .success,
    ).toBe(true);
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ observedAccountOrgId: "org_1", observedAccountOrgName: "Acme" }),
      ).success,
    ).toBe(true);
  });

  it("spells an unobserved fact as an explicit null rather than an omission", () => {
    // Nullable, not optional: an optional member would make "unobserved" and "the producer
    // forgot" the same wire value.
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ observedAuthMode: null, loggedInAt: null, expectedReloginAtEstimate: null }),
      ).success,
    ).toBe(true);
    const withoutAuthMode = validAccount();
    delete withoutAuthMode["observedAuthMode"];
    expect(ProviderAccountSchema.safeParse(withoutAuthMode).success).toBe(false);
    const withoutEstimate = validAccount();
    delete withoutEstimate["expectedReloginAtEstimate"];
    expect(ProviderAccountSchema.safeParse(withoutEstimate).success).toBe(false);
  });

  it("carries the stored observation as a PAIR, so a fresh indeterminate is not a never-observed one", () => {
    // With `healthState` alone, a never-observed account and one whose probe could not decide
    // look the same, and a non-default account in a list reply would carry a state with no age.
    const neverObserved = validAccount({
      healthState: "indeterminate",
      healthObservedAt: null,
    });
    const probedAndUndecided = validAccount({
      healthState: "indeterminate",
      healthObservedAt: TIMESTAMP,
    });
    expect(ProviderAccountSchema.safeParse(neverObserved).success).toBe(true);
    expect(ProviderAccountSchema.safeParse(probedAndUndecided).success).toBe(true);
    expect(neverObserved["healthObservedAt"]).not.toEqual(probedAndUndecided["healthObservedAt"]);

    // Required and nullable, like the members beside it: omitting it would make "never
    // observed" and "the producer forgot" the same wire value.
    const withoutObservedAt = validAccount();
    delete withoutObservedAt["healthObservedAt"];
    expect(ProviderAccountSchema.safeParse(withoutObservedAt).success).toBe(false);

    // Same offset-bearing RFC 3339 rule as the module's other timestamps.
    expect(
      ProviderAccountSchema.safeParse(validAccount({ healthObservedAt: "2026-08-31" })).success,
    ).toBe(false);
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ healthObservedAt: "2026-08-31T00:00:00+02:00" }),
      ).success,
    ).toBe(true);
  });

  it("refuses an observed health state carrying no observation time", () => {
    // A null `healthObservedAt` means nothing was ever observed, so only `indeterminate` fits.
    // The other states are outcomes of an observation; without a time they show a freshness
    // the daemon never measured.
    for (const observedOnlyState of ["authenticated", "reauth_required", "home_missing"] as const) {
      const parsed = ProviderAccountSchema.safeParse(
        validAccount({ healthState: observedOnlyState, healthObservedAt: null }),
      );
      expect(parsed.success, `\`${observedOnlyState}\` was admitted with a null observation`).toBe(
        false,
      );
      // The stored row pairs a state with its observation time, so the missing member is the
      // timestamp.
      expect(
        parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".")),
      ).toEqual(["healthObservedAt"]);
    }
    // The rule is about the state, not about null: `indeterminate` keeps both readings.
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ healthState: "indeterminate", healthObservedAt: null }),
      ).success,
    ).toBe(true);
    for (const observedOnlyState of ["authenticated", "reauth_required", "home_missing"] as const) {
      expect(
        ProviderAccountSchema.safeParse(
          validAccount({ healthState: observedOnlyState, healthObservedAt: TIMESTAMP }),
        ).success,
      ).toBe(true);
    }
  });

  it("rejects a whitespace-only or NUL-bearing display label", () => {
    expect(ProviderAccountSchema.safeParse(validAccount({ displayLabel: "" })).success).toBe(false);
    expect(ProviderAccountSchema.safeParse(validAccount({ displayLabel: "   " })).success).toBe(
      false,
    );
    expect(ProviderAccountSchema.safeParse(validAccount({ displayLabel: "a\0b" })).success).toBe(
      false,
    );
  });

  it("requires offset-bearing RFC 3339 timestamps", () => {
    expect(
      ProviderAccountSchema.safeParse(validAccount({ loggedInAt: "2026-08-31" })).success,
    ).toBe(false);
    expect(
      ProviderAccountSchema.safeParse(validAccount({ loggedInAt: "2026-08-31T00:00:00+02:00" }))
        .success,
    ).toBe(true);
  });

  it("carries the account's one memory import: a count and a time, nothing to import, or none yet", () => {
    for (const memoryImport of [
      null,
      { outcome: "imported", count: 14, importedAt: TIMESTAMP },
      { outcome: "nothingToImport" },
    ]) {
      expect(ProviderAccountSchema.safeParse(validAccount({ memoryImport })).success).toBe(true);
    }
    // An import that copied nothing is `nothingToImport`, never `imported` with zero.
    expect(
      ProviderAccountMemoryImportOutcomeSchema.safeParse({
        outcome: "imported",
        count: 0,
        importedAt: TIMESTAMP,
      }).success,
    ).toBe(false);
    expect(
      ProviderAccountMemoryImportOutcomeSchema.safeParse({ outcome: "nothingToImport", count: 3 })
        .success,
    ).toBe(false);
  });

  it("carries the plan exactly as the provider sends it, bounded", () => {
    expect(
      ProviderAccountSchema.parse(validAccount({ observedAccountPlan: "promax" }))
        .observedAccountPlan,
    ).toBe("promax");
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ observedAccountPlan: "p".repeat(PROVIDER_ACCOUNT_PLAN_MAX_LEN + 1) }),
      ).success,
    ).toBe(false);
  });

  it("carries no credential-home path", () => {
    // The only wire member that carries a credential home is the readiness remedy's sign-in arm.
    expect(
      ProviderAccountSchema.safeParse(
        validAccount({ credentialHomePath: "/var/lib/sidekicks/homes/acct" }),
      ).success,
    ).toBe(false);
  });
});

describe("readiness and its remedy union", () => {
  it("accepts an authenticated entry with no remedy and a refused entry with one", () => {
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "authenticated",
        resolvedAccountId: ACCOUNT_ID,
        observedAt: TIMESTAMP,
      }).success,
    ).toBe(true);
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "codex",
        state: "no_account",
        remedy: { kind: "register", provider: "codex" },
      }).success,
    ).toBe(true);
  });

  it("refuses a remedy whose discriminant names no arm", () => {
    expect(ProviderRemedySchema.safeParse({ kind: "sign_up", provider: "claude" }).success).toBe(
      false,
    );
  });

  it("requires the resolved account on the sign-in arm and candidates on the choose arm", () => {
    expect(
      ProviderRemedySchema.safeParse({
        kind: "sign_in",
        accountId: ACCOUNT_ID,
        signInInvocation: "claude setup-token",
        credentialHomePath: "/var/lib/sidekicks/homes/acct",
      }).success,
    ).toBe(true);
    // The sign-in arm means an account resolved, so its id is required.
    expect(
      ProviderRemedySchema.safeParse({
        kind: "sign_in",
        signInInvocation: "claude setup-token",
        credentialHomePath: "/var/lib/sidekicks/homes/acct",
      }).success,
    ).toBe(false);
    expect(
      ProviderRemedySchema.safeParse({
        kind: "choose_default",
        candidateAccountIds: [ACCOUNT_ID, OTHER_ACCOUNT_ID],
      }).success,
    ).toBe(true);
    expect(
      ProviderRemedySchema.safeParse({ kind: "choose_default", candidateAccountIds: [] }).success,
    ).toBe(false);
  });

  it("requires the home path to be non-empty, NUL-free, and bounded", () => {
    const signInRemedy = (credentialHomePath: string): unknown => ({
      kind: "sign_in",
      accountId: ACCOUNT_ID,
      signInInvocation: "claude setup-token",
      credentialHomePath,
    });
    expect(ProviderRemedySchema.safeParse(signInRemedy("")).success).toBe(false);
    expect(ProviderRemedySchema.safeParse(signInRemedy("   ")).success).toBe(false);
    expect(ProviderRemedySchema.safeParse(signInRemedy("/homes/a\0b")).success).toBe(false);
    expect(ProviderRemedySchema.safeParse(signInRemedy("/".repeat(9000))).success).toBe(false);
    // Absoluteness is deliberately not enforced (as with `RepoAttachRequest.localPath`): a
    // leading-slash rule would refuse every Windows home. The daemon's credential-home service
    // owns the filesystem rules.
    expect(ProviderRemedySchema.safeParse(signInRemedy("C:\\Users\\op\\.claude")).success).toBe(
      true,
    );
  });

  it("binds each readiness state to the one remedy its state calls for", () => {
    // Each state calls for one kind of remedy; a `no_account` entry carrying `sign_in` would
    // disclose a credential-home path for a resolution that reached no account.
    const signIn = {
      kind: "sign_in",
      accountId: ACCOUNT_ID,
      signInInvocation: "claude setup-token",
      credentialHomePath: "/var/lib/sidekicks/homes/acct",
    };
    const register = { kind: "register", provider: "claude" };
    const chooseDefault = { kind: "choose_default", candidateAccountIds: [ACCOUNT_ID] };
    // `resolvedAccountId` is present only on the three states that resolved an account.
    const legal: ReadonlyArray<readonly [string, unknown, boolean]> = [
      ["reauth_required", signIn, true],
      ["home_missing", signIn, true],
      ["indeterminate", signIn, true],
      ["no_account", register, false],
      ["no_default", chooseDefault, false],
    ];
    for (const [state, remedy, resolved] of legal) {
      expect(
        ProviderReadinessSchema.safeParse({
          provider: "claude",
          state,
          ...(resolved ? { resolvedAccountId: ACCOUNT_ID } : {}),
          remedy,
        }).success,
        `\`${state}\` refused its own remedy`,
      ).toBe(true);
    }
    // Every other pairing is refused. Each case supplies `resolvedAccountId` and asserts the
    // issue path, so the refusal comes from the kind mismatch, not the account-agreement rule
    // below.
    for (const [state, expected] of legal) {
      for (const remedy of [signIn, register, chooseDefault]) {
        if (remedy === expected) {
          continue;
        }
        const parsed = ProviderReadinessSchema.safeParse({
          provider: "claude",
          state,
          resolvedAccountId: ACCOUNT_ID,
          remedy,
        });
        expect(parsed.success, `\`${state}\` admitted a remedy it does not call for`).toBe(false);
        expect(
          parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join(".")),
        ).toEqual(["remedy.kind"]);
      }
    }
  });

  it("carries no remedy on the authenticated arm", () => {
    // `authenticated` has nothing to fix; a remedy there would put a sign-in command and a
    // credential-home path on an account that needs neither.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "authenticated",
        resolvedAccountId: ACCOUNT_ID,
        observedAt: TIMESTAMP,
      }).success,
    ).toBe(true);
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "authenticated",
        resolvedAccountId: ACCOUNT_ID,
        observedAt: TIMESTAMP,
        remedy: {
          kind: "sign_in",
          accountId: ACCOUNT_ID,
          signInInvocation: "claude setup-token",
          credentialHomePath: "/var/lib/sidekicks/homes/acct",
        },
      }).success,
    ).toBe(false);
  });

  it("keeps requiredness with the producer while checking presence", () => {
    // The remedy is optional in the schema on every arm and the producer is obliged to send
    // it; the parser only checks that a remedy that is present is the right one.
    expect(
      ProviderReadinessSchema.safeParse({ provider: "codex", state: "no_account" }).success,
    ).toBe(true);
  });

  it("binds the sign-in remedy's account to the entry that resolved it", () => {
    const signInFor = (accountId: string): unknown => ({
      kind: "sign_in",
      accountId,
      signInInvocation: "claude setup-token",
      credentialHomePath: "/var/lib/sidekicks/homes/acct",
    });
    // A remedy naming a different account would point at one account's credential home to
    // repair another's.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        resolvedAccountId: ACCOUNT_ID,
        remedy: signInFor(OTHER_ACCOUNT_ID),
      }).success,
    ).toBe(false);
    // An entry that resolved no account cannot carry a home path: `resolvedAccountId` is
    // present exactly when resolution reached one account.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        remedy: signInFor(ACCOUNT_ID),
      }).success,
    ).toBe(false);
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        resolvedAccountId: ACCOUNT_ID,
        remedy: signInFor(ACCOUNT_ID),
      }).success,
    ).toBe(true);
  });
});

describe("quota-window shape", () => {
  it("accepts a reading and treats the window length as an attribute of it", () => {
    expect(ProviderAccountUsageWindowSchema.safeParse(validUsageWindow()).success).toBe(true);
    // Several limits can share one window length, so the limit id is part of the key.
    for (const limitId of ["weekly_opus", "weekly_all", "weekly_code"]) {
      expect(
        ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ limitId, windowMins: 10080 }))
          .success,
      ).toBe(true);
    }
  });

  it("accepts over-consumption and refuses a negative reading", () => {
    // Not clamped: a provider may report over-consumption against a soft limit.
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ usedPercent: 143.2 })).success,
    ).toBe(true);
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ usedPercent: -0.1 })).success,
    ).toBe(false);
  });

  it("refuses a non-positive window length and an unsourced reading", () => {
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ windowMins: 0 })).success,
    ).toBe(false);
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ windowMins: 1.5 })).success,
    ).toBe(false);
    // The background health observer is not a source; no other value exists.
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ source: "observer" })).success,
    ).toBe(false);
  });

  it("keeps the limit vocabulary open", () => {
    // A closed union would reject a reading as soon as a vendor added a window.
    expect(
      ProviderAccountUsageWindowSchema.safeParse(validUsageWindow({ limitId: "brand_new_window" }))
        .success,
    ).toBe(true);
  });
});

describe("the list read, the subscribe request and the notification", () => {
  it("accepts the list pair and the subscribe request at their canonical shape", () => {
    expect(ProviderAccountListRequestSchema.safeParse({}).success).toBe(true);
    expect(ProviderAccountListRequestSchema.safeParse({ provider: "claude" }).success).toBe(true);
    expect(
      ProviderAccountListResponseSchema.safeParse({
        accounts: [validAccount()],
        usageWindows: [validUsageWindow()],
        readiness: [{ provider: "claude", state: "authenticated", resolvedAccountId: ACCOUNT_ID }],
      }).success,
    ).toBe(true);

    expect(ProviderAccountSubscribeRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts every notification arm and refuses an unknown kind", () => {
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "account_changed",
        account: validAccount(),
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "account_removed",
        accountId: ACCOUNT_ID,
      }).success,
    ).toBe(true);
    for (const outcome of ["succeeded", "failed", "canceled"]) {
      expect(
        ProviderAccountNotificationSchema.safeParse({
          kind: "login_completed",
          attemptId: "attempt_1",
          accountId: ACCOUNT_ID,
          outcome,
        }).success,
      ).toBe(true);
    }
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "usage_window_updated",
        accountId: ACCOUNT_ID,
        window: validUsageWindow(),
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountNotificationSchema.safeParse({ kind: "account_probed", accountId: ACCOUNT_ID })
        .success,
    ).toBe(false);
  });

  it("refuses a usage-window notification whose reading contradicts its routing key", () => {
    // The outer `accountId` routes and `window.accountId` is part of the reading; the two
    // must be equal, or a consumer would file the reading under the wrong account.
    const mismatched = ProviderAccountNotificationSchema.safeParse({
      kind: "usage_window_updated",
      accountId: ACCOUNT_ID,
      window: validUsageWindow({ accountId: OTHER_ACCOUNT_ID }),
    });
    expect(mismatched.success).toBe(false);
    if (mismatched.success) {
      throw new Error("unreachable — a contradictory usage-window notification must not parse");
    }
    // The refusal points at the inner half that contradicts the envelope.
    expect(mismatched.error.issues.map((issue) => issue.path.join("."))).toContain(
      "window.accountId",
    );

    // With the two halves agreeing it parses, so the refusal above is the mismatch.
    expect(
      ProviderAccountNotificationSchema.safeParse({
        kind: "usage_window_updated",
        accountId: OTHER_ACCOUNT_ID,
        window: validUsageWindow({ accountId: OTHER_ACCOUNT_ID }),
      }).success,
    ).toBe(true);
  });
});
