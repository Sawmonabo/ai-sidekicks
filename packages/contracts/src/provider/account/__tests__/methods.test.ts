// `providerAccount.*` update, remove, set-current, probe and usage: neither set-current nor
// remove admits a partial success, the register request refuses a caller-asserted credential
// generation, and usage is answered in whole micro-dollars.
import { describe, expect, it } from "vitest";

import {
  ProviderAccountProbeRequestSchema,
  ProviderAccountProbeResponseSchema,
  ProviderAccountRemoveRequestSchema,
  ProviderAccountRemoveResponseSchema,
  ProviderAccountSetCurrentRequestSchema,
  ProviderAccountSetCurrentResponseSchema,
  ProviderAccountUpdateRequestSchema,
  ProviderAccountUpdateResponseSchema,
  ProviderAccountUsageReadResponseSchema,
} from "../methods.js";
import { ProviderAccountRegisterRequestSchema } from "../sign-in.js";
import { ACCOUNT_ID, validProviderAccount } from "./record.test-support.js";

const SESSION_ID = "0192f3a1-4b5c-7d8e-9f01-23456789abcd";
const SESSION_ID_2 = "0192f3a1-4b5c-7d8e-9f01-23456789abce";

describe("request/response pairs", () => {
  it("refuses a set-current success reply whose account is not the default", () => {
    expect(
      ProviderAccountUpdateRequestSchema.safeParse({ accountId: ACCOUNT_ID, probeEnabled: false })
        .success,
    ).toBe(true);
    expect(
      ProviderAccountUpdateResponseSchema.safeParse({ account: validProviderAccount() }).success,
    ).toBe(true);

    expect(ProviderAccountRemoveRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: true })
        .success,
    ).toBe(true);

    expect(
      ProviderAccountSetCurrentRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success,
    ).toBe(true);
    expect(
      ProviderAccountSetCurrentResponseSchema.safeParse({
        account: validProviderAccount(),
        movingSessions: [{ sessionId: SESSION_ID }, { sessionId: SESSION_ID_2 }],
      }).success,
    ).toBe(true);
    // The verb has no partial success: `isDefault: false` on a success reply would be a refusal
    // in a success envelope, and every real refusal here is a typed error. It is a refinement,
    // not a narrower type, because the account projection is shared.
    expect(
      ProviderAccountSetCurrentResponseSchema.safeParse({
        account: validProviderAccount({ isDefault: false }),
        movingSessions: [],
      }).success,
    ).toBe(false);
    // The shared projection stays wide: other replies still admit a non-default account.
    expect(
      ProviderAccountUpdateResponseSchema.safeParse({
        account: validProviderAccount({ isDefault: false }),
      }).success,
    ).toBe(true);

    expect(ProviderAccountProbeRequestSchema.safeParse({ accountId: ACCOUNT_ID }).success).toBe(
      true,
    );
    expect(
      ProviderAccountProbeResponseSchema.safeParse({
        accountId: ACCOUNT_ID,
        healthState: "indeterminate",
        credentialGeneration: 1,
      }).success,
    ).toBe(true);
  });

  it("refuses a caller-asserted credential generation on the register request", () => {
    // `credentialGeneration` is daemon-owned: a caller that could assert one could pass off a
    // stale quota reading or superseded attention epoch as current.
    expect(
      ProviderAccountRegisterRequestSchema.safeParse({
        provider: "claude",
        displayLabel: "Personal",
        billingMode: "subscription",
        credentialGeneration: 7,
      }).success,
    ).toBe(false);
  });

  it("refuses a partial success on the remove response", () => {
    // `removed: false` would be a refusal in a success envelope; refusals here are typed errors.
    expect(
      ProviderAccountRemoveResponseSchema.safeParse({ accountId: ACCOUNT_ID, removed: false })
        .success,
    ).toBe(false);
  });
});

describe("the usage read", () => {
  it("answers usage in whole micro-dollars, refusing a fraction of one", () => {
    const row = { model: "claude-opus-4-1", tokens: 1200, costUsdMicros: 18_450 };
    expect(ProviderAccountUsageReadResponseSchema.safeParse({ rows: [row] }).success).toBe(true);
    expect(
      ProviderAccountUsageReadResponseSchema.safeParse({ rows: [{ ...row, costUsdMicros: 0.5 }] })
        .success,
    ).toBe(false);
  });
});
