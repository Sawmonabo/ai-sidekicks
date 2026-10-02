// `providerAccount.register`: the request's `accountId` is only the token re-supply selector,
// never an identity assertion, so it is refused without a token to supply; and a keychain that
// refuses to seal the token names its cause.
import { describe, expect, it } from "vitest";

import {
  ProviderAccountCredentialSealRefusedDetailsSchema,
  ProviderAccountLoginResponseSchema,
  ProviderAccountRegisterRequestSchema,
} from "../provider-account-sign-in.js";

const ACCOUNT_ID = "acct_01J8XYZ";
/** The one credential value this plane accepts. */
const TOKEN_FIXTURE = "sk-example-token";

describe("the register request's re-supply selector", () => {
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
});

describe("the keychain refusal", () => {
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

describe("the sign-in page address the person opens", () => {
  it("accepts an https address and refuses any other scheme", () => {
    const reply = (verificationUri: string) => ({ attemptId: "attempt-1", verificationUri });
    const parse = (address: string) =>
      ProviderAccountLoginResponseSchema.safeParse(reply(address)).success;
    expect(parse("https://provider.example.test/device")).toBe(true);
    expect(parse("javascript:alert(1)")).toBe(false);
    expect(parse("file:///etc/passwd")).toBe(false);
    expect(parse("http://provider.example.test/device")).toBe(false);
  });
});
