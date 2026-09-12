// What the three account-plane calls answer with, and what they never answer with.
//
// EVERY CASE DRIVES THE REAL FUNCTIONS through a bridge whose growth port answers.
// The refusal arms take the shipped port's own builder, so a case asserting on a
// refusal is asserting on the code and sentence a release build produces rather than
// on an envelope written here.

import { describe, expect, it } from "vitest";

import type { ProviderAccountId, ProviderAccountRegisterResponse } from "@ai-sidekicks/contracts";

import type { ConsoleRefusal } from "../../../../core/index.js";

import { bridgeAnswering, SIGN_IN_ATTEMPT } from "./account-plane-bridge.test-support.js";
import {
  cancelSignIn,
  readRegistrationFields,
  startSignIn,
  submitTokenRegistration,
  TOKEN_REGISTRATION_REFUSAL_ORIGIN,
  type RegistrationFieldReading,
  type SignInFlowState,
} from "./signin-flow.js";

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
  },
};

/** The sentence one settled flow state carries, or the empty string where it has none. */
function endedBecause(state: SignInFlowState): string {
  return state.kind === "ended" ? state.because : "";
}

describe("startSignIn", () => {
  it("answers a live flow carrying the provider's own attempt and the account it is for", async () => {
    const state = await startSignIn(
      bridgeAnswering({ login: { status: "served", value: SIGN_IN_ATTEMPT } }),
      ACCOUNT_ID,
    );
    // The account rides the outcome because the plane is what disables the OTHER rows,
    // and a flow that recorded only its own progress could say something was running
    // without saying which account was running it.
    expect(state).toEqual({ kind: "live", accountId: ACCOUNT_ID, attempt: SIGN_IN_ATTEMPT });
  });

  it("answers a refusal rather than throwing", async () => {
    const state = await startSignIn(bridgeAnswering({}), ACCOUNT_ID);
    expect(state.kind).toBe("refused");
  });

  // The negative control for the case above: the refusal is a STATE and not a
  // rejection, so a caller that only awaits it never sees an unhandled promise.
  it("never rejects on the refusal arm", async () => {
    await expect(startSignIn(bridgeAnswering({}), ACCOUNT_ID)).resolves.toBeDefined();
  });
});

describe("cancelSignIn", () => {
  it("says the sign-in was cancelled when the daemon cancelled one", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "cancelled" } } }),
      SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).toContain("was cancelled");
  });

  it("says there was nothing to cancel when the daemon found none", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "notFound" } } }),
      SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).toContain("no sign-in left to cancel");
  });

  // The two statuses are kept apart, which is the whole point of the arm: reporting
  // a `notFound` as a cancellation would tell an operator the console stopped
  // something it did not.
  it("does not report a notFound as a cancellation", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "notFound" } } }),
      SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).not.toContain("was cancelled");
  });

  it("never claims the account is authenticated", async () => {
    const state = await cancelSignIn(
      bridgeAnswering({ cancel: { status: "served", value: { status: "cancelled" } } }),
      SIGN_IN_ATTEMPT,
    );
    expect(endedBecause(state)).not.toMatch(/authenticated/iu);
  });
});

describe("submitTokenRegistration", () => {
  it("answers with the account the daemon created", async () => {
    const outcome = await submitTokenRegistration(
      bridgeAnswering({ register: { status: "served", value: REGISTERED } }),
      {
        provider: "codex",
        displayLabel: "Metered",
        billingMode: "metered",
        nonInteractiveToken: "a-vendor-minted-token",
      },
    );
    expect(outcome).toEqual({ kind: "registered", account: REGISTERED.account });
  });

  // The reply carries no token member at all, so there is nothing for the settled arm
  // to echo even if a surface tried. Asserted over the whole serialized outcome
  // because that is the shape a devtools inspection would read.
  it("carries no token anywhere in the outcome it answers with", async () => {
    const outcome = await submitTokenRegistration(
      bridgeAnswering({ register: { status: "served", value: REGISTERED } }),
      {
        provider: "codex",
        displayLabel: "Metered",
        billingMode: "metered",
        nonInteractiveToken: "a-vendor-minted-token",
      },
    );
    expect(JSON.stringify(outcome)).not.toContain("a-vendor-minted-token");
  });

  it("answers a refusal rather than throwing", async () => {
    const outcome = await submitTokenRegistration(bridgeAnswering({}), {
      provider: "codex",
      displayLabel: "Metered",
      billingMode: "metered",
    });
    expect(outcome.kind).toBe("refused");
  });
});

describe("readRegistrationFields", () => {
  /** The three ordinary fields, as the form hands them over. */
  function typed(displayLabel: string): Parameters<typeof readRegistrationFields>[0] {
    return { displayLabel, provider: "codex", billingMode: "metered" };
  }

  /** The refusal one reading carries, or `undefined` where it admitted the fields. */
  function refusalOf(reading: RegistrationFieldReading): ConsoleRefusal | undefined {
    return reading.kind === "refused" ? reading.refusal : undefined;
  }

  it("admits a label with the surrounding whitespace trimmed off it", () => {
    expect(readRegistrationFields(typed("  Metered  "))).toStrictEqual<RegistrationFieldReading>({
      kind: "admitted",
      fields: { provider: "codex", displayLabel: "Metered", billingMode: "metered" },
    });
  });

  it("refuses a label of nothing but whitespace, which the browser's own check accepts", () => {
    // `required` is satisfied by any non-empty value, so this is the one blank the
    // engine lets through — and the reading, not the markup, is what has to catch it.
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
    // A label is user content. `detail` says what would change the answer.
    const refusal = refusalOf(readRegistrationFields(typed(" \t ")));
    expect(JSON.stringify(refusal)).not.toContain("\\t");
  });

  it("negative control: an ordinary label is admitted, so the refusals are the reading's", () => {
    // Without this the cases above would pass over a reader that refused everything.
    expect(readRegistrationFields(typed("A machine account")).kind).toBe("admitted");
  });
});
