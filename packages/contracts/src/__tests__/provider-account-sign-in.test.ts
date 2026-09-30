// `providerAccount.*` sign-in coverage: the register, credential-home reset,
// login and login-cancel pairs, the re-supply selector on the register
// request, and the keychain refusal's cause.
//
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
/**
 * The one credential value this plane accepts, named once so the error-envelope
 * census below can scan for it BY VALUE and not only by member name.
 */
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
    expectedReloginAtEstimate: null,
    probeEnabled: true,
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
    // The authorization-URL arm carries no code: the shape mirrors the
    // provider's own, and one pinned leg emits a URL alone.
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
    // `notFound` is an outcome, not an error, so there is no third arm standing
    // in for "the attempt failed".
    expect(ProviderAccountLoginCancelResponseSchema.safeParse({ status: "failed" }).success).toBe(
      false,
    );
  });

  it("admits `accountId` on the register request only as the re-supply selector", () => {
    // A SELECTOR, not an identity assertion: supplied, it means "replace the
    // sealed token on THIS account", and a supplied id naming no registered
    // account is refused by the daemon rather than created. The alternative —
    // deregister and re-register — would daemon-mint a NEW immutable identity
    // and discard the spend, quota, and attention history keyed to the account
    // the operator is trying to repair.
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

    // NEITHER member is required on its own: an ordinary registration carries
    // no token, and a token with no `accountId` is the ordinary token-mode
    // registration of a NEW account. Only the combination is constrained, so
    // both of these stay admissible.
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

    // ...but the selector alone is REFUSED. A re-supply with nothing to supply
    // is neither a registration nor a replacement, and admitting it would leave
    // the intent to be guessed by a handler — the cheap guess being a silent
    // no-op reported as a successful registration.
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
    // Refused against the member the caller must ADD, not against the id, which
    // is not the mistake.
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
