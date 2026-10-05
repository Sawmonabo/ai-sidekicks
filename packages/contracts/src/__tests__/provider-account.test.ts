// `providerAccount.*`: the observation boundary's auth-mode normalizer, the account record's
// health pair and its refusal of a credential-home path, readiness and its remedy binding, and the
// usage-window notification's routing key.
import { describe, expect, it } from "vitest";

import {
  PROVIDER_AUTH_MODES,
  PROVIDER_QUOTA_DEFAULT_LIMIT_ID,
  ProviderAccountNotificationSchema,
  ProviderAccountSchema,
  ProviderReadinessSchema,
  normalizeObservedProviderAuthMode,
} from "../provider-account.js";
import { ACCOUNT_ID, TIMESTAMP, validProviderAccount } from "./provider-account.test-support.js";

const OTHER_ACCOUNT_ID = "acct_01J8ABC";

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

describe("normalizeObservedProviderAuthMode (the observation boundary)", () => {
  it("maps a reported mode onto the union, an unknown one to `unknown`, none to null", () => {
    // A vendor adding a mode must lower an observation's precision, not fail it.
    expect(normalizeObservedProviderAuthMode("device_grant")).toBe("unknown");
    expect(normalizeObservedProviderAuthMode("OAUTH_SUBSCRIPTION")).toBe("unknown");
    expect(normalizeObservedProviderAuthMode(42)).toBe("unknown");
    expect(normalizeObservedProviderAuthMode({ mode: "oauth_token" })).toBe("unknown");
    expect(() => normalizeObservedProviderAuthMode(Symbol("x"))).not.toThrow();
    for (const authMode of PROVIDER_AUTH_MODES) {
      expect(normalizeObservedProviderAuthMode(authMode)).toBe(authMode);
      expect(normalizeObservedProviderAuthMode(`  ${authMode}\n`)).toBe(authMode);
    }
    // An absent report recorded as `unknown` would claim the provider named a mode.
    expect(normalizeObservedProviderAuthMode(null)).toBeNull();
    expect(normalizeObservedProviderAuthMode(undefined)).toBeNull();
    // A present but empty field names no mode, the same as no field.
    expect(normalizeObservedProviderAuthMode("")).toBeNull();
    expect(normalizeObservedProviderAuthMode("   ")).toBeNull();
  });
});

describe("ProviderAccount record", () => {
  it("accepts the full record and the subset-reported identity trio", () => {
    expect(ProviderAccountSchema.safeParse(validProviderAccount()).success).toBe(true);
    // Each provider-reported member is optional on its own; an absent one stays absent.
    expect(
      ProviderAccountSchema.safeParse(
        validProviderAccount({ observedAccountEmail: "a@example.test" }),
      ).success,
    ).toBe(true);
    expect(
      ProviderAccountSchema.safeParse(
        validProviderAccount({ observedAccountOrgId: "org_1", observedAccountOrgName: "Acme" }),
      ).success,
    ).toBe(true);
  });

  it("refuses an observed health state carrying no observation time", () => {
    // A null `healthObservedAt` means nothing was ever observed, so only `indeterminate` fits.
    // The other states are outcomes of an observation; without a time they show a freshness
    // the daemon never measured.
    for (const observedOnlyState of ["authenticated", "reauth_required", "home_missing"] as const) {
      const parsed = ProviderAccountSchema.safeParse(
        validProviderAccount({ healthState: observedOnlyState, healthObservedAt: null }),
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
        validProviderAccount({ healthState: "indeterminate", healthObservedAt: null }),
      ).success,
    ).toBe(true);
    for (const observedOnlyState of ["authenticated", "reauth_required", "home_missing"] as const) {
      expect(
        ProviderAccountSchema.safeParse(
          validProviderAccount({ healthState: observedOnlyState, healthObservedAt: TIMESTAMP }),
        ).success,
      ).toBe(true);
    }
  });

  it("carries no credential-home path", () => {
    // The record rides the account-bearing replies and the account-changed notification, and no
    // wire member carries a credential home.
    expect(
      ProviderAccountSchema.safeParse(
        validProviderAccount({ credentialHomePath: "/var/lib/sidekicks/homes/acct" }),
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

  it("binds each readiness state to the remedies its state calls for", () => {
    // A `no_account` entry carrying `sign_in` would ask for a sign-in on a resolution that reached
    // no account, and an `indeterminate` one carrying `sign_in` would walk a person through a
    // sign-in over a passing fault.
    const signIn = {
      kind: "sign_in",
      accountId: ACCOUNT_ID,
    };
    const pasteToken = { kind: "paste_token", accountId: ACCOUNT_ID };
    const lookAgain = { kind: "look_again", accountId: ACCOUNT_ID };
    const register = { kind: "register", provider: "claude" };
    const chooseDefault = { kind: "choose_default", candidateAccountIds: [ACCOUNT_ID] };
    const remedies = [signIn, pasteToken, lookAgain, register, chooseDefault];
    // `resolvedAccountId` is present only on the three states that resolved an account.
    const legal: ReadonlyArray<readonly [string, readonly unknown[], boolean]> = [
      ["reauth_required", [signIn, pasteToken], true],
      ["home_missing", [signIn], true],
      ["indeterminate", [lookAgain], true],
      ["no_account", [register], false],
      ["no_default", [chooseDefault], false],
    ];
    for (const [state, allowed, resolved] of legal) {
      for (const remedy of allowed) {
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
      // A state the person must act on never arrives bare: `indeterminate` would otherwise
      // render as a state with nothing to do about it.
      const bare = ProviderReadinessSchema.safeParse({
        provider: "claude",
        state,
        ...(resolved ? { resolvedAccountId: ACCOUNT_ID } : {}),
      });
      expect(bare.success, `\`${state}\` admitted an entry with no remedy`).toBe(false);
      expect(bare.success ? [] : bare.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "remedy",
      ]);
    }
    // Every other pairing is refused. Each case supplies `resolvedAccountId` and asserts the
    // issue path, so the refusal comes from the kind mismatch, not the account-agreement rule
    // below.
    for (const [state, allowed] of legal) {
      for (const remedy of remedies) {
        if (allowed.includes(remedy)) {
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
    // `authenticated` has nothing to fix; a remedy there would ask for a sign-in on an account
    // that needs none.
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
        },
      }).success,
    ).toBe(false);
  });

  it("binds an account-naming remedy's account to the entry that resolved it", () => {
    const signInFor = (accountId: string): unknown => ({
      kind: "sign_in",
      accountId,
    });
    // A remedy naming a different account would sign in to one account to repair another's.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        resolvedAccountId: ACCOUNT_ID,
        remedy: signInFor(OTHER_ACCOUNT_ID),
      }).success,
    ).toBe(false);
    // An entry that resolved no account cannot name one: `resolvedAccountId` is
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
    // The token and look-again remedies name an account too, under the same rule.
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "indeterminate",
        resolvedAccountId: ACCOUNT_ID,
        remedy: { kind: "look_again", accountId: OTHER_ACCOUNT_ID },
      }).success,
    ).toBe(false);
    expect(
      ProviderReadinessSchema.safeParse({
        provider: "claude",
        state: "reauth_required",
        remedy: { kind: "paste_token", accountId: ACCOUNT_ID },
      }).success,
    ).toBe(false);
  });
});

describe("the registry-change notification", () => {
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
