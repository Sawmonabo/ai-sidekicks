// `providerAccount.*` sign-in coverage: the register, credential-home reset,
// login and login-cancel pairs, the re-supply selector on the register
// request, and the keychain refusal's cause.
import { describe, expect, it } from "vitest";

import {
  ProviderAccountCredentialSealRefusedDetailsSchema,
  ProviderAccountLoginCancelRequestSchema,
  ProviderAccountLoginCancelResponseSchema,
  ProviderAccountLoginRequestSchema,
  ProviderAccountLoginResponseSchema,
  ProviderAccountRegisterRequestSchema,
  ProviderAccountRegisterResponseSchema,
  ProviderAccountResetCredentialHomeRequestSchema,
  ProviderAccountResetCredentialHomeResponseSchema,
} from "../provider-account-sign-in.js";

const ACCOUNT_ID = "acct_01J8XYZ";
const TIMESTAMP = "2026-08-31T00:00:00.000Z";
/** The one credential value this plane accepts. */
const TOKEN_FIXTURE = "sk-example-token";

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

describe("registering, rebuilding a credential home, and signing in", () => {
  it("accepts each sign-in pair at its canonical shape", () => {
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "codex",
        displayLabel: "Work",
        billingMode: "metered",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountRegisterResponseSchema.safeParse({ account: validAccount() }).success,
    ).toBe(true);

    expect(
      ProviderAccountResetCredentialHomeRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success,
    ).toBe(true);
    expect(
      ProviderAccountResetCredentialHomeResponseSchema.safeParse({
        accountId: ACCOUNT_ID,
        credentialGeneration: 2,
        healthState: "reauth_required",
      }).success,
    ).toBe(true);

    expect(ProviderAccountLoginRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountLoginResponseSchema.safeParse({
        attemptId: "attempt_1",
        verificationUri: "https://provider.example/device",
        userCode: "ABCD-EFGH",
        expiresAt: TIMESTAMP,
      }).success,
    ).toBe(true);
    // The authorization-URL arm carries no code, as one provider emits a URL alone.
    expect(
      ProviderAccountLoginResponseSchema.safeParse({
        attemptId: "attempt_2",
        verificationUri: "https://provider.example/oauth/authorize?state=x",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountLoginResponseSchema.safeParse({
        attemptId: "attempt_3",
        verificationUri: "open your browser",
      }).success,
    ).toBe(false);

    expect(
      ProviderAccountLoginCancelRequestSchema.safeParse({ attemptId: "attempt_1" }).success,
    ).toBe(true);
    for (const status of ["canceled", "notFound"]) {
      expect(ProviderAccountLoginCancelResponseSchema.safeParse({ status }).success).toBe(true);
    }
    // `notFound` is an outcome, not an error, so there is no arm for "the attempt failed".
    expect(ProviderAccountLoginCancelResponseSchema.safeParse({ status: "failed" }).success).toBe(
      false,
    );
  });

  it("admits `accountId` on the register request only as the re-supply selector", () => {
    // A selector, not an identity assertion: it means "replace the sealed token on this
    // account", and an id naming no registered account is refused rather than created.
    // Deregistering and re-registering would mint a new identity and discard the spend, quota
    // and attention history of the account being repaired.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        accountId: ACCOUNT_ID,
        nonInteractiveToken: TOKEN_FIXTURE,
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        accountId: "",
      }).success,
    ).toBe(false);

    // Neither member is required alone: a registration without a token is ordinary, and a token
    // without `accountId` registers a new account. Only `accountId` without a token is refused.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
      }).success,
    ).toBe(true);
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        nonInteractiveToken: TOKEN_FIXTURE,
      }).success,
    ).toBe(true);

    // The selector alone is refused: a re-supply with nothing to supply would leave a handler
    // guessing, and the cheap guess is a silent no-op reported as a registration.
    const selectorAlone = ProviderAccountRegisterRequestSchema.safeParse({
      provider: "claude",
      displayLabel: "Personal",
      billingMode: "subscription",
      accountId: ACCOUNT_ID,
    });
    expect(selectorAlone.success).toBe(false);
    if (selectorAlone.success) {
      throw new Error("unreachable — the selector-alone request must not parse");
    }
    // The issue points at the member the caller must add, not at the id.
    expect(selectorAlone.error.issues.map((issue) => issue.path.join("."))).toContain(
      "nonInteractiveToken",
    );
    expect(
      selectorAlone.error.issues.some((issue) =>
        issue.message.includes("must also carry nonInteractiveToken"),
      ),
    ).toBe(true);
  });

  it("names a keychain refusal's cause from the closed pair", () => {
    expect(
      ProviderAccountCredentialSealRefusedDetailsSchema.safeParse({ cause: "locked" }).success,
    ).toBe(true);
    expect(
      ProviderAccountCredentialSealRefusedDetailsSchema.safeParse({ cause: "unavailable" }).success,
    ).toBe(true);
    expect(
      ProviderAccountCredentialSealRefusedDetailsSchema.safeParse({ cause: "missing" }).success,
    ).toBe(false);
  });
});
