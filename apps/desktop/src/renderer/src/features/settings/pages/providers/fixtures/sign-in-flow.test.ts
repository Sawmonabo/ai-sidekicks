// What the three account-plane calls answer with, and what they never answer with.

import { describe, expect, it } from "vitest";

import type { ProviderAccountId, ProviderAccountRegisterResponse } from "@ai-sidekicks/contracts";

import type { Refusal } from "@renderer/lib/refusal.js";

import {
  accountPlaneCalls,
  PROVIDER_SIGN_IN_ATTEMPT,
} from "./account-plane-bridge.test-support.js";
import {
  cancelSignIn,
  readRegistrationFields,
  startProviderSignIn,
  submitTokenRegistration,
  TOKEN_REGISTRATION_REFUSAL_ORIGIN,
  type RegistrationFieldReading,
  type SignInFlowState,
} from "./sign-in-flow.js";

const ACCOUNT_ID = "pa-0001" as ProviderAccountId;

const REGISTERED: ProviderAccountRegisterResponse = {
  account: {
    accountId: "pa-0003" as ProviderAccountId,
    provider: "codex",
    displayLabel: "Metered",
    credentialGeneration: 1,
    billingMode: "metered",
    isDefault: false,
    healthState: "indeterminate",
    healthObservedAt: null,
    observedAuthMode: null,
    loggedInAt: null,
    expectedReloginAtEstimate: null,
    probeEnabled: true,
    lastRefreshObservedAt: null,
    windowStartEnabled: true,
    wakeForWindowStartEnabled: false,
    memoryImport: null,
  },
};

/** The sentence one settled flow state carries, or the empty string where it has none. */
function endedBecause(state: SignInFlowState): string {
  return state.kind === "ended" ? state.because : "";
}

describe("startSignIn", () => {
  it("answers a live flow carrying the attempt and the account it is for", async () => {
    const state = await startProviderSignIn(
      accountPlaneCalls({ login: PROVIDER_SIGN_IN_ATTEMPT }).login,
      ACCOUNT_ID,
    );
    // The account rides the outcome so the one-at-a-time rule can say which account is
    // running when it disables the other rows.
    expect(state).toEqual({
      kind: "live",
      accountId: ACCOUNT_ID,
      attempt: PROVIDER_SIGN_IN_ATTEMPT,
    });
  });
});

describe("cancelSignIn", () => {
  it("says the sign-in was canceled when the daemon canceled one", async () => {
    const state = await cancelSignIn(
      accountPlaneCalls({ cancel: { status: "canceled" } }).cancelLogin,
      PROVIDER_SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).toContain("was canceled");
  });

  it("says there was nothing to cancel when the daemon found none", async () => {
    const state = await cancelSignIn(
      accountPlaneCalls({ cancel: { status: "notFound" } }).cancelLogin,
      PROVIDER_SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).toContain("no sign-in left to cancel");
  });

  // Guards the two statuses staying apart: a `notFound` reported as a cancellation would
  // claim the console stopped something it did not.
  it("does not report a notFound as a cancellation", async () => {
    const state = await cancelSignIn(
      accountPlaneCalls({ cancel: { status: "notFound" } }).cancelLogin,
      PROVIDER_SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).not.toContain("was canceled");
  });

  it("never claims the account is authenticated", async () => {
    const state = await cancelSignIn(
      accountPlaneCalls({ cancel: { status: "canceled" } }).cancelLogin,
      PROVIDER_SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).not.toMatch(/authenticated/iu);
  });
});

describe("submitTokenRegistration", () => {
  const REQUEST = {
    provider: "codex",
    displayLabel: "Metered",
    billingMode: "metered",
    nonInteractiveToken: "a-vendor-minted-token",
  } as const;

  it("answers with the account the daemon created", async () => {
    const outcome = await submitTokenRegistration(
      accountPlaneCalls({ register: REGISTERED }).register,
      REQUEST,
    );
    expect(outcome).toEqual({ kind: "registered", account: REGISTERED.account });
  });

  // The reply has no token member, so nothing can echo one; asserted over the serialized
  // outcome because that is what a devtools inspection would read.
  it("carries no token anywhere in the outcome it answers with", async () => {
    const outcome = await submitTokenRegistration(
      accountPlaneCalls({ register: REGISTERED }).register,
      REQUEST,
    );
    expect(JSON.stringify(outcome)).not.toContain("a-vendor-minted-token");
  });
});

describe("readRegistrationFields", () => {
  /** The three ordinary fields, as the form hands them over. */
  function typed(displayLabel: string): Parameters<typeof readRegistrationFields>[0] {
    return { displayLabel, provider: "codex", billingMode: "metered" };
  }

  /** The refusal one reading carries, or `undefined` where it admitted the fields. */
  function refusalOf(reading: RegistrationFieldReading): Refusal | undefined {
    return reading.kind === "refused" ? reading.refusal : undefined;
  }

  it("admits a label with the surrounding whitespace trimmed off it", () => {
    expect(readRegistrationFields(typed("  Metered  "))).toStrictEqual<RegistrationFieldReading>({
      kind: "admitted",
      fields: { provider: "codex", displayLabel: "Metered", billingMode: "metered" },
    });
  });

  it("refuses a label of nothing but whitespace, which the browser's own check accepts", () => {
    // `required` accepts any non-empty value, so this blank passes the markup and the
    // reading has to catch it.
    const refusal = refusalOf(readRegistrationFields(typed("   ")));
    expect(refusal?.code).toBe("registration-label-blank");
    expect(refusal?.origin).toBe(TOKEN_REGISTRATION_REFUSAL_ORIGIN);
    expect(refusal?.detail ?? "").toContain("label");
  });

  it("refuses a value neither closed vocabulary publishes, naming which one", () => {
    expect(
      refusalOf(readRegistrationFields({ ...typed("Metered"), provider: "not-a-provider" }))?.code,
    ).toBe("registration-provider-unadmitted");
    expect(
      refusalOf(readRegistrationFields({ ...typed("Metered"), billingMode: "not-a-mode" }))?.code,
    ).toBe("registration-billing-mode-unadmitted");
  });

  it("echoes no refused value back into the sentence a person reads", () => {
    // A label is user content; `detail` says what would change the answer.
    const refusal = refusalOf(readRegistrationFields(typed(" \t ")));
    expect(JSON.stringify(refusal)).not.toContain("\\t");
  });

  it("negative control: an ordinary label is admitted, so the refusals are the reading's", () => {
    // Without this the cases above would pass over a reader that refused everything.
    expect(readRegistrationFields(typed("A machine account")).kind).toBe("admitted");
  });
});
